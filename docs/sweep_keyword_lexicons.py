#!/usr/bin/env python3
"""Sweep the medical surfaces for alternation regexes that could act as a lexicon.

Run this after touching anything in the triage / admin / orchestration path:

    python3 docs/sweep_keyword_lexicons.py

The question it answers is narrow and worth answering honestly: does any regex in
this repository match clinical *words* often enough to decide a severity, a
specialty or a diagnosis?

Interpretation rule of thumb, from the 2026-10-27 audit (§F-25, §F-40…F-43, §F-45):

  * a regex over **mark-up, dosages forms, salt suffixes, section headings or
    ontology prefixes** is a parser — a wrong match is a display or price bug;
  * a regex over **symptom / drug-name / disease vocabulary** is a lexicon — a
    wrong match is a missed or invented clinical finding.

Only the second category may not exist. Every line printed here must be
classifiable as the first.
"""

import pathlib
import re
import sys

ROOTS = [
    "packages/mcp-medical/src",
    "api/server/routes/admin",
    "client/src/components/Admin",
]

SKIP = re.compile(r"\.spec\.|__tests__|\.test\.|/dist/")


def main() -> int:
    root_dir = pathlib.Path(__file__).resolve().parent.parent
    found = 0
    for root in ROOTS:
        for path in sorted((root_dir / root).rglob("*")):
            if path.is_dir() or path.suffix not in (".ts", ".tsx", ".js"):
                continue
            if SKIP.search(str(path)):
                continue
            for lineno, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
                if line.count("|") < 2:
                    continue
                if not re.search(r"[a-zA-Z]{4,}\|[a-zA-Z]{4,}", line):
                    continue
                print(f"{path.relative_to(root_dir)}:{lineno}: {line.strip()[:120]}")
                found += 1
    print(f"\n{found} alternation-regex line(s) found. Classify each one before merging.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
