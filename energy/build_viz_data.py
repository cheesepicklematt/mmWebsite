#!/usr/bin/env python3
"""
Build web-ready price series from AEMO data. Standard library only.

    python3 build_viz_data.py 2026-01 2026-06     # backfill a range
    python3 build_viz_data.py --live              # append latest dispatch

Writes columnar JSON to ./web/ :
    price_daily.json    full history, ~90KB/year  -- ship this by default
    price_hourly.json   last 2 years, ~1.5MB/year -- fetch on zoom
"""

from __future__ import annotations

import json
import statistics as st
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from aemo import BASE, fetch, read_zip

REGIONS = ["NSW1", "QLD1", "SA1", "TAS1", "VIC1"]
RAW = Path("data/raw"); WEB = Path("web")
MMSDM = f"{BASE}/Data_Archive/Wholesale_Electricity/MMSDM"


def month_url(table: str, y: int, m: int) -> str:
    return (f"{MMSDM}/{y}/MMSDM_{y}_{m:02d}/MMSDM_Historical_Data_SQLLoader/DATA/"
            f"PUBLIC_ARCHIVE%23{table}%23FILE01%23{y}{m:02d}010000.zip")


def load_month(y: int, m: int) -> list[dict]:
    """Fetch one month of DISPATCHPRICE, cached on disk as JSON lines."""
    cache = RAW / f"dispatchprice_{y}{m:02d}.jsonl"
    if cache.exists():
        return [json.loads(l) for l in cache.read_text().splitlines()]
    RAW.mkdir(parents=True, exist_ok=True)
    rows = next(iter(read_zip(fetch(month_url("DISPATCHPRICE", y, m))).values()))
    keep = [{"t": r["SETTLEMENTDATE"], "r": r["REGIONID"], "p": float(r["RRP"])}
            for r in rows if r["INTERVENTION"] == "0"]          # trap: prices use INTERVENTION=0
    cache.write_text("\n".join(json.dumps(r) for r in keep))
    return keep


def bucket(rows: list[dict], grain: str) -> dict:
    """Aggregate to 'hour' or 'day'. Timestamps are interval END -> shift back 5 min."""
    acc: dict[tuple[str, str], list[float]] = defaultdict(list)
    for r in rows:
        end = datetime.strptime(r["t"], "%Y/%m/%d %H:%M:%S")
        start = end - timedelta(minutes=5)                       # trap: off-by-one at boundaries
        key = start.strftime("%Y-%m-%dT%H:00") if grain == "hour" else start.strftime("%Y-%m-%d")
        acc[(r["r"], key)].append(r["p"])
    return acc


def emit(acc, grain: str, path: Path) -> None:
    """Columnar JSON: arrays per field, not an array of objects (~half the bytes)."""
    keys = sorted({k for _, k in acc})
    out: dict = {"grain": grain, "t": keys, "regions": {}}
    expect = 12 if grain == "hour" else 288
    warned = 0
    for reg in REGIONS:
        med, lo, hi, mean, neg = [], [], [], [], []
        for k in keys:
            v = acc.get((reg, k))
            if not v:
                med.append(None); lo.append(None); hi.append(None)
                mean.append(None); neg.append(None); continue
            if len(v) != expect and warned < 5:
                print(f"  ! {reg} {k}: {len(v)} intervals, expected {expect}"); warned += 1
            med.append(round(st.median(v), 2)); lo.append(round(min(v), 2))
            hi.append(round(max(v), 2)); mean.append(round(st.mean(v), 2))
            neg.append(round(100 * sum(1 for x in v if x < 0) / len(v), 1))
        out["regions"][reg] = {"median": med, "min": lo, "max": hi,
                               "mean": mean, "pct_negative": neg}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"  wrote {path}  {len(keys):,} buckets  {path.stat().st_size/1024:,.0f} KB")


def main(argv: list[str]) -> None:
    if "--live" in argv:
        rows = [{"t": r["SETTLEMENTDATE"], "r": r["REGIONID"], "p": float(r["RRP"])}
                for r in __import__("aemo").latest("DispatchIS_Reports")["DISPATCH.PRICE"]
                if r["INTERVENTION"] == "0"]
        print(json.dumps(rows, indent=2)); return

    start, end = argv[1], argv[2] if len(argv) > 2 else argv[1]
    y0, m0 = map(int, start.split("-")); y1, m1 = map(int, end.split("-"))
    rows: list[dict] = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        print(f"{y}-{m:02d} ...", end=" ", flush=True)
        try:
            got = load_month(y, m); rows += got; print(f"{len(got):,} rows")
        except Exception as e:
            print(f"skip ({type(e).__name__})")
        m += 1
        if m > 12: y, m = y + 1, 1
    print(f"\ntotal {len(rows):,} intervals")
    for grain, name in (("day", "price_daily.json"), ("hour", "price_hourly.json")):
        emit(bucket(rows, grain), grain, WEB / name)


if __name__ == "__main__":
    main(sys.argv)
