#!/usr/bin/env python3
"""Build the local disease knowledge base used by the `disease_knowledge_search` tool.

Input : packages/mcp-medical/data/disease-kb/source/Disease_Name_Data/ (committed),
        the extracted copy of Disease_Name_Data.zip:
          * every Global_Disease_Master_Chart*.xlsx snapshot (all five sheets:
            Master Disease Chart, Disease Categories, Source Register,
            Quality Control, Read Me)
          * every Disease_Names/*.txt name list
Output: packages/mcp-medical/data/disease-kb/disease-kb.json.gz (committed)
        records + sheet rows + int8-quantised multilingual-e5-base passage vectors.

Nothing is dropped:
  * every disease ID is its own record; IDs that describe the same disease under
    different names are NOT merged (they are cross-linked in `same_name_as`)
  * rows that are identical in several snapshot files are stored once, with the
    list of workbook versions they appear in
  * an ID whose content differs between versions keeps every version; the older
    one is marked `superseded` and keyed `<ID>@v<version>`
  * rows with shifted columns are realigned without losing a cell; a stray cell
    that fits no column is kept in `extra_cells`
  * all text is kept as written, dose text included
  * IDs that exist only in the name lists (D1401-D2000) become name-only records;
    a line marked "(already noted)" stays on its ID's record in `name_lines`, and
    two unmarked names under one ID become two records (`<ID>`, `<ID>-b`)
  * every distinct row of the other four sheets is kept in `sheet_rows`

The embeddings come from the self-hosted medtools service (POST /v1/embeddings,
multilingual-e5-base int8 ONNX). Nothing leaves the machine.

Usage (from the repo root):
  python3 packages/mcp-medical/scripts/build_disease_kb.py \
      [--src packages/mcp-medical/data/disease-kb/source/Disease_Name_Data] \
      [--medtools http://127.0.0.1:4134] [--batch 16] [--no-embed]

The medtools API key is read from MEDTOOLS_API_KEY or from the repo's .env.
See docs/DISEASE_KB.md.
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
from collections import defaultdict
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
SRC_DIR = OUT_DIR / "source" / "Disease_Name_Data"
SHEET = "Master Disease Chart"
OTHER_SHEETS = {
    "Disease Categories": "category",
    "Source Register": "source",
    "Quality Control": "quality_control",
    "Read Me": "read_me",
}
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
DATE_COL = COLS.index("Last Reviewed Date")  # 22

# Rows where the workbook lost one or two cells, so every later cell moved left.
# Value: the column indexes where an empty cell is re-inserted (checked by hand
# against the cell contents; see docs/DISEASE_KB.md). Re-inserting an empty cell
# moves text back under its own header; no text is removed.
LEFT_SHIFT_GAPS: dict[str, list[int]] = {
    # age group missing (cell 14 holds the severity text)
    "D0164": [14], "D0291": [14],
    # "Additional symptoms" missing (cell 10 holds the causes)
    "D0175": [10], "D0319": [10], "D0467": [10], "D0493": [10], "D0496": [10],
    # Symptom 4 missing (cell 9 is an additional note, cell 10 the causes)
    "D0539": [9], "D0540": [9], "D0541": [9], "D0542": [9], "D0545": [9],
    "D0546": [9], "D0549": [9], "D0550": [9], "D0581": [9], "D0587": [9],
    # Symptoms 3 and 4 missing (cell 8 is an additional note, cell 9 the causes)
    "D0544": [8, 9], "D0548": [8, 9],
}

PII_RE = re.compile(
    r"([\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d-]{9,}\d|\bpatient name\b|\bdate of birth\b|\bMRN\b|\bNID\b)",
    re.I,
)
ID_RE = re.compile(r"^(D\d{4})\s*:\s*(.+?)\s*$")
NOTED_RE = re.compile(r"\(\s*already\b[^)]*\)", re.I)


def s(v) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def is_date(v) -> bool:
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}", s(v)))


def clean_name(n: str) -> str:
    hits = re.findall(r"(?:new|replaced with|using alternative)\s*:\s*([^;)]+?)(?:\s+already covered)?(?=;|\)|$)", n, re.I)
    if hits:
        return hits[-1].strip()
    n = re.sub(r"\s*\([^)]*already[^)]*\)", "", n, flags=re.I)
    return re.sub(r"\s*\(confirmed\)\s*$", "", n, flags=re.I).strip()


def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", t.lower())


def realign(row: list) -> tuple[list, str, list]:
    """Return (23 cells, how it was realigned or '', stray cells kept aside)."""
    vals = [s(v) for v in row]
    while vals and vals[-1] == "":
        vals.pop()
    rid = vals[0] if vals else ""
    if len(vals) > 23 and is_date(vals[23]) and vals[21].startswith("http"):
        # Everything after the category block moved right by one: the subcategory
        # was split over two cells (D0946). Join the two cells.
        joined = " / ".join(x for x in (vals[4], vals[5]) if x)
        return vals[:4] + [joined] + vals[6:24], "subcategory split over two cells; joined", vals[24:]
    if len(vals) > 23 and is_date(vals[23]) and not is_date(vals[22]):
        # A stray cell between the status and the date (D0893). Keep it aside.
        return vals[:22] + [vals[23]], "stray cell before the date moved to extra_cells", [vals[22]] + vals[24:]
    if rid in LEFT_SHIFT_GAPS and len(vals) <= 23 and not is_date(vals[DATE_COL] if len(vals) > DATE_COL else ""):
        out = list(vals)
        for gap in LEFT_SHIFT_GAPS[rid]:
            out.insert(gap, "")
        out += [""] * (23 - len(out))
        names = ", ".join(COLS[g] for g in LEFT_SHIFT_GAPS[rid])
        return out[:23], f"cells shifted left; empty cell re-inserted at: {names}", out[23:]
    vals += [""] * (23 - len(vals))
    return vals[:23], "", vals[23:]


def workbook_version(wb) -> str:
    if "Read Me" not in wb.sheetnames:
        return ""
    for r in wb["Read Me"].iter_rows(values_only=True):
        line = " ".join(s(c) for c in r if c)
        m = re.search(r"version[^0-9]*([0-9][0-9.]*)", line, re.I)
        if m:
            return m.group(1).rstrip(".")
    return ""


def vkey(v: str) -> tuple:
    return tuple(int(x) for x in v.split(".") if x.isdigit()) or (0,)


def split_alt(text: str, name: str) -> list[str]:
    out: list[str] = []
    for part in re.split(r"[;,/]", text):
        p = part.strip()
        if p and p.lower() not in (x.lower() for x in out) and p.lower() != name.lower():
            out.append(p)
    return out


def chart_record(cells: list[str]) -> dict:
    rec = dict(zip(COLS, cells))
    name = clean_name(rec["Standard Disease Name"]) or rec["Standard Disease Name"]
    url = rec["Source URL"]
    out = {
        "key": rec["Unique Disease ID"],
        "id": rec["Unique Disease ID"],
        "name": name,
        "raw_name": rec["Standard Disease Name"] if rec["Standard Disease Name"] != name else "",
        "alt": split_alt(rec["Alternative or Common Names"], name),
        "category": rec["Main Medical Category"],
        "subcategory": rec["Subcategory"],
        "definition": rec["Short Definition"],
        "symptoms": [rec[f"Symptom {i}"] for i in range(1, 5) if rec[f"Symptom {i}"]],
        "other_signs": rec["Additional Important Symptoms or Signs"],
        "causes": rec["Causes"],
        "risk_factors": rec["Risk Factors"],
        "transmission": rec["Transmission Route (if applicable)"],
        "age_group": rec["Commonly Affected Age Group"],
        "severity": rec["Severity"],
        "warning_signs": rec["Emergency Warning Signs"],
        "diagnosis": rec["Diagnostic Methods"],
        "prevention_management": rec["Prevention"],
        "source_name": rec["Authoritative Source Name"],
        "source_url": url,
        "source_is_homepage": bool(url.startswith("http") and urlparse(url).path in ("", "/")),
        "verification": rec["Verification Status"],
        "reviewed": rec["Last Reviewed Date"][:10],
        "terse": len(rec["Short Definition"]) < 90,
        "name_only": False,
    }
    return out


def load_workbooks(src: Path) -> tuple[list[dict], list[dict], list[dict], dict]:
    files = sorted(src.glob("*.xlsx"))
    if not files:
        sys.exit(f"No .xlsx files in {src}")
    file_info = []
    # id -> signature -> {cells, realigned, extra, versions:set, files:set}
    by_id: dict[str, dict[tuple, dict]] = defaultdict(dict)
    sheet_rows: dict[tuple, dict] = {}
    stats = {"workbooks": len(files), "chart_rows_read": 0, "pii_hits": []}
    for f in files:
        wb = openpyxl.load_workbook(f, read_only=True)
        ver = workbook_version(wb)
        info = {"file": f.name, "version": ver, "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                "sheets": {}}
        ws = wb[SHEET]
        rows = list(ws.iter_rows(values_only=True))
        header = [s(h) for h in rows[0][:23]]
        if header != COLS:
            sys.exit(f"Unexpected header in {f.name}: {header}")
        n = 0
        for raw in rows[1:]:
            if not raw or not s(raw[0]):
                continue
            cells, how, extra = realign(list(raw))
            sig = tuple(cells) + ("\x00",) + tuple(extra)
            slot = by_id[cells[0]].setdefault(sig, {"cells": cells, "realigned": how, "extra": extra,
                                                     "versions": set(), "files": set()})
            slot["versions"].add(ver)
            slot["files"].add(f.name)
            n += 1
        info["sheets"][SHEET] = n
        stats["chart_rows_read"] += n
        for sheet, kind in OTHER_SHEETS.items():
            if sheet not in wb.sheetnames:
                continue
            m = 0
            for raw in wb[sheet].iter_rows(values_only=True):
                cells = [s(c) for c in raw]
                while cells and cells[-1] == "":
                    cells.pop()
                if not any(cells):
                    continue
                m += 1
                k = (sheet, tuple(cells))
                slot = sheet_rows.setdefault(k, {"kind": kind, "sheet": sheet, "cells": cells,
                                                 "versions": set(), "first_seen": (vkey(ver), m)})
                slot["versions"].add(ver)
                slot["first_seen"] = min(slot["first_seen"], (vkey(ver), m))
            info["sheets"][sheet] = m
        file_info.append(info)

    records: list[dict] = []
    stats["realigned"] = []
    stats["versioned_ids"] = []
    for rid in sorted(by_id):
        variants = sorted(by_id[rid].values(), key=lambda v: max(vkey(x) for x in v["versions"]), reverse=True)
        if len(variants) > 1:
            stats["versioned_ids"].append(rid)
        for i, v in enumerate(variants):
            rec = chart_record(v["cells"])
            vers = sorted(v["versions"], key=vkey)
            rec["versions"] = vers
            rec["superseded"] = i > 0
            if i > 0:
                rec["key"] = f"{rid}@v{vers[-1]}"
                rec["superseded_by"] = rid
            if v["realigned"]:
                rec["realigned"] = v["realigned"]
                if rid not in stats["realigned"]:
                    stats["realigned"].append(rid)
            if v["extra"]:
                rec["extra_cells"] = v["extra"]
            for h in ("definition", "other_signs", "causes", "risk_factors", "diagnosis", "prevention_management"):
                m = PII_RE.search(rec[h])
                if m:
                    stats["pii_hits"].append((rec["key"], h, m.group(0)))
            records.append(rec)

    rows_out = []
    for v in sorted(sheet_rows.values(), key=lambda r: (list(OTHER_SHEETS).index(r["sheet"]), r["first_seen"])):
        rows_out.append({"kind": v["kind"], "sheet": v["sheet"], "cells": v["cells"],
                         "versions": sorted(v["versions"], key=vkey)})
    return records, rows_out, file_info, stats


def load_name_lists(src: Path, chart_ids: set[str], chart_names: dict[str, str]) -> tuple[list[dict], list[dict], dict]:
    lines_by_id: dict[str, list[tuple[str, str]]] = defaultdict(list)
    info = []
    for f in sorted((src / "Disease_Names").glob("*.txt")):
        n = 0
        for line in f.read_text(encoding="utf-8").splitlines():
            m = ID_RE.match(line.strip())
            if not m:
                continue
            n += 1
            lines_by_id[m.group(1)].append((m.group(2), f.name))
        info.append({"file": f.name, "sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "name_lines": n})
    stats = {"name_list_lines": sum(len(v) for v in lines_by_id.values()),
             "name_list_ids_already_in_chart": 0, "name_list_name_differs_from_chart": []}
    records = []
    for rid in sorted(lines_by_id):
        lines = lines_by_id[rid]
        if rid in chart_ids:
            stats["name_list_ids_already_in_chart"] += 1
            for text, _ in lines:
                if norm(clean_name(text)) != norm(chart_names.get(rid, "")):
                    stats["name_list_name_differs_from_chart"].append((rid, text))
            continue
        unmarked = [(t, fn) for t, fn in lines if not NOTED_RE.search(t)]
        main = unmarked or [lines[0]]
        for i, (text, fn) in enumerate(main):
            name = clean_name(text) or text
            rec = {
                "key": rid if i == 0 else f"{rid}-{chr(ord('a') + i)}",
                "id": rid,
                "name": name,
                "raw_name": text if text != name else "",
                "alt": [],
                "name_only": True,
                "name_list_file": fn,
                "versions": [],
                "superseded": False,
            }
            others = [t for t, _ in lines if t != text]
            if others:
                rec["name_lines"] = [t for t, _ in lines]
            records.append(rec)
    return records, info, stats


def cross_link(records: list[dict]) -> int:
    groups: dict[str, list[str]] = defaultdict(list)
    for r in records:
        if not r.get("superseded"):
            groups[norm(r["name"])].append(r["key"])
    n = 0
    for r in records:
        same = [k for k in groups.get(norm(r["name"]), []) if k != r["key"]]
        if same:
            r["same_name_as"] = same
            n += 1
    return n


def passage(r: dict) -> str:
    if r.get("name_only"):
        extra = "; ".join(x for x in r.get("name_lines", []) if x != r["name"])
        return f"{r['name']}" + (f"\nAlso listed as: {extra}" if extra else "")
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
        if (i // batch) % 10 == 0 or i + batch >= len(texts):
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
    ap.add_argument("--src", type=Path, default=SRC_DIR)
    ap.add_argument("--medtools", default=os.environ.get("MEDTOOLS_URL", "http://127.0.0.1:4134"))
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--min-free-mb", type=int, default=900)
    ap.add_argument("--no-embed", action="store_true", help="keyword-only index")
    ap.add_argument("--out", type=Path, default=OUT_DIR / "disease-kb.json.gz")
    a = ap.parse_args()

    chart, sheet_rows, wb_info, st = load_workbooks(a.src)
    chart_ids = {r["id"] for r in chart}
    chart_names = {r["id"]: r["name"] for r in chart if not r["superseded"]}
    named, txt_info, st2 = load_name_lists(a.src, chart_ids, chart_names)
    st.update(st2)
    recs = chart + named
    recs.sort(key=lambda r: (r["id"], r.get("superseded", False), r["key"]))
    st["records_total"] = len(recs)
    st["chart_records"] = len(chart)
    st["chart_ids"] = len(chart_ids)
    st["superseded_versions"] = sum(1 for r in chart if r["superseded"])
    st["name_only_records"] = len(named)
    st["name_only_ids"] = len({r["id"] for r in named})
    st["records_sharing_a_name"] = cross_link(recs)
    st["sheet_rows"] = len(sheet_rows)
    st["sheet_rows_by_sheet"] = {k: sum(1 for r in sheet_rows if r["sheet"] == k) for k in OTHER_SHEETS}
    st["homepage_only_sources"] = sum(1 for r in chart if r.get("source_is_homepage"))
    st["terse_records"] = sum(1 for r in chart if r.get("terse"))
    keys = [r["key"] for r in recs]
    assert len(keys) == len(set(keys)), "duplicate record keys"
    print(json.dumps({k: (v if not isinstance(v, list) else (len(v), v[:25])) for k, v in st.items()},
                     ensure_ascii=False, indent=1), file=sys.stderr)

    vectors = None
    dim = None
    if not a.no_embed:
        key = api_key()
        if not key:
            sys.exit("MEDTOOLS_API_KEY not found (env or .env); use --no-embed for keyword-only")
        vecs = embed([passage(r) for r in recs], a.medtools, key, max(2, a.batch), a.min_free_mb)
        vectors = [quantise(v) for v in vecs]
        dim = len(vecs[0])

    kb = {
        "dataset": DATASET_NAME,
        "version": max((w["version"] for w in wb_info), key=vkey),
        "source_files": wb_info,
        "name_list_files": txt_info,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "embed_model": None if vectors is None else "multilingual-e5-base (medtools, int8 ONNX)",
        "dim": dim,
        "stats": {k: (len(v) if isinstance(v, list) else v) for k, v in st.items()},
        "records": recs,
        "sheet_rows": sheet_rows,
        "vectors": vectors,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(a.out, "wt", encoding="utf-8") as f:
        json.dump(kb, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {a.out} ({a.out.stat().st_size // 1024} KB, {len(recs)} records, "
          f"{len(sheet_rows)} sheet rows)", file=sys.stderr)


if __name__ == "__main__":
    main()
