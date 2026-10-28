"""medtools: small, free, self-hosted helper service for the medical agent.

Endpoints (all JSON, all internal to the docker network / loopback):
  POST /v1/embeddings          OpenAI-compatible embeddings (multilingual-e5-base, int8 ONNX)
  POST /v1/rerank              Jina-compatible reranker (mmarco mMiniLMv2 cross-encoder, int8 ONNX)
  POST /v1/scrape, /v2/scrape  Firecrawl-compatible page scraper (httpx + trafilatura, PDF text,
                               Jina Reader keyless fallback), SSRF-guarded, cached
  POST /v1/files, GET /v1/files/{id}/url, GET /v1/files/{id}/content, DELETE /v1/files/{id},
  POST /v1/ocr                 Mistral-OCR-compatible API backed by Tesseract (ben+eng) + poppler
  GET  /health
"""
from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import tempfile
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
import numpy as np
import onnxruntime as ort
import trafilatura
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps
from tokenizers import Tokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("medtools")

MODELS = Path(os.environ.get("MEDTOOLS_MODELS", "/models"))
API_KEY = os.environ.get("MEDTOOLS_API_KEY", "")
PUBLIC_BASE = os.environ.get("MEDTOOLS_PUBLIC_BASE", "http://medtools:8000").rstrip("/")
ORT_THREADS = int(os.environ.get("MEDTOOLS_ORT_THREADS", "4"))
INFER_CONCURRENCY = int(os.environ.get("MEDTOOLS_INFER_CONCURRENCY", "2"))
OCR_CONCURRENCY = int(os.environ.get("MEDTOOLS_OCR_CONCURRENCY", "2"))
OCR_MAX_PAGES = int(os.environ.get("MEDTOOLS_OCR_MAX_PAGES", "30"))
OCR_LANGS = os.environ.get("MEDTOOLS_OCR_LANGS", "ben+eng")
SCRAPE_MAX_BYTES = int(os.environ.get("MEDTOOLS_SCRAPE_MAX_BYTES", str(6 * 1024 * 1024)))
SCRAPE_CACHE_TTL = int(os.environ.get("MEDTOOLS_SCRAPE_CACHE_TTL", str(6 * 3600)))
SCRAPE_CACHE_SIZE = int(os.environ.get("MEDTOOLS_SCRAPE_CACHE_SIZE", "1000"))
JINA_READER = os.environ.get("MEDTOOLS_JINA_READER", "https://r.jina.ai/")
JINA_READER_KEY = os.environ.get("MEDTOOLS_JINA_READER_KEY", "")
FILES_DIR = Path(os.environ.get("MEDTOOLS_FILES_DIR", "/tmp/medtools-files"))
FILES_TTL = int(os.environ.get("MEDTOOLS_FILES_TTL", "3600"))
MAX_UPLOAD = int(os.environ.get("MEDTOOLS_MAX_UPLOAD", str(25 * 1024 * 1024)))
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)

FILES_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="medtools", docs_url=None, redoc_url=None)
infer_sem = asyncio.Semaphore(INFER_CONCURRENCY)
ocr_sem = asyncio.Semaphore(OCR_CONCURRENCY)


def auth(authorization: str | None = Header(default=None)) -> None:
    if not API_KEY:
        return
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token != API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------- ONNX models
def _session(path: Path) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.intra_op_num_threads = ORT_THREADS
    so.inter_op_num_threads = 1
    so.enable_cpu_mem_arena = False
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


class Encoder:
    def __init__(self, folder: Path, onnx_name: str, max_len: int, pair: bool):
        self.sess = _session(folder / onnx_name)
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self.tok = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tok.enable_truncation(max_length=max_len, strategy="only_second" if pair else "longest_first")
        self.tok.no_padding()
        self.pad_id = self.tok.token_to_id("<pad>") or 1

    def _feed(self, encs) -> dict[str, np.ndarray]:
        n = max(len(e.ids) for e in encs)
        ids = np.full((len(encs), n), self.pad_id, dtype=np.int64)
        mask = np.zeros((len(encs), n), dtype=np.int64)
        for i, e in enumerate(encs):
            ids[i, : len(e.ids)] = e.ids
            mask[i, : len(e.ids)] = 1
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        return feed


class Embedder(Encoder):
    def embed(self, texts: list[str]) -> tuple[np.ndarray, int]:
        encs = self.tok.encode_batch(texts)
        order = sorted(range(len(encs)), key=lambda i: len(encs[i].ids))
        out = np.zeros((len(texts), 0), dtype=np.float32)
        vecs: dict[int, np.ndarray] = {}
        tokens = sum(len(e.ids) for e in encs)
        for s in range(0, len(order), 16):
            idx = order[s : s + 16]
            feed = self._feed([encs[i] for i in idx])
            hidden = self.sess.run(None, feed)[0]  # [b, n, d]
            m = feed["attention_mask"][..., None].astype(np.float32)
            pooled = (hidden * m).sum(1) / np.clip(m.sum(1), 1e-9, None)
            pooled /= np.linalg.norm(pooled, axis=1, keepdims=True) + 1e-12
            for j, i in enumerate(idx):
                vecs[i] = pooled[j].astype(np.float32)
        out = np.stack([vecs[i] for i in range(len(texts))])
        return out, tokens


class Reranker(Encoder):
    def score(self, query: str, docs: list[str]) -> list[float]:
        encs = self.tok.encode_batch([(query, d) for d in docs])
        scores = [0.0] * len(docs)
        order = sorted(range(len(encs)), key=lambda i: len(encs[i].ids))
        for s in range(0, len(order), 32):
            idx = order[s : s + 32]
            logits = self.sess.run(None, self._feed([encs[i] for i in idx]))[0].reshape(-1)
            for j, i in enumerate(idx):
                scores[i] = float(1.0 / (1.0 + np.exp(-logits[j])))
        return scores


EMBED_MODEL_NAME = "multilingual-e5-base"
embedder = Embedder(MODELS / "e5", "model_quantized.onnx", 512, pair=False)
reranker = Reranker(MODELS / "rerank", "model_quint8_avx2.onnx", 512, pair=True)
log.info("models loaded")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "embed": EMBED_MODEL_NAME, "rerank": "mmarco-mMiniLMv2-L12-H384-v1", "ocr": OCR_LANGS}


@app.post("/v1/embeddings", dependencies=[Depends(auth)])
async def embeddings(body: dict[str, Any]) -> dict[str, Any]:
    inp = body.get("input")
    if isinstance(inp, str):
        inp = [inp]
    if not isinstance(inp, list) or not inp or not all(isinstance(t, str) for t in inp):
        raise HTTPException(400, "input must be a string or a list of strings")
    if len(inp) > 2048:
        raise HTTPException(400, "too many inputs")
    # e5 needs a prefix. A single short text is a search query; anything else is a passage.
    is_query = len(inp) == 1 and len(inp[0]) <= 300
    prefix = "query: " if is_query else "passage: "
    texts = [prefix + (t.strip() or " ") for t in inp]
    async with infer_sem:
        vecs, tokens = await asyncio.to_thread(embedder.embed, texts)
    b64 = body.get("encoding_format") == "base64"
    data = []
    for i, v in enumerate(vecs):
        emb: Any = base64.b64encode(v.astype("<f4").tobytes()).decode() if b64 else v.tolist()
        data.append({"object": "embedding", "index": i, "embedding": emb})
    return {"object": "list", "data": data, "model": EMBED_MODEL_NAME,
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}


@app.post("/v1/rerank", dependencies=[Depends(auth)])
async def rerank(body: dict[str, Any]) -> dict[str, Any]:
    query = body.get("query") or ""
    docs = body.get("documents") or body.get("texts") or []
    docs = [d if isinstance(d, str) else (d.get("text") or "") for d in docs]
    if not query or not docs:
        return {"model": "mmarco-mMiniLMv2", "results": [], "usage": {"total_tokens": 0}}
    docs = docs[:500]
    async with infer_sem:
        scores = await asyncio.to_thread(reranker.score, query, docs)
    top_n = int(body.get("top_n") or len(docs))
    ranked = sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)[:top_n]
    ret_docs = body.get("return_documents", True)
    results = []
    for i in ranked:
        r: dict[str, Any] = {"index": i, "relevance_score": scores[i]}
        if ret_docs:
            r["document"] = {"text": docs[i]}
        results.append(r)
    return {"model": "mmarco-mMiniLMv2-L12-H384-v1", "results": results, "usage": {"total_tokens": 0}}


# ---------------------------------------------------------------- scraper
class TTLCache:
    def __init__(self, size: int, ttl: int):
        self.size, self.ttl, self.d = size, ttl, OrderedDict()

    def get(self, k):
        v = self.d.get(k)
        if not v or v[0] < time.time():
            self.d.pop(k, None)
            return None
        self.d.move_to_end(k)
        return v[1]

    def set(self, k, val):
        self.d[k] = (time.time() + self.ttl, val)
        self.d.move_to_end(k)
        while len(self.d) > self.size:
            self.d.popitem(last=False)


scrape_cache = TTLCache(SCRAPE_CACHE_SIZE, SCRAPE_CACHE_TTL)


async def _assert_public(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(400, "only public http(s) URLs")
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except socket.gaierror:
        raise HTTPException(400, "host not found")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise HTTPException(400, "blocked non-public address")


async def _fetch(url: str, timeout: float) -> tuple[str, bytes, str, int]:
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
               "Accept-Language": "en,bn;q=0.8"}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers) as client:
        cur = url
        for _ in range(6):
            await _assert_public(cur)
            async with client.stream("GET", cur) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    cur = urljoin(cur, r.headers["location"])
                    continue
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > SCRAPE_MAX_BYTES:
                        break
                return cur, bytes(buf), r.headers.get("content-type", ""), r.status_code
    raise HTTPException(400, "too many redirects")


def _pdf_text(data: bytes, max_pages: int = 40) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        r = subprocess.run(["pdftotext", "-l", str(max_pages), "-layout", f.name, "-"],
                           capture_output=True, timeout=60)
        return r.stdout.decode("utf-8", "ignore")


def _html_to_md(html: str, url: str) -> tuple[str, str]:
    md = trafilatura.extract(html, url=url, output_format="markdown", include_tables=True,
                             include_links=False, include_images=False, favor_recall=True) or ""
    title = ""
    try:
        meta = trafilatura.extract_metadata(html, default_url=url)
        title = (meta.title if meta else "") or ""
    except Exception:
        pass
    return md, title


async def _jina_reader(url: str, timeout: float) -> tuple[str, str]:
    headers = {"User-Agent": UA, "X-Return-Format": "markdown"}
    if JINA_READER_KEY:
        headers["Authorization"] = f"Bearer {JINA_READER_KEY}"
    async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
        r = await client.get(JINA_READER + url)
        if r.status_code != 200:
            return "", ""
        text = r.text
        m = re.search(r"^Title:\s*(.+)$", text, re.M)
        body = text.split("Markdown Content:", 1)[-1].strip()
        return body, (m.group(1).strip() if m else "")


async def _scrape(url: str, timeout_ms: int) -> dict[str, Any]:
    cached = scrape_cache.get(url)
    if cached:
        return cached
    timeout = max(3.0, min(timeout_ms / 1000.0, 30.0))
    md, title, status, final = "", "", 0, url
    try:
        final, data, ctype, status = await _fetch(url, timeout * 0.7)
        if status < 400:
            if "pdf" in ctype or data[:5] == b"%PDF-":
                md = await asyncio.to_thread(_pdf_text, data)
            elif "html" in ctype or "xml" in ctype or data.lstrip()[:1] == b"<":
                html = data.decode("utf-8", "ignore")
                md, title = await asyncio.to_thread(_html_to_md, html, final)
            elif ctype.startswith("text/") or "json" in ctype:
                md = data.decode("utf-8", "ignore")
    except HTTPException:
        raise
    except Exception as e:  # network errors fall through to the reader fallback
        log.info("fetch failed %s: %s", url, e)
    if len(md.strip()) < 300 and JINA_READER:
        try:
            md2, t2 = await _jina_reader(url, timeout * 0.6)
            if len(md2.strip()) > len(md.strip()):
                md, title, status = md2, title or t2, status or 200
        except Exception as e:
            log.info("reader fallback failed %s: %s", url, e)
    if not md.strip():
        return {"success": False, "error": f"no readable content (status {status})"}
    md = md[:200_000]
    res = {"success": True, "data": {"markdown": md, "metadata": {
        "title": title, "sourceURL": url, "url": final, "statusCode": status or 200}}}
    scrape_cache.set(url, res)
    return res


@app.post("/v1/scrape", dependencies=[Depends(auth)])
@app.post("/v2/scrape", dependencies=[Depends(auth)])
async def scrape(body: dict[str, Any]) -> JSONResponse:
    url = body.get("url") or ""
    try:
        res = await _scrape(url, int(body.get("timeout") or 15000))
    except HTTPException as e:
        res = {"success": False, "error": e.detail}
    return JSONResponse(res, status_code=200 if res.get("success") else 422)


# ---------------------------------------------------------------- OCR (Mistral-compatible)
def _cleanup_files() -> None:
    now = time.time()
    for p in FILES_DIR.glob("*"):
        try:
            if now - p.stat().st_mtime > FILES_TTL:
                p.unlink()
        except FileNotFoundError:
            pass


@app.post("/v1/files", dependencies=[Depends(auth)])
async def upload_file(file: UploadFile = File(...), purpose: str = Form("ocr")) -> dict[str, Any]:
    _cleanup_files()
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "file too large")
    fid = str(uuid.uuid4())
    (FILES_DIR / fid).write_bytes(data)
    (FILES_DIR / f"{fid}.json").write_text(json.dumps({"filename": file.filename, "purpose": purpose}))
    return {"id": fid, "object": "file", "bytes": len(data), "created_at": int(time.time()),
            "filename": file.filename, "purpose": purpose, "sample_type": "ocr_input", "source": "upload"}


@app.get("/v1/files/{fid}/url", dependencies=[Depends(auth)])
async def file_url(fid: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f-]{36}", fid) or not (FILES_DIR / fid).exists():
        raise HTTPException(404, "not found")
    return {"url": f"{PUBLIC_BASE}/v1/files/{fid}/content"}


@app.get("/v1/files/{fid}/content", dependencies=[Depends(auth)])
async def file_content(fid: str) -> Response:
    p = FILES_DIR / fid
    if not re.fullmatch(r"[0-9a-f-]{36}", fid) or not p.exists():
        raise HTTPException(404, "not found")
    return Response(p.read_bytes(), media_type="application/octet-stream")


@app.delete("/v1/files/{fid}", dependencies=[Depends(auth)])
async def delete_file(fid: str) -> dict[str, Any]:
    if re.fullmatch(r"[0-9a-f-]{36}", fid):
        for p in (FILES_DIR / fid, FILES_DIR / f"{fid}.json"):
            p.unlink(missing_ok=True)
    return {"id": fid, "object": "file", "deleted": True}


def _tesseract(img: Image.Image) -> str:
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("L", "RGB"):
        img = img.convert("RGB")
    img = img.convert("L")
    w, h = img.size
    long_side = max(w, h)
    if long_side < 1800:
        s = 1800 / long_side
        img = img.resize((int(w * s), int(h * s)), Image.LANCZOS)
    elif long_side > 5000:
        s = 5000 / long_side
        img = img.resize((int(w * s), int(h * s)), Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=1)
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        img.save(f.name)
        r = subprocess.run(["tesseract", f.name, "stdout", "-l", OCR_LANGS, "--oem", "1", "--psm", "3",
                            "--tessdata-dir", str(MODELS / "tessdata")],
                           capture_output=True, timeout=180, env={**os.environ, "OMP_THREAD_LIMIT": "2"})
    text = r.stdout.decode("utf-8", "ignore")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _ocr_pdf(data: bytes) -> list[str]:
    pages: list[str] = []
    with tempfile.TemporaryDirectory() as d:
        pdf = Path(d) / "in.pdf"
        pdf.write_bytes(data)
        info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, timeout=30).stdout.decode("utf-8", "ignore")
        m = re.search(r"^Pages:\s+(\d+)", info, re.M)
        n = min(int(m.group(1)) if m else 1, OCR_MAX_PAGES)
        for i in range(1, n + 1):
            t = subprocess.run(["pdftotext", "-f", str(i), "-l", str(i), "-layout", str(pdf), "-"],
                               capture_output=True, timeout=60).stdout.decode("utf-8", "ignore").strip()
            if len(re.sub(r"\s", "", t)) < 40:  # scanned page: rasterise and OCR it
                subprocess.run(["pdftoppm", "-f", str(i), "-l", str(i), "-r", "300", "-gray", "-png",
                                str(pdf), str(Path(d) / "p")], capture_output=True, timeout=120)
                imgs = sorted(Path(d).glob("p*.png"))
                if imgs:
                    with Image.open(imgs[-1]) as im:
                        t = _tesseract(im)
                    for p in imgs:
                        p.unlink()
            pages.append(t)
    return pages


def _ocr_bytes(data: bytes) -> list[str]:
    if data[:5] == b"%PDF-":
        return _ocr_pdf(data)
    with Image.open(io.BytesIO(data)) as im:
        frames = []
        for k in range(min(getattr(im, "n_frames", 1), OCR_MAX_PAGES)):
            im.seek(k)
            frames.append(_tesseract(im.copy()))
        return frames


@app.post("/v1/ocr", dependencies=[Depends(auth)])
async def ocr(body: dict[str, Any]) -> dict[str, Any]:
    doc = body.get("document") or {}
    url = doc.get("document_url") or doc.get("image_url") or ""
    if isinstance(url, dict):
        url = url.get("url", "")
    data: bytes | None = None
    m = re.search(r"/v1/files/([0-9a-f-]{36})/content$", url)
    if m and (FILES_DIR / m.group(1)).exists():
        data = (FILES_DIR / m.group(1)).read_bytes()
    elif url.startswith("data:"):
        try:
            data = base64.b64decode(url.split(",", 1)[1])
        except Exception:
            raise HTTPException(400, "bad data url")
    if not data:
        raise HTTPException(400, "document must be an uploaded file or a data: URL")
    t0 = time.time()
    async with ocr_sem:
        try:
            pages = await asyncio.to_thread(_ocr_bytes, data)
        except Exception as e:
            log.exception("ocr failed")
            raise HTTPException(422, f"could not read document: {e}")
    log.info("ocr %d page(s) in %.1fs", len(pages), time.time() - t0)
    return {"pages": [{"index": i, "markdown": t, "images": [], "dimensions": None} for i, t in enumerate(pages)],
            "model": "tesseract-" + OCR_LANGS, "document_annotation": None,
            "usage_info": {"pages_processed": len(pages), "doc_size_bytes": len(data)}}
