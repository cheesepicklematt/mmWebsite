"""
Minimal AEMO NEMWeb reader.

AEMO publishes almost everything in one idiosyncratic CSV dialect. A single
file holds SEVERAL tables, distinguished by row-type in column 0:

    C  comment/control  -> header (first row) and footer (last row, w/ row count)
    I  information      -> column names for the table that follows
    D  data             -> a data row, matching the most recent I row

    C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,2026/09/09,00:50:09,...
    I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,...,RRP,...
    D,DISPATCH,PRICE,5,"2026/09/09 00:55:00",1,NSW1,...,65.5,...
    C,"END OF REPORT",1123

Columns 1-3 of every I/D row are (report, subreport, version); the real
payload starts at column 4. Use a real CSV reader -- fields like
REBIDEXPLANATION are free text and contain commas.
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "https://nemweb.com.au"
UA = {"User-Agent": "Mozilla/5.0 (aemo-sandpit)"}


def parse(text: str) -> dict[str, list[dict]]:
    """Split one AEMO CSV into {'REPORT.SUBREPORT': [rowdict, ...]}."""
    tables: dict[str, list[dict]] = defaultdict(list)
    schema: dict[tuple[str, str], list[str]] = {}
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        kind = row[0]
        if kind == "I":
            schema[(row[1], row[2])] = row[4:]
        elif kind == "D":
            cols = schema[(row[1], row[2])]
            tables[f"{row[1]}.{row[2]}"].append(dict(zip(cols, row[4:])))
    return dict(tables)


def fetch(url: str) -> bytes:
    with urlopen(Request(url, headers=UA), timeout=120) as r:
        return r.read()


def read_zip(data: bytes) -> dict[str, list[dict]]:
    """Unwrap a NEMWeb .zip (sometimes nested) and parse the CSV inside."""
    zf = zipfile.ZipFile(io.BytesIO(data))
    name = zf.namelist()[0]
    inner = zf.read(name)
    if name.upper().endswith(".ZIP"):
        return read_zip(inner)
    return parse(inner.decode("utf-8", errors="replace"))


def latest(report: str) -> dict[str, list[dict]]:
    """Fetch + parse the most recent file in Reports/Current/<report>/."""
    import re

    listing = fetch(f"{BASE}/Reports/Current/{report}/").decode("utf-8", "replace")
    files = sorted(set(re.findall(r"PUBLIC_[A-Z0-9_]+\.zip", listing, re.I)))
    if not files:
        raise LookupError(f"no files in Reports/Current/{report}/")
    return read_zip(fetch(f"{BASE}/Reports/Current/{report}/{files[-1]}"))


if __name__ == "__main__":
    t = latest("DispatchIS_Reports")
    print(f"tables in file: {', '.join(sorted(t))}\n")
    print(f"{'REGION':<8}{'SETTLEMENTDATE':<22}{'RRP $/MWh':>12}{'RAISEREG':>10}")
    for r in t["DISPATCH.PRICE"]:
        print(f"{r['REGIONID']:<8}{r['SETTLEMENTDATE']:<22}"
              f"{float(r['RRP']):>12,.2f}{float(r['RAISEREGRRP']):>10,.2f}")
