#!/usr/bin/env python3
"""Build the local disease knowledge base used by the `disease_knowledge_search` tool.

Input : the "Global Disease Master Chart" workbook (sheet "Master Disease Chart",
        23 columns, one row per disease). The raw workbook is NOT committed to the
        repository (no licence is stated); keep it outside git, e.g. ~/datasets/.
Output: packages/mcp-medical/data/disease-kb/disease-kb.json.gz (git-ignored)
        records + int8-quantised multilingual-e5-base passage vectors.

The embeddings come from the self-hosted medtools service (POST /v1/embeddings,
multilingual-e5-base int8 ONNX). Nothing leaves the machine.

Usage (from the repo root):
  python3 packages/mcp-medical/scripts/build_disease_kb.py \
      --xlsx "$HOME/datasets/Disease_Name_Data/Global_Disease_Master_Chart-7 (2).xlsx" \
      [--medtools http://127.0.0.1:4134] [--batch 16] [--no-embed]

The medtools API key is read from MEDTOOLS_API_KEY or from the repo's .env.
Cleaning applied (see packages/mcp-medical/docs/DISEASE_KB.md):
  * "X (already covered - replaced with: Y)" placeholder names -> Y
  * duplicate diseases (same normalised name) collapsed to the most complete row;
    the other IDs are kept in `dup_ids`
  * rows whose last columns are shifted by one are realigned
  * explicit numeric doses ("25 mg", "10 mg/kg") are replaced by "[dose omitted]"
  * a free-memory guard stops embedding if the VM runs low on RAM
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

try:
    import openpyxl  # type: ignore
except ImportError:  # pragma: no cover
    sys.exit("openpyxl is required: pip install --user openpyxl")

try:
    import numpy as np  # type: ignore
except ImportError:  # pragma: no cover
    np = None

REPO = Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "packages" / "mcp-medical" / "data" / "disease-kb"
SHEET = "Master Disease Chart"
DATASET_NAME = "Global Disease Master Chart"

COLS = [
    "Unique Disease ID", "Standard Disease Name", "Alternative or Common Names",
    "Main Medical Category", "Subcategory", "Short Definition", "Symptom 1",
    "Symptom 2", "Symptom 3", "Symptom 4", "Additional Important Symptoms or Signs",
    "Causes", "Risk Factors", "Transmission Route (if applicable)",
    "Commonly Affected Age Group", "Severity", "Emergency Warning Signs",
    "Diagnostic Methods", "Prevention", "Authoritative Source Name", "Source URL",
    "Verification Status", "Last Reviewed Date",
]

DOSE_RE = re.compile(
    r"\b\d+(?:[.,]\d+)?(?:\s?[-\u2013]\s?\d+(?:[.,]\d+)?)?\s?"
    r"(?:mg/kg(?:/day)?|mcg/kg|\u00b5g/kg|g/kg|mg|mcg|\u00b5g|IU|units?|mL/kg)\b",
    re.I,
)
PII_RE = re.compile(
    r"([\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d-]{9,}\d|\bpatient name\b|\bdate of birth\b|\bMRN\b|\bNID\b)",
    re.I,
)


def s(v) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def clean_name(n: str) -> str:
    hits = re.findall(r"(?:new|replaced with)\s*:\s*([^;)]+?)(?:\s+already covered)?(?=;|\)|$)", n, re.I)
    if hits:
        return hits[-1].strip()
    return re.sub(r"\s*\([^)]*already[^)]*\)", "", n, flags=re.I).strip()


def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", t.lower())


def realign(row: list) -> tuple[list, bool]:
    """A few rows have one extra cell before the source block; fold it back."""
    vals = list(row[:24]) + [None] * max(0, 24 - len(row))
    if vals[23] in (None, ""):
        return vals[:23], False
    is_date = lambda v: bool(re.match(r"^\d{4}-\d{2}-\d{2}", s(v)))  # noqa: E731
    if s(vals[21]).startswith("http") and is_date(vals[23]):
        # Everything after the category block moved right by one: the subcategory
        # was split over two cells (seen in D0946). Merge them back.
        vals = vals[:4] + [" / ".join(x for x in (s(vals[4]), s(vals[5])) if x)] + vals[6:24]
        return vals[:23], True
    if is_date(vals[23]) and not is_date(vals[22]):
        # A stray cell between the status and the date (seen in D0893): drop it.
        vals = vals[:22] + [vals[23]]
        return vals[:23], True
    return vals[:23], False


def scrub_doses(text: str) -> tuple[str, int]:
    out, n = DOSE_RE.subn("[dose omitted]", text)
    return out, n


def load_rows(xlsx: Path) -> tuple[list[dict], dict]:
    wb = openpyxl.load_workbook(xlsx, read_only=True)
    ws = wb[SHEET]
    rows = list(ws.iter_rows(values_only=True))
    header = [s(h) for h in rows[0][:23]]
    if header != COLS:
        sys.exit(f"Unexpected header in {xlsx}: {header}")
    version = ""
    if "Read Me" in wb.sheetnames:
        for r in wb["Read Me"].iter_rows(values_only=True):
            line = " ".join(s(c) for c in r if c)
            m = re.search(r"version[^0-9]*([0-9][0-9.]*)", line, re.I)
            if m and not version:
                version = m.group(1)
    stats = {"rows": 0, "realigned": [], "doses_omitted": 0, "pii_hits": []}
    out = []
    for raw in rows[1:]:
        if not raw or not raw[0]:
            continue
        vals, fixed = realign(list(raw))
        rec = {h: s(v) for h, v in zip(COLS, vals)}
        if fixed:
            stats["realigned"].append(rec["Unique Disease ID"])
        for h in COLS[1:19]:
            rec[h], n = scrub_doses(rec[h])
            stats["doses_omitted"] += n
            m = PII_RE.search(rec[h])
            if m:
                stats["pii_hits"].append((rec["Unique Disease ID"], h, m.group(0)))
        stats["rows"] += 1
        out.append(rec)
    stats["version"] = version
    return out, stats


def completeness(r: dict) -> int:
    return sum(len(r[h]) for h in COLS[2:19])


def build_records(rows: list[dict]) -> tuple[list[dict], dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        r["_name"] = clean_name(r["Standard Disease Name"])
        groups[norm(r["_name"])].append(r)
    recs = []
    dup_rows = 0
    for key, g in groups.items():
        best = max(g, key=lambda r: (completeness(r), -int(r["Unique Disease ID"][1:])))
        others = [r["Unique Disease ID"] for r in g if r is not best]
        dup_rows += len(others)
        alt = [best["Alternative or Common Names"]] + [r["Alternative or Common Names"] for r in g if r is not best]
        alt_names = []
        for a in alt:
            for part in re.split(r"[;,/]", a):
                p = part.strip()
                if p and p.lower() not in (x.lower() for x in alt_names) and p.lower() != best["_name"].lower():
                    alt_names.append(p)
        symptoms = [best[f"Symptom {i}"] for i in range(1, 5) if best[f"Symptom {i}"]]
        url = best["Source URL"]
        recs.append({
            "id": best["Unique Disease ID"],
            "dup_ids": others,
            "name": best["_name"],
            "alt": alt_names[:20],
            "category": best["Main Medical Category"],
            "subcategory": best["Subcategory"],
            "definition": best["Short Definition"],
            "symptoms": symptoms,
            "other_signs": best["Additional Important Symptoms or Signs"],
            "causes": best["Causes"],
            "risk_factors": best["Risk Factors"],
            "transmission": best["Transmission Route (if applicable)"],
            "age_group": best["Commonly Affected Age Group"],
            "severity": best["Severity"],
            "warning_signs": best["Emergency Warning Signs"],
            "diagnosis": best["Diagnostic Methods"],
            "prevention_management": best["Prevention"],
            "source_name": best["Authoritative Source Name"],
            "source_url": url if url.startswith("http") else "",
            "source_is_homepage": urlparse(url).path in ("", "/"),
            "reviewed": best["Last Reviewed Date"][:10],
            "terse": len(best["Short Definition"]) < 90,
        })
    recs.sort(key=lambda r: r["id"])
    return recs, {"distinct_diseases": len(recs), "duplicate_rows_collapsed": dup_rows}


def passage(r: dict) -> str:
    parts = [
        f"{r['name']}",
        f"Also called: {', '.join(r['alt'])}" if r["alt"] else "",
        f"Category: {r['category']} - {r['subcategory']}",
        f"Definition: {r['definition']}",
        f"Symptoms: {'; '.join(r['symptoms'])}; {r['other_signs']}",
        f"Causes: {r['causes']}",
        f"Risk factors: {r['risk_factors']}",
        f"Transmission: {r['transmission']}",
        f"Affected: {r['age_group']}",
    ]
    return "\n".join(p for p in parts if p)[:1800]


def api_key() -> str:
    k = os.environ.get("MEDTOOLS_API_KEY", "")
    if k:
        return k
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MEDTOOLS_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


def mem_available_mb() -> int:
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 99999


def embed(texts: list[str], base: str, key: str, batch: int, min_free_mb: int) -> list[list[float]]:
    vecs: list[list[float]] = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        if len(chunk) == 1:  # medtools treats a single short text as a query; keep passage prefix
            chunk = chunk + [chunk[0]]
        free = mem_available_mb()
        if free < min_free_mb:
            sys.exit(f"Stopping: only {free} MB RAM available (< {min_free_mb}).")
        req = urllib.request.Request(
            base.rstrip("/") + "/v1/embeddings",
            data=json.dumps({"input": chunk, "encoding_format": "base64"}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    data = json.load(resp)["data"]
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    raise
                print(f"  retry after error: {e}", file=sys.stderr)
                time.sleep(3)
        got = sorted(data, key=lambda d: d["index"])[: min(batch, len(texts) - i)]
        for d in got:
            raw = base64.b64decode(d["embedding"])
            vecs.append(list(np.frombuffer(raw, dtype="<f4")) if np is not None else
                        list(__import__("struct").unpack(f"<{len(raw)//4}f", raw)))
        print(f"  embedded {min(i + batch, len(texts))}/{len(texts)} (free RAM {free} MB)", file=sys.stderr)
    return vecs


def quantise(v: list[float]) -> dict:
    import math
    v = [float(x) for x in v]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    u = [x / n for x in v]
    scale = max(abs(x) for x in u) / 127 or 1e-9
    q = bytes((int(round(x / scale)) & 0xFF) for x in u)
    return {"s": float(scale), "q": base64.b64encode(q).decode()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", required=True, type=Path)
    ap.add_argument("--medtools", default=os.environ.get("MEDTOOLS_URL", "http://127.0.0.1:4134"))
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--min-free-mb", type=int, default=900)
    ap.add_argument("--no-embed", action="store_true", help="keyword-only index")
    ap.add_argument("--out", type=Path, default=OUT_DIR / "disease-kb.json.gz")
    a = ap.parse_args()

    rows, st = load_rows(a.xlsx)
    recs, st2 = build_records(rows)
    st.update(st2)
    st["homepage_only_sources"] = sum(r["source_is_homepage"] for r in recs)
    st["terse_records"] = sum(r["terse"] for r in recs)
    print(json.dumps({k: (v if not isinstance(v, list) else (len(v), v[:10])) for k, v in st.items()}, ensure_ascii=False, indent=1), file=sys.stderr)
    if st["pii_hits"]:
        print("WARNING: possible personal data found; review before indexing:", st["pii_hits"][:20], file=sys.stderr)

    vectors = None
    if not a.no_embed:
        key = api_key()
        if not key:
            sys.exit("MEDTOOLS_API_KEY not found (env or .env); use --no-embed for keyword-only")
        vecs = embed([passage(r) for r in recs], a.medtools, key, max(2, a.batch), a.min_free_mb)
        vectors = [quantise(v) for v in vecs]

    src_hash = hashlib.sha256(a.xlsx.read_bytes()).hexdigest()
    kb = {
        "dataset": DATASET_NAME,
        "version": st.get("version") or "",
        "source_file": a.xlsx.name,
        "source_sha256": src_hash,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "embed_model": None if vectors is None else "multilingual-e5-base (medtools, int8 ONNX)",
        "dim": None if vectors is None else len(vecs[0]),
        "stats": {k: (len(v) if isinstance(v, list) else v) for k, v in st.items()},
        "records": recs,
        "vectors": vectors,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(a.out, "wt", encoding="utf-8") as f:
        json.dump(kb, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {a.out} ({a.out.stat().st_size // 1024} KB, {len(recs)} diseases)", file=sys.stderr)


if __name__ == "__main__":
    main()
