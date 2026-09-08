#!/usr/bin/env python3
"""
Build the browser data bundle for the NEM visualisation. Standard library only.

Reads the cached 5-minute DISPATCHPRICE extracts in raw/ (written by
build_viz_data.py) and emits ONE JavaScript file that assigns a global:

    web/nem_data.js   ->   window.NEM_DATA = {...}

A .js file rather than .json so the page works from file:// as well as over
HTTP -- fetch() is blocked on the former, a <script> tag is not.

    python3 build_web_bundle.py
"""

from __future__ import annotations

import json
import statistics as st
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent
RAW = HERE / "raw"
WEB = HERE / "web"
REGIONS = ["NSW1", "QLD1", "SA1", "TAS1", "VIC1"]
SPIKE = 300.0          # $/MWh -- the standard cap-contract strike


def load_raw() -> list[tuple[datetime, str, float]]:
    """All cached 5-min intervals as (interval_start, region, price)."""
    out = []
    for f in sorted(RAW.glob("dispatchprice_*.jsonl")):
        for line in f.read_text().splitlines():
            r = json.loads(line)
            end = datetime.strptime(r["t"], "%Y/%m/%d %H:%M:%S")
            out.append((end - timedelta(minutes=5), r["r"], r["p"]))   # stamp is interval END
    return out


def duck(rows) -> dict:
    """Mean and median price by hour of day -- the shape solar carved."""
    acc = defaultdict(list)
    for start, reg, p in rows:
        acc[(reg, start.hour)].append(p)
    out = {}
    for reg in REGIONS:
        v = [acc[(reg, h)] for h in range(24)]
        out[reg] = {"mean": [round(st.mean(x), 2) for x in v],
                    "median": [round(st.median(x), 2) for x in v],
                    "pct_negative": [round(100 * sum(1 for y in x if y < 0) / len(x), 1) for x in v]}
    return out


def duration(rows, n=180) -> dict:
    """Price duration curve: price vs % of time at or above it.

    Sampled on a log-spaced percentile grid so the top 1% -- where nearly all
    the money is -- keeps its resolution instead of collapsing to one point.
    """
    acc = defaultdict(list)
    for _, reg, p in rows:
        acc[reg].append(p)
    # 0.01% .. 100% of time, log-spaced
    lo, hi = -4.0, 0.0
    frac = [10 ** (lo + (hi - lo) * i / (n - 1)) for i in range(n)]
    out = {}
    for reg in REGIONS:
        s = sorted(acc[reg], reverse=True)
        m = len(s)
        out[reg] = [round(s[min(m - 1, int(f * m))], 2) for f in frac]
    return {"pct_of_time": [round(100 * f, 4) for f in frac], "regions": out}


def stats(rows) -> dict:
    acc = defaultdict(list)
    for _, reg, p in rows:
        acc[reg].append(p)
    out = {}
    for reg in REGIONS:
        v = acc[reg]
        n = len(v)
        top = sorted(v, reverse=True)[: max(1, n // 100)]          # top 1% of intervals
        out[reg] = {
            "n": n,
            "mean": round(st.mean(v), 2),
            "median": round(st.median(v), 2),
            "min": round(min(v), 2),
            "max": round(max(v), 2),
            "pct_negative": round(100 * sum(1 for x in v if x < 0) / n, 1),
            "pct_spike": round(100 * sum(1 for x in v if x > SPIKE) / n, 2),
            # what share of a flat generator's revenue came from the top 1% of intervals
            "top1pct_revenue_share": round(100 * sum(top) / sum(v), 1) if sum(v) > 0 else None,
        }
    return out


def notable_days(rows) -> list[dict]:
    """Three 5-minute days worth looking at, all regions each."""
    by_day = defaultdict(lambda: defaultdict(list))     # date -> region -> [(start, p)]
    for start, reg, p in rows:
        by_day[start.date()][reg].append((start, p))

    days = sorted(by_day)
    peak = max(days, key=lambda d: max(p for r in REGIONS for _, p in by_day[d][r]))
    trough = min(days, key=lambda d: st.mean([p for r in REGIONS for _, p in by_day[d][r]]))
    means = sorted(days, key=lambda d: st.mean([p for r in REGIONS for _, p in by_day[d][r]]))
    typical = means[len(means) // 2]

    labels = [(peak, "A spike day", "The stack ran out. Watch how briefly it lasts."),
              (trough, "A solar-flooded day", "Negative for hours: paying to stay on."),
              (typical, "An ordinary day", "The shape you see most of the time.")]
    out = []
    for d, title, blurb in labels:
        rec = {"date": d.isoformat(), "title": title, "blurb": blurb, "regions": {}}
        for reg in REGIONS:
            series = sorted(by_day[d][reg])
            rec["regions"][reg] = [round(p, 2) for _, p in series]
        out.append(rec)
    return out


def main() -> None:
    rows = load_raw()
    print(f"loaded {len(rows):,} five-minute intervals")
    daily = json.loads((WEB / "price_daily.json").read_text())

    bundle = {
        "meta": {
            "source": "AEMO NEMWeb, DISPATCHPRICE (INTERVENTION=0)",
            "note": "AEMO does not endorse this analysis.",
            "from": daily["t"][0], "to": daily["t"][-1],
            "intervals": len(rows),
            "tz": "Market time = UTC+10, no daylight saving",
            "mpc": 20300, "floor": -1000,     # FY2025-26 cap; these months fall in FY2025-26
        },
        "regions": REGIONS,
        "daily": daily,
        "duck": duck(rows),
        "duration": duration(rows),
        "stats": stats(rows),
        "days": notable_days(rows),
    }

    WEB.mkdir(exist_ok=True)
    out = WEB / "nem_data.js"
    out.write_text("window.NEM_DATA = " + json.dumps(bundle, separators=(",", ":")) + ";\n")
    print(f"wrote {out}  {out.stat().st_size/1024:,.0f} KB")
    for r in REGIONS:
        s = bundle["stats"][r]
        print(f"  {r:5} mean ${s['mean']:>8,.2f}  median ${s['median']:>7,.2f}  "
              f"max ${s['max']:>9,.2f}  neg {s['pct_negative']:>4.1f}%  "
              f"top1% = {s['top1pct_revenue_share']}% of revenue")


if __name__ == "__main__":
    main()
