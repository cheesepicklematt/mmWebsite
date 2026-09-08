# Australian Energy Market — Discovery Notes

Compiled 9 September 2026. Every figure marked **[verified]** was pulled live from NEMWeb
while writing these notes, not quoted from documentation.

Companion artifact (visual guide): https://claude.ai/code/artifact/97a3e9f0-7428-49d9-b621-90219f9b9f2b
Working parser: `aemo.py` (this directory)

---

## Table of contents

1. [How the market works](#1-how-the-market-works)
2. [Bidding and the ladder](#2-bidding-and-the-ladder)
3. [Positions, contracts and hedging](#3-positions-contracts-and-hedging)
4. [The data landscape](#4-the-data-landscape)
5. [The AEMO file format](#5-the-aemo-file-format)
6. [Tables that matter](#6-tables-that-matter)
7. [Identifiers and time](#7-identifiers-and-time)
8. [Traps](#8-traps)
9. [Extraction pipeline](#9-extraction-pipeline)
10. [Aggregation](#10-aggregation)
11. [Building the visualisation](#11-building-the-visualisation)
12. [Verified facts reference](#12-verified-facts-reference)

---

## 1. How the market works

The **National Electricity Market (NEM)** covers five regions on the east coast, joined by six
interconnectors:

| Region | Covers |
|---|---|
| `NSW1` | New South Wales + ACT |
| `QLD1` | Queensland |
| `VIC1` | Victoria |
| `SA1`  | South Australia |
| `TAS1` | Tasmania |

All region IDs carry a trailing `1`, reserved for a future subdivision that has never happened.
Western Australia runs a completely separate market (the **WEM**) on its own grid.

**It is a gross pool.** There is no bilateral physical trading. Every generator offers into one
auction, AEMO's dispatch engine (NEMDE) clears it, and everyone settles at the resulting regional
price. You cannot sell power directly to a customer physically — everything goes through the pool.

**Cadence: every 5 minutes**, 288 intervals per day, priced independently for each of the 5 regions
= 1,440 regional prices per day. Since October 2021 settlement matches dispatch at 5 minutes
(previously dispatch was 5-min but settlement averaged over 30-min).

**Single clearing price.** Offers are stacked cheapest-first; the last offer needed to meet demand
sets the price for *everyone* dispatched. Not pay-as-bid.

### Price bounds (FY2026-27)

| Setting | Value |
|---|---|
| Market Price Cap (MPC) | **$23,200/MWh** |
| Market Floor Price | **−$1,000/MWh** |
| Cumulative Price Threshold (CPT) | **$2,225,900** over 7 days |

Indexed annually by AEMC. Breaching the CPT trips **administered pricing**, capping prices at a much
lower level until the market settles. The machinery is visible in the data: `APCFLAG`,
`PRE_AP_ENERGY_PRICE`, `CUMUL_PRE_AP_ENERGY_PRICE` in `DISPATCHPRICE`.

> **Important:** these caps apply at the *regional reference node*. Bids are made at the
> *connection point*. See [§8 Traps](#8-traps).

### Co-optimised ancillary services

The same engine simultaneously clears **10 frequency control markets** (FCAS): raise and lower at
1-second, 6-second, 60-second, 5-minute and regulation timescales. That is why one dispatch file
carries seven different tables.

### AEMO is not a counterparty

AEMO is a **not-for-profit on cost recovery**, owned 60% by federal/state governments and 40% by
industry. It takes no cut of traded value and holds no position — it nets payments from load to
generators and passes them through. Its budget is recovered via participant fees (`MARKETFEE`,
`MARKETFEEDATA` tables). Gaming the market does not cost AEMO money; it costs consumers.

---

## 2. Bidding and the ladder

### The mechanism

Each **dispatchable unit** (`DUID`) submits a ladder of up to **10 price/volume bands** per product.
AEMO pools every band from every unit in the region into one giant supply staircase, sorts
cheapest-first, and walks up it until cumulative MW meets demand. The band it stops on sets the price.

**A bid is not a price you accept — it is a threshold**: *"dispatch me once the price reaches here."*
Everything below the clearing price earns the full clearing price.

### Worked example

Demand 1,000 MW. Five units, one band each:

| Unit | Offer | MW | Cumulative |
|---|---:|---:|---:|
| Solar farm | $0 | 300 | 300 |
| Wind farm | $5 | 200 | 500 |
| Coal | $40 | 300 | 800 |
| **Gas CCGT** | **$70** | **250** | **1,050** ← marginal |
| Peaker OCGT | $250 | 200 | 1,250 |

Clearing price **$70/MWh**, paid to all dispatched units:

- Solar: 300 MW × $70 = $21,000 (offered at $0 — full margin)
- Wind: 200 × $70 = $14,000
- Coal: 300 × $70 = $21,000
- Gas: 200 × $70 = $14,000 (partially dispatched, the only one earning its offer)
- Peaker: **nothing** — never reached

Five minutes later demand rises to 1,100 MW. The stack runs out at 1,050, so AEMO reaches into the
peaker for 50 MW → **price jumps to $250/MWh**. Demand +10%, price +257%.

**The price is a staircase, not a curve.** When the cheap end is exhausted, the next step can be
$16,000. This is the defining statistical property of the data.

### A real bid stack [verified]

Eraring Unit 1 (`ER01`, coal, NSW), as offered for 7 September 2026:

| Band | Price $/MWh | MW | Cumulative |
|---:|---:|---:|---:|
| 1 | **−983.10** | 182 | 182 |
| 2 | 12.98 | 278 | 460 |
| 3 | 24.57 | 100 | 560 |
| 4 | 42.08 | 70 | 630 |
| 5 | 56.42 | 70 | 700 |
| 6–9 | 63.85 – 231.08 | 0 | 700 |
| 10 | **22,759.75** | 50 | 750 |

Ramp rates `ROCUP`/`ROCDOWN` = 5 MW/min.

Read the shape:
- **Band 1 at −$983**: will pay nearly the floor price to stay synchronised rather than shut down and
  pay to restart. Also insurance against volume risk if hedged (see §3).
- **Bands 2–5**: the real operating ladder through fuel cost.
- **Band 10 at $22,759.75**: the ceiling, never expected to clear, capturing extreme upside.
  This is `$23,200 ÷ Eraring's marginal loss factor` — see [§8](#8-traps).

At the NSW price observed that week ($65.50), bands 1–5 clear → **700 MW dispatched, all paid $65.50**.

### Update cadence — the critical asymmetry [verified]

| | Price bands | Volume bands |
|---|---|---|
| Set by | 12:30pm the **day before** | Continuously |
| Changeable intraday | **No** | **Yes**, until ~5 min before dispatch |
| Table | `BIDDAYOFFER_D` | `BIDPEROFFER_D` |

Tested directly: across **573 ladders, zero changed price bands** during the trading day.

Rebid frequency varies enormously:

```
WDBESS1, VBB1, TRGBESS1, TBSF1 ...   288 resubmissions/day  (every interval — batteries)
median unit across all 507 units        1 submission/day     (set and forget — thermal)
```

**Strategy = prices are a commitment, volumes are a response.**

Every rebid requires a **genuine written reason** in `REBIDEXPLANATION`. Real examples [verified]:

```
Change in forecast SOC
SA1 5MIN PD RRP FOR 0430 ($43.83) PUBLISHED AT 0355 IS $10.21 LOWER...
QLD1 30MIN PD RRP FOR 2000 ($107.73) PUBLISHED AT 0331 IS $2.72 ...
```

False or misleading explanations are a civil penalty offence. This field contains commas and quotes
— **it will break naive CSV parsing.**

### Fuel type is NOT in the bid

NEMDE is deliberately fuel-blind. A band is price + MW; the engine does not know or care whether it
is coal, wind or a battery. Fuel type lives in *static registration* data (`DUDETAILSUMMARY`,
`GENUNITS`, `STATION`).

What the bid **does** carry is the physics:

| Field | Meaning |
|---|---|
| `ROCUP` / `ROCDOWN` | Ramp rate MW/min |
| `ENERGYLIMIT` | Total deliverable energy (storage, hydro) |
| `DIRECTION` | `GEN` or `LOAD` |
| `MINIMUMLOAD`, `FIXEDLOAD` | Operating envelope |
| `MAXAVAIL`, `PASAAVAILABILITY` | Availability |
| `RECALL_PERIOD` | Storage recall |

**Batteries bid twice.** `DIRECTION` is `GEN` (discharge) or `LOAD` (charge), each with its own
independent 10-band ladder. [verified] **66 units bid both directions**, so 507 units produce
**573 ladders**. Charging is bid as negative demand: *"buy me power if it's cheaper than this."*

**Wind and solar are semi-scheduled.** AEMO caps their availability using its *own* weather forecast
(UIGF), not the bid. A solar farm can offer 300 MW at $0 and be dispatched to 40 MW because AEMO's
forecast says clouds. The constraint arrives externally.

### Market participation scale [verified, 7 Sep 2026]

```
261 participants
507 units bidding ENERGY  (569 distinct units across all products)
2,105 ten-band ladders submitted across 11 products
  ENERGY      507 units       RAISE6SEC   194 units
  RAISE60SEC  212 units       LOWER60SEC  187 units
  RAISE5MIN   198 units       ... etc
```

---

## 3. Positions, contracts and hedging

### Who is exposed

The pool forces a position on you just by existing:

| Player | Position | Fears |
|---|---|---|
| Generator | **Long** — sells at spot | Price collapse (solar middays, negative prices) |
| Retailer | **Short** — buys at spot, sells at fixed tariffs | Spikes |
| Gentailer (AGL, Origin) | Both, internally netted | Whichever side is unbalanced |
| Large industrial (smelters) | **Short** — huge fixed load | Spikes |
| Battery | Both — cares about the *spread* | Spreads narrowing |
| Banks / prop traders | Financial only | Being wrong |
| **AEMO** | **None** | n/a — clearing house, not a player |

### The hedge, worked

SnowyCo (100 MW generator, NSW) and BrightRetail (100 MW of load, NSW). Over one hour = 100 MWh.

**Unhedged** — perfectly mirrored exposure:

| NSW spot | SnowyCo earns | BrightRetail pays |
|---:|---:|---:|
| $10.65 | $1,065 | $1,065 |
| $65.50 | $6,550 | $6,550 |
| $15,000 | $1,500,000 | $1,500,000 |

**Hedged** with a swap: 100 MW at **$80/MWh**, cash-settled against spot. Above $80 the generator
pays the retailer the difference; below $80 the retailer pays the generator.

| NSW spot | Snowy pool | Snowy swap | **Net** | Bright pool | Bright swap | **Net** |
|---:|---:|---:|---:|---:|---:|---:|
| $10.65 | $1,065 | +$6,935 | **$8,000** | −$1,065 | −$6,935 | **−$8,000** |
| $65.50 | $6,550 | +$1,450 | **$8,000** | −$6,550 | −$1,450 | **−$8,000** |
| $15,000 | $1,500,000 | −$1,492,000 | **$8,000** | −$1,500,000 | +$1,492,000 | **−$8,000** |

Both locked at $80/MWh regardless of spot.

**The electricity never moved.** Physical dispatch is identical; AEMO has no idea the contract
exists. The contract market and the spot market are mechanically separate.

### Volume risk — how companies actually fail

The hedge covers **price**, not **volume**. Rerun the $15,000 spike with SnowyCo's turbine tripped:

```
Pool revenue:      $0          (nothing to sell)
Swap obligation:  -$1,492,000  (still owed in full)
Net:              -$1,492,000
```

Short 100 MW at $15,000/MWh with no generation behind it. This is roughly how several retailers
died in the 2022 crisis. The mirror kills retailers: hedged for 100 MW, customers draw 130 MW on a
40 °C day, the extra 30 MW bought unhedged at spike prices.

**This explains Eraring's −$983 band.** A contracted unit bids near the floor to make dispatch
essentially guaranteed. It costs nothing (it gets the clearing price anyway) and avoids being offline
while owing a CfD payout.

### Contract position drives bidding behaviour

Mechanically the futures market has **zero** effect on dispatch — NEMDE has no contract input.
Economically it is the single biggest driver of how people bid:

| Contract position | Wants spot to be | Bids |
|---|---|---|
| Uncontracted | High | Withholds capacity into high bands — keeps 100% of spike |
| Fully contracted | Indifferent to level, **must** generate | Low, even negative, to guarantee dispatch |
| Over-contracted | Low — buying back at spot | Floor, aggressively |

This is why the AER examines contract cover when assessing market power, and why vertical
integration dampens spike incentives.

### Instruments

**Exchange (ASX Energy)** — ~93% of derivative volume. Standardised, anonymous, centrally cleared
(no counterparty credit risk).

- Base load swaps (futures), peak load swaps
- **$300 caps** — seller pays buyer whatever spot exceeds $300/MWh. Insurance against spikes.
- Options on swaps — now the majority of ASX traded volume
- Regions: **NSW, VIC, QLD, SA only** — no Tasmanian futures
- Quarterly out 4 years + calendar-year and financial-year strips
- One lot = 1 MW held continuously across the period
- Cash-settled against average spot over the quarter

**OTC bilateral** — custom volume/shape/term, but each side carries the other's credit risk.
This is how PPAs are done (10–15 years, often bundled with green certificates).

**Not in MMS data at all:** LGCs, STCs, ACCUs (environmental certificates). They trade separately
and materially affect bidding.

### How the forward price is set

Nobody sets it — it is discovered in an ordinary order book (bid/offer, single price per order,
crossing). Three components:

1. **Expected spot** over the period — fundamentals: fuel, outages, new capacity, weather
2. **Risk premium** — more hedge buyers than sellers (retailer downside is unbounded at $23,200;
   generator downside is floored at −$1,000). Forwards typically sit **above** realised spot.
3. **Supply/demand for cover itself** — after a bad summer everyone wants hedges at once

Quarterly shape is strongly seasonal: Q1 (summer) carries spike risk and prices well above the mild
shoulder quarters.

### Adjacent markets

**Gas** — four separate markets, each with own data:
- **DWGM** (Victoria) — schedule-based, NEM-like
- **STTM** — day-ahead hub markets at Sydney, Brisbane, Adelaide
- **GSH** — exchange-traded physical at Wallumbilla and Moomba
- **GBB** — Gas Bulletin Board, system transparency

Gas matters to power traders because gas plant sets the electricity price in tight periods.

**WEM** (Western Australia) — separate grid, capacity mechanism plus real-time energy and Essential
System Services (ESSM) dispatch post-reform.

---

## 4. The data landscape

Base URL: **`https://nemweb.com.au`** — plain directory listings of zipped CSVs. No API key, no
registration.

> **Currency warning:** AEMO retired the old HTTP endpoint in April 2026 — use HTTPS. Separately,
> participant-facing APIs move off port 9319 to standard 443 (production 23 Sep 2026, legacy
> decommissioned 1 Dec 2026). Any tutorial or repo older than 2026 will have stale URLs.

### Three archives

| Archive | Path | Covers | Grain | Use for |
|---|---|---|---|---|
| **CURRENT** | `/Reports/Current/` | ~24–48 h | one file per 5 min | live monitoring |
| **ARCHIVE** | `/Reports/Archive/` | 13 months | daily zips (nested) | recent backfill |
| **MMSDM** | `/Data_Archive/Wholesale_Electricity/MMSDM/` | 2009 → last month | monthly, per table | history, backtesting |

[verified] `/Reports/Current/` holds **103 report folders**; MMSDM monthly holds **234 tables**.

Same data often appears under different names — SCADA generation is `DISPATCH_UNIT_SCADA` in MMSDM
but `UNIT_SCADA` in the live feed.

### Filename convention

```
PUBLIC_<REPORT>_<YYYYMMDDHHMM>_<sequence>.zip
PUBLIC_DISPATCHIS_202609090055_0000000536812563.zip
```

The monotonic sequence number is the reliable ordering key. Extensions are uppercase (`.CSV`, `.ZIP`).

---

## 5. The AEMO file format

One file contains **several tables** with different shapes. Column 0 is the row type.

```
C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,2026/09/09,00:50:09,0000000536812563,DISPATCHIS,...
I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP,EEP,ROP,...
D,DISPATCH,PRICE,5,"2026/09/09 00:55:00",1,NSW1,202609090011,0,65.5,0,65.5,...
D,DISPATCH,PRICE,5,"2026/09/09 00:55:00",1,QLD1,202609090011,0,56.39502,0,56.39502,...
I,DISPATCH,REGIONSUM,9,SETTLEMENTDATE,RUNNO,REGIONID,...,TOTALDEMAND,AVAILABLEGENERATION,...
D,DISPATCH,REGIONSUM,9,"2026/09/09 00:55:00",1,NSW1,...,7447.63,11053.18453,...
C,"END OF REPORT",1123
```

| Row | Meaning |
|---|---|
| `C` | **Control.** First row = manifest. Last row = `END OF REPORT` + row count (verify it). |
| `I` | **Information.** Column names for the table that follows. A new `I` = a new table *in the same file*. |
| `D` | **Data.** Fields align to the most recent `I` above. |

On `I`/`D` rows, columns 1–3 are `(report, subreport, version)` — e.g. `DISPATCH, PRICE, 5` — and
**payload starts at column 4**.

### Parsing rules

1. **Pin to the `I` row, never fixed column positions.** The version number increments when AEMO
   adds columns, which they do regularly.
2. **Use a real CSV reader.** `REBIDEXPLANATION` contains commas and quotes; `split(',')` silently
   shifts every field after it.
3. Header and footer have a different column count from the body — this upsets strict CSV libraries.

A working parser is in `aemo.py` (~60 lines, stdlib only).

---

## 6. Tables that matter

234 tables exist; roughly twelve carry most analysis.

| Table | Grain | Contents |
|---|---|---|
| `DISPATCHPRICE` | region × 5 min | **Spot price (`RRP`) + all 10 FCAS prices.** Most-used table. |
| `DISPATCHREGIONSUM` | region × 5 min | Demand, available/dispatched generation, net interchange |
| `DISPATCHLOAD` | unit × 5 min | Per-unit dispatch target, ramp limits, FCAS enablement |
| `DISPATCH_UNIT_SCADA` | unit × 5 min | **Actual** metered output (vs target) |
| `DISPATCHINTERCONNECTORRES` | link × 5 min | Flow, losses, limits, marginal value |
| `DISPATCHCONSTRAINT` | constraint × 5 min | Which constraints bound — explains weird prices |
| `BIDDAYOFFER_D` | unit × day | 10 **price** bands + rebid explanations |
| `BIDPEROFFER_D` | unit × 5 min | 10 **volume** bands — join to above |
| `DUDETAILSUMMARY` | unit (SCD) | Region, loss factors, registration |
| `P5MIN_REGIONSOLUTION` | run × interval | Rolling 1-hour-ahead forecast, refreshed 5 min |
| `PREDISPATCHPRICE` | run × interval | 24–48 h forecast, refreshed 30 min |
| `ROOFTOP_PV_ACTUAL` | region × 30 min | Behind-the-meter solar (modelled, not metered) |

### Data volumes [verified]

```
DISPATCHIS (one 5-min file)      1,123 rows,   7 tables
DISPATCHPRICE (one month)       44,640 rows  = 5 regions x 288 x 31 days exactly
BIDMOVE_COMPLETE (one day)     653,825 rows, 128 MB uncompressed
  of which BIDPEROFFER_D       651,552
  of which BIDDAYOFFER_D         2,269
```

Bid history runs to terabytes because rebidding resubmits the whole day. Prefer the `_D`
(deduplicated) variants and store as Parquet.

---

## 7. Identifiers and time

### Unit hierarchy

| Level | Notes |
|---|---|
| `PARTICIPANTID` | Legal entity. Companies routinely hold several. |
| `STATIONID` | Physical power station |
| **`DUID`** | **Dispatchable unit — the market-facing key.** Join column for almost everything. |
| `GENSETID` | Physical sub-units. Rarely needed. |

DUIDs can contain `/` and `#`, which breaks shell globs and naive path handling.

Reference tables are **slowly-changing** — join on `EFFECTIVEDATE` and `VERSIONNO`, not just the key,
or you will attach a 2014 loss factor to 2026 output.

### Time

1. **Timestamps mark the END of the interval.** `00:55:00` = the period 00:50→00:55.
2. **Market time is UTC+10 year-round** — effectively Brisbane, **no daylight saving**, even for
   Victorian and Tasmanian data. Never localise to `Australia/Sydney`.
3. **Forecast tables are bitemporal**: `RUN_DATETIME` (when made) and `INTERVAL_DATETIME` (what it
   forecasts). Every backtest must filter on both or you leak the future.
4. **The trading day runs 04:05 → 04:00 next calendar day** [verified — first interval of trading day
   2026/09/07 is `04:05:00`], not midnight-to-midnight. Matters for daily aggregation.

---

## 8. Traps

Each of these has burned someone.

**`INTERVENTION`** — when AEMO intervenes, intervals appear twice. Use `INTERVENTION=0` for
**prices**, highest intervention value for **physical quantities**. Getting it backwards corrupts
revenue on exactly the high-price intervals that matter most.

**Loss factors and the bid limits** — dispatch volumes *and bid prices* are at the connection point;
settlement prices are at the regional reference node. The real bid limits are `MPC / MLF` and
`FLOOR / MLF`, **per unit**. [verified]:

| Unit | Band 10 | Band 1 | Implied MLF |
|---|---:|---:|---:|
| PIBESS1 | $24,165.12 | −$1,041.60 | 0.96006 |
| HVWWPV1 | $24,099.71 | −$1,038.79 | 0.96267 |
| ADPPV1 | $24,002.79 | −$1,034.61 | 0.96655 |
| ER01 | $22,759.75 | −$983.10 | ~1.019 |

Both ratios land on the *same* number per unit — that is the proof. A unit with MLF 0.96 legitimately
bids **above** $23,200 and it is not a breach. Multiply by MLF before comparing revenue across regions.

**Rooftop solar** — modelled as **negative demand**, not generation. Omit it and you misstate a
region's solar share by ~3×. Also 30-minute (needs upsampling) and comes in several estimation
methods that duplicate rows.

**Interconnector sign** — positive means flow **away from Tasmania** along TAS→VIC→NSW→QLD, and
VIC→SA. It is *not* "north is positive". Check per link.

**Negative prices** — legitimate and frequent (South Australia sees them most days). Do not clip,
log, or winsorise. For some assets a handful of extreme intervals drive most annual revenue.

**Schema drift** — column counts and order change between MMSDM releases. Read names from the `I`
row every time. Bid tables mix millisecond/second timestamp precision and occasionally lowercase enums.

**FCAS in bid data** — energy and all 10 FCAS products share the bid tables. Filter
`BIDTYPE='ENERGY'` or volumes will be several times too large.

**`DIRECTION` in bid data** — batteries submit separate `GEN` and `LOAD` ladders. Group by
`(DUID, DIRECTION)`, not `DUID`, or you will conclude price bands change intraday when they do not.

**Overlapping sources** — the same interval appears in dispatch, P5MIN and predispatch. Deduplicate
with source priority (actual > P5MIN > predispatch) and by latest `LASTCHANGED`. Monthly files also
overlap by one interval.

---

## 9. Extraction pipeline

For a website visualisation you need two paths: a **one-off historical backfill** and a **live
top-up**.

### 9.1 Historical backfill — MMSDM

One file per table per month. URL pattern [verified working]:

```
https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/{YYYY}/MMSDM_{YYYY}_{MM}/
  MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_ARCHIVE%23{TABLE}%23FILE01%23{YYYYMM}010000.zip
```

Concrete example (1.9 MB, 44,640 rows):

```
https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/2026/MMSDM_2026_01/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_ARCHIVE%23DISPATCHPRICE%23FILE01%23202601010000.zip
```

Note `%23` is a URL-encoded `#`. **Do not unescape it** — and quote it carefully in shells, where `#`
starts a comment.

```python
#!/usr/bin/env python3
"""Backfill DISPATCHPRICE history from MMSDM into Parquet."""
from aemo import fetch, read_zip
import pandas as pd, pathlib

BASE = "https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM"
OUT  = pathlib.Path("data/raw"); OUT.mkdir(parents=True, exist_ok=True)

def month(table: str, year: int, mth: int) -> pd.DataFrame:
    url = (f"{BASE}/{year}/MMSDM_{year}_{mth:02d}/MMSDM_Historical_Data_SQLLoader/"
           f"DATA/PUBLIC_ARCHIVE%23{table}%23FILE01%23{year}{mth:02d}010000.zip")
    tables = read_zip(fetch(url))
    return pd.DataFrame(next(iter(tables.values())))

for year in range(2015, 2027):
    for mth in range(1, 13):
        dest = OUT / f"dispatchprice_{year}{mth:02d}.parquet"
        if dest.exists():
            continue
        try:
            df = month("DISPATCHPRICE", year, mth)
        except Exception as e:            # month not published yet
            print(f"skip {year}-{mth:02d}: {e}"); continue
        # keep only what a price chart needs -- 66 cols -> 4
        df = df.loc[df.INTERVENTION == "0", ["SETTLEMENTDATE", "REGIONID", "RRP", "RAISEREGRRP"]]
        df["SETTLEMENTDATE"] = pd.to_datetime(df.SETTLEMENTDATE, format="%Y/%m/%d %H:%M:%S")
        df["RRP"] = df.RRP.astype("float32")
        df.to_parquet(dest, index=False)
        print(f"{year}-{mth:02d}: {len(df):,} rows")
```

**Sizing:** ~44,640 rows/month → ~536k rows/year → ~5.9M rows for 11 years. Trivial as Parquet
(low tens of MB), painful as CSV.

### 9.2 Live top-up — CURRENT

Poll `/Reports/Current/DispatchIS_Reports/` every 5 minutes. Already implemented in `aemo.py`:

```python
from aemo import latest
prices = latest("DispatchIS_Reports")["DISPATCH.PRICE"]
```

**Polling etiquette:**
- New file appears ~30–60 s after the interval ends. Poll at `interval_end + 90s`.
- Track the **sequence number** from the filename; skip files you have seen.
- Cache the directory listing briefly — do not re-fetch it per file.
- Set a real `User-Agent`. Retry with backoff; the endpoint occasionally 503s.
- Never hammer it — one request per 5 min is all you need.

### 9.3 Recommended flow

```
MMSDM monthly ──┐
                ├──> raw parquet ──> dedupe ──> aggregate tiers ──> JSON for the browser
CURRENT 5-min ──┘                                                     (or an API)
```

Run backfill once. Run the live poller on a cron/worker. Rebuild aggregates incrementally.

### 9.4 Ready-to-run implementation

`build_viz_data.py` in this directory implements all of the above — **standard library only**, no
pandas required. It handles the `INTERVENTION` filter, the timestamp shift, interval-count
validation and columnar JSON output.

```bash
python3 build_viz_data.py 2026-01 2026-06    # backfill a month range (cached on disk)
python3 build_viz_data.py --live             # print the latest dispatch interval
```

Verified run:

```
2026-01 ... 44,640 rows
2026-02 ... 40,320 rows
2026-03 ... 44,640 rows
total 129,600 intervals
  wrote web/price_daily.json    90 buckets   14 KB
  wrote web/price_hourly.json 2,160 buckets  341 KB
```

Output shape — columnar, aligned to a shared `t` array:

```json
{"grain":"day","t":["2026-01-01", ...],
 "regions":{"SA1":{"median":[-7.0, ...],"min":[-325.0, ...],"max":[44.7, ...],
                   "mean":[-26.0, ...],"pct_negative":[52.4, ...]}, ...}}
```

---

## 10. Aggregation

This is where most people introduce silent errors.

### 10.1 Deduplicate FIRST

Before any aggregation:

```python
df = df[df.INTERVENTION == "0"]                        # prices only
df = df.sort_values("LASTCHANGED").drop_duplicates(     # latest version wins
        subset=["SETTLEMENTDATE", "REGIONID"], keep="last")
```

Aggregating before deduplicating double-counts intervention intervals — which are exactly the
extreme ones.

### 10.2 The timestamp shift — off-by-one

`SETTLEMENTDATE` is the interval **end**. An interval stamped `2026/09/08 00:00:00` covers
23:55→00:00 and belongs to **7 September**, not the 8th. Truncating the raw timestamp puts it in the
wrong day.

```python
# shift back into the interval before bucketing
df["interval_start"] = df.SETTLEMENTDATE - pd.Timedelta(minutes=5)
df["hour"]  = df.interval_start.dt.floor("h")
df["date"]  = df.interval_start.dt.date
```

**Trading day vs calendar day.** AEMO's own daily figures use the trading day (04:05 → 04:00). For a
public website a calendar day is usually more intuitive — just be consistent and say which you used.

```python
df["trading_day"] = (df.interval_start - pd.Timedelta(hours=4)).dt.date
```

### 10.3 Averaging prices correctly

**All 5-minute intervals are equal length, so the time-weighted average is simply the arithmetic
mean.** No weighting needed — *as long as you stay post-October-2021.*

```python
hourly = df.groupby(["REGIONID", "hour"], as_index=False).agg(
    rrp_mean = ("RRP", "mean"),
    rrp_min  = ("RRP", "min"),
    rrp_max  = ("RRP", "max"),
    rrp_p50  = ("RRP", "median"),
    n        = ("RRP", "size"),          # sanity: should be 12
)
```

Always keep `n`. If it is not 12 per hour (or 288 per day) you have gaps or duplicates.

**If your history spans October 2021**, pre-5MS settlement intervals are 30 minutes. Weight by
duration or your long-run averages will be subtly wrong:

```python
df["minutes"] = 5      # or 30 for pre-Oct-2021 rows
twa = (df.RRP * df.minutes).sum() / df.minutes.sum()
```

**Mean vs median diverge violently here.** In a spiky month the mean can be double the median. Report
both — the median is "a typical price", the mean is "what you actually paid". For a chart, plotting
the median as the line and the min/max as a band reads far better than the mean alone.

**Volume-weighted is different again.** For "what did a generator earn", you need VWAP, not mean:

```python
vwap = (df.RRP * df.MW).sum() / df.MW.sum()
```

A solar farm's realised price is always below the simple average because it only generates when the
sun (and everyone else's solar) is pushing prices down. This gap is a real and important effect —
never present `mean(RRP)` as what a generator received.

### 10.4 Worked validation on real data [verified]

Running the recipe above over `DISPATCHPRICE` for January 2026 (44,640 rows):

```
intervals per hour  : {12}          <- correct
intervals per day   : [288]         <- correct
naive day bucketing : [1, 287, 288] <- off-by-one leaks a day at each boundary
```

The `n` check catches the timestamp bug immediately: bucketing on the raw `SETTLEMENTDATE`
produces days with 287 and 1 intervals. Bucketing on `interval_start` gives a clean 288.

And the mean/median divergence, same month:

| Region | mean | median | max | % intervals negative |
|---|---:|---:|---:|---:|
| NSW1 | $67.22 | $57.06 | $11,938.05 | 8.6% |
| QLD1 | $64.03 | $62.95 | $19,727.85 | 9.8% |
| **SA1** | **$152.25** | **$29.05** | $20,300.00 | **33.1%** |
| TAS1 | $100.93 | $104.32 | $20,300.00 | 0.4% |
| VIC1 | $38.55 | $19.18 | $3,026.01 | 28.7% |

South Australia's mean is **5.2× its median**. A typical SA interval in January cost $29; the
average cost $152. Both numbers are true and they describe completely different things — this is
exactly why a chart showing only the mean misleads, and why a median line with a min/max band is
the honest default.

Note SA1 and TAS1 both topped out at exactly **$20,300.00** — the FY2025-26 market price cap.
January 2026 falls in FY2025-26; the cap rose to $23,200 on 1 July 2026. If your chart spans a
financial-year boundary, the ceiling moves.

Also note VIC1 and SA1 spent **~30% of January at negative prices**. Any visualisation that cannot
render negative values is unusable for those regions.

At daily grain the effect is starker still — South Australia, 1 January 2026 [verified]:

| Date | median | mean | min | max | % negative |
|---|---:|---:|---:|---:|---:|
| 2026-01-01 | −$7.00 | **−$26.00** | −$325.00 | $44.70 | **52.4%** |
| 2026-01-04 | $0.00 | −$14.01 | −$289.44 | $92.43 | 50.0% |

A **negative daily average price** — SA generators collectively paid to produce, across a whole day.
If your y-axis starts at zero, these days vanish entirely.

### 10.5 Aggregate tiers

Precompute; do not aggregate on request.

| Tier | Grain | Retain | Rows/year (5 regions) |
|---|---|---|---|
| raw | 5 min | 7 days | 525,600 |
| half-hourly | 30 min | 90 days | 87,600 |
| hourly | 1 h | 2 years | 43,800 |
| daily | 1 day | full history | 1,825 |

```python
TIERS = {"30min": "30min", "1h": "h", "1d": "D"}
for name, freq in TIERS.items():
    out = (df.set_index("interval_start")
             .groupby("REGIONID")
             .resample(freq)
             .agg(mean=("RRP","mean"), p50=("RRP","median"),
                  lo=("RRP","min"), hi=("RRP","max"), n=("RRP","size"))
             .reset_index())
    out.to_parquet(f"data/agg/price_{name}.parquet", index=False)
```

### 10.6 Derived series worth precomputing

| Series | Definition | Why it's interesting |
|---|---|---|
| Negative-price share | `% intervals RRP < 0` per day/region | The renewables story, rising fast |
| Spike count | `# intervals RRP > $300` | Cap-contract relevance |
| Daily spread | `max − min` within a day | Battery arbitrage opportunity |
| Duck-curve profile | mean RRP by time-of-day | The single most legible chart in energy |
| Volatility | rolling stdev of log-ish price | Hedging demand |

---

## 11. Building the visualisation

### 11.1 Scale is the whole problem

Prices span **−$1,000 to +$23,200**. Neither a linear nor a log axis works:

- **Linear** — one $15,000 spike flattens an entire year into a baseline smear
- **Log** — mathematically impossible; negative prices have no logarithm

Options, in order of preference:

1. **Symlog / piecewise axis** — linear near zero (say −$100 to $300), log above. Handles the full
   range honestly. This is what the artifact's bid-stack chart does with a broken axis.
2. **Clip the view, annotate the truth** — plot clipped at the 99th percentile and label the real
   maximum on the outlier (`↑ $15,240`). Legible, and does not lie.
3. **Two linked charts** — a normal-range chart plus a separate spike-frequency chart.

**Never clip the underlying statistics** — only the visual range. Clipping the data destroys the
economics.

### 11.2 Colour

Price sign is genuinely meaningful here, so a **diverging scale centred on zero** is the correct
encoding, not a decorative choice:

```
negative  <-- blue --  $0  -- warm -->  positive  -- deep red -->  spike
```

Do not use a sequential scale from the minimum; it hides the zero crossing, which is the single most
important threshold in the dataset.

### 11.3 Payload

| Grain | Rows/year | JSON/year | Notes |
|---|---|---|---|
| 5 min × 5 regions | 525,600 | ~25 MB | Too big — never ship |
| hourly × 5 regions | 43,800 | **1.35 MB** [measured] | Fine gzipped for 1–2 years |
| daily × 5 regions | 1,825 | **58 KB** [measured] | Trivial — ship the lot |

Measured by running `build_viz_data.py` over Jan–Mar 2026 (129,600 intervals) and extrapolating:
90 days of daily buckets = 14 KB, 2,160 hourly buckets = 341 KB. Both carry five series per region
(median, min, max, mean, % negative).

Ship **daily by default**, fetch finer grain on zoom. Use columnar JSON (arrays per field, not an
array of objects) — it roughly halves the payload:

```json
{"t":[1757376000,1757462400],"nsw":[65.5,71.2],"vic":[10.65,22.4]}
```

### 11.4 Charts that actually say something

| Chart | Why |
|---|---|
| **Duck curve** — mean price by time of day, one line per region | Instantly shows the solar-driven midday collapse and evening peak. The most legible chart in energy. |
| **Price duration curve** — sorted descending, price vs % of time | Shows that ~1% of intervals carry most of the revenue. Explains the whole market. |
| **Negative-price share over time** | The renewables transition in one line |
| **Regional spread** — NSW vs VIC vs SA on one axis | Shows interconnector constraints binding |
| **Daily min/max band with median line** | Handles spikes gracefully; shows volatility without distortion |

Avoid a raw 5-minute time series across a year. It is 105,000 points per region and communicates
nothing but noise.

### 11.5 Attribution

The data is public and free to use, but AEMO's terms require attribution. Add a line such as:

> Source: AEMO NEMWeb dispatch data. AEMO does not endorse this analysis.

---

## 12. Verified facts reference

Everything below was measured from live data on 9 September 2026, not quoted.

| Fact | Value |
|---|---|
| Report folders in `/Reports/Current/` | 103 |
| Tables in MMSDM monthly archive | 234 |
| Rows in one DISPATCHIS file | 1,123 across 7 tables |
| `DISPATCHPRICE` rows, Jan 2026 | 44,640 (= 5 × 288 × 31 exactly) |
| Fields in `DISPATCHPRICE` | 66 |
| `BIDMOVE_COMPLETE` one day | 653,825 rows / 128 MB |
| Participants bidding (7 Sep) | 261 |
| Units bidding ENERGY | 507 (569 across all products) |
| Bidirectional (battery) units | 66 → 573 total ladders |
| Ladders whose prices changed intraday | **0 of 573** |
| Max rebid frequency | 288/day (batteries) |
| Median rebid frequency | 1/day |
| Market Price Cap FY2026-27 | $23,200/MWh |
| Market Floor | −$1,000/MWh |
| Cumulative Price Threshold | $2,225,900 / 7 days |
| Highest band-10 offer observed | $24,165.12 (PIBESS1, MLF 0.96006) |
| Lowest band-1 offer observed | −$1,041.60 (same unit) |
| Trading day boundary | 04:05 → 04:00 |
| Spot prices, 2026-09-09 00:55 | NSW 65.50 / QLD 56.40 / SA 101.02 / TAS 28.71 / VIC 10.65 |

### Tooling

| Tier | Option |
|---|---|
| Raw | NEMWeb + `aemo.py` (this directory) |
| Open source | `NEMOSIS` (historical actuals, bids, SCADA), `NEMSEER` (forecasts, PASA) — both UNSW |
| Commercial | IES **NEOpoint** — hosted full history of NEM/gas/weather, hundreds of prebuilt reports, REST API returning CSV/JSON/XML into Excel, Power BI, Python, R |

### Sources

- AEMO NEMWeb — https://nemweb.com.au
- AEMO market data — https://www.aemo.com.au/energy-systems/electricity/national-electricity-market-nem/data-nem
- MMS Data Model guide (Matthew Davis) — https://www.mdavis.xyz/mms-guide/
- A Hacker's Guide to AEMO & NEM Data — https://adgefficiency.com/blog/hackers-aemo/
- AEMC market price cap 2026-27 — https://www.aemc.gov.au/news-centre/media-releases/aemc-updates-market-price-cap-2026-27
- AER State of the Energy Market — https://www.aer.gov.au
- ASX Energy — https://www.asxenergy.com.au
- IES NEOpoint — https://iesys.com/solutions/neopoint/
- NEMOSIS — https://github.com/UNSW-CEEM/NEMOSIS
