/* ═════════════════════════════════════════════════════════════════════════════
   The ladder — a visual explainer for the NEM spot market.

   Three moving parts:
     1. MARKET   a twelve-unit stylised region and a clearing engine that behaves
                 like NEMDE does for energy: pool every band, sort by price,
                 walk up to demand, pay everyone the marginal band's price.
     2. DAY      the same engine run 288 times against a moving demand and a
                 moving amount of cheap renewable capacity.
     3. REAL     charts over real AEMO dispatch prices from web/nem_data.js.

   No dependencies. SVG is built by hand and re-rendered on resize.
   ═════════════════════════════════════════════════════════════════════════════ */

(() => {
'use strict';

const D = window.NEM_DATA;
const NS = 'http://www.w3.org/2000/svg';

/* ── formatting ───────────────────────────────────────────────────────────── */

const money = (v, dp = 2) =>
  (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-AU',
    { minimumFractionDigits: dp, maximumFractionDigits: dp });
const money0 = v => money(v, 0);
const mw = v => Math.round(v).toLocaleString('en-AU') + ' MW';
const pct = (v, dp = 1) => v.toFixed(dp) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const REGION_NAME = { NSW1: 'New South Wales', QLD1: 'Queensland', SA1: 'South Australia',
                      TAS1: 'Tasmania', VIC1: 'Victoria' };
const REGION_SHORT = { NSW1: 'NSW', QLD1: 'QLD', SA1: 'SA', TAS1: 'TAS', VIC1: 'VIC' };
/* categorical slots 1–5, fixed per region — colour follows the entity, never its rank */
const REGION_VAR = { NSW1: '--s1', SA1: '--s2', VIC1: '--s3', QLD1: '--s4', TAS1: '--s5' };
const ORDER = ['NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1'];

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const regionColour = r => cssVar(REGION_VAR[r]);

/* ── svg helpers ──────────────────────────────────────────────────────────── */

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
}
const add = (parent, tag, attrs, text) => parent.appendChild(el(tag, attrs, text));

function path(pts) {
  let d = '';
  for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
  return d;
}

/* Charts re-render at real pixel sizes so text never scales with the container. */
const RENDERERS = new Map();
function mount(host, height, draw) {
  RENDERERS.set(host, { height, draw });
  paint(host);
}
function paint(host) {
  const r = RENDERERS.get(host);
  if (!r) return;
  const w = Math.max(320, host.clientWidth || host.parentElement.clientWidth || 900);
  const h = typeof r.height === 'function' ? r.height(w) : r.height;
  host.replaceChildren();
  const svg = add(host, 'svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h,
                                 role: 'img', style: 'max-width:100%' });
  r.draw(svg, w, h);
}
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => RENDERERS.forEach((_, host) => paint(host)), 120);
});

/* ── tooltip ──────────────────────────────────────────────────────────────── */

const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.appendChild(tip);

function showTip(ev, title, rows) {
  tip.replaceChildren();
  const t = document.createElement('p');
  t.className = 'tip__title';
  t.textContent = title;
  tip.appendChild(t);
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'tip__row';
    row.innerHTML = `<span></span><b></b>`;
    row.firstChild.textContent = k;
    row.lastChild.textContent = v;
    tip.appendChild(row);
  }
  tip.hidden = false;
  const pad = 14, r = tip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tip.hidden = true; };
addEventListener('scroll', hideTip, { passive: true });

/* ═══════════════════════════ price scale ═══════════════════════════════════
   Prices run −$1,000 to $23,200. Linear flattens a year into a smear; log is
   impossible below zero. So: compressed linear on the floor, honest linear
   through the working range, log above $300, with a visible break.
   ─────────────────────────────────────────────────────────────────────────── */

const MPC = 23200, FLOOR = -1000, BREAK = 300;
const priceLabel = p => p === 0 ? '$0' : (p < 0 ? '−$' : '$') + Math.abs(p).toLocaleString('en-AU');

/**
 * y-scale for a plot spanning [top, bottom] px, fitted to the data's own range.
 *
 * The floor arm and the log arm each cost real height, so they are only spent
 * when the data actually reaches them: a series that never goes below −$100 and
 * never above $300 gets a plain linear axis over its whole plot, and one that
 * spans the full −$1,000 to $23,200 gets all three arms with a marked break.
 */
function priceScale(top, bottom, lo = FLOOR, hi = MPC) {
  const span = bottom - top;
  const useFloor = lo < -100, useLog = hi > BREAK;
  const linLo = useFloor ? -100 : Math.min(0, Math.floor(lo / 50) * 50);
  const linHi = useLog ? BREAK : Math.max(50, Math.ceil(hi / 50) * 50);

  const segs = [];
  let f0 = 0;
  if (useFloor) { segs.push({ p0: FLOOR, p1: -100, f0: 0, f1: 0.085 }); f0 = 0.085; }
  const linF1 = useLog ? f0 + (1 - f0) * 0.70 : 1;
  segs.push({ p0: linLo, p1: linHi, f0, f1: linF1 });
  if (useLog) segs.push({ p0: BREAK, p1: hi, f0: linF1, f1: 1, log: true });

  const frac = p => {
    p = clamp(p, useFloor ? FLOOR : linLo, useLog ? hi : linHi);
    for (const s of segs) {
      if (p > s.p1) continue;
      const t = s.log ? Math.log(p / s.p0) / Math.log(s.p1 / s.p0) : (p - s.p0) / (s.p1 - s.p0);
      return s.f0 + t * (s.f1 - s.f0);
    }
    return 1;
  };

  const ticks = [];
  if (useFloor) ticks.push(FLOOR);
  const step = linHi - linLo <= 200 ? 50 : 100;
  for (let v = Math.ceil(linLo / step) * step; v <= linHi + 1e-9; v += step) ticks.push(v);
  if (useLog) for (const v of [1000, 5000, 20000]) if (v <= hi) ticks.push(v);

  const f = p => bottom - frac(p) * span;
  f.ticks = [...new Set(ticks)].sort((a, b) => a - b);
  f.breakY = useLog ? bottom - ((linF1 + frac(1000)) / 2) * span : null;
  return f;
}

/** Draws the y-axis: hairline gridlines, ticks, an emphasised zero, a break glyph. */
function priceAxis(svg, y, x0, x1) {
  for (const t of y.ticks) {
    const yy = y(t);
    add(svg, 'line', { x1: x0, x2: x1, y1: yy, y2: yy,
                       class: t === 0 ? 'zeroline' : 'gridline' });
    add(svg, 'text', { x: x0 - 8, y: yy + 4, 'text-anchor': 'end', class: 'tickText' },
        priceLabel(t));
  }
  /* the break sits between the last linear tick and the first log one, clear of both */
  if (y.breakY !== null) {
    for (const dx of [-3, 2]) {
      add(svg, 'path', { d: `M${x0 + dx - 3} ${y.breakY + 4}l6 -8`, fill: 'none',
                         stroke: cssVar('--axis'), 'stroke-width': 1.4, 'stroke-linecap': 'round' });
    }
  }
}

/**
 * Direct end-labels that never collide. Dots stay on the true value; labels are
 * pushed apart and joined back by a leader line wherever one had to move, which
 * is the honest alternative to stacking labels away from their own lines.
 */
function endLabels(svg, x, items, top, bottom) {
  const H = 14;
  const rows = items.slice().sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const it of rows) { it.ly = Math.max(it.y + 4, prev + H); prev = it.ly; }
  if (rows.length && rows[rows.length - 1].ly > bottom) {
    let next = bottom + 4;
    for (let i = rows.length - 1; i >= 0; i--) { rows[i].ly = Math.min(rows[i].ly, next - H); next = rows[i].ly; }
  }
  if (rows.length && rows[0].ly < top + 4) {
    let prev2 = top - H + 4;
    for (const it of rows) { it.ly = Math.max(it.ly, prev2 + H); prev2 = it.ly; }
  }
  for (const it of rows) {
    add(svg, 'circle', { cx: x, cy: it.y, r: 4, fill: it.colour,
                         stroke: cssVar('--surface'), 'stroke-width': 2 });
    if (Math.abs(it.ly - 4 - it.y) > 2) {
      add(svg, 'path', { d: `M${x + 6} ${it.y}L${x + 11} ${it.ly - 4}`, fill: 'none',
                         stroke: it.colour, 'stroke-width': 1, opacity: 0.55 });
    }
    add(svg, 'text', { x: x + 13, y: it.ly, class: 'markLabel markLabel--strong' }, it.text);
  }
}

/** Round tick step aiming for ~6 gridlines over [lo, hi]. */
function niceStep(lo, hi, target = 6) {
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw) || 10 * mag;
}

/* ═══════════════════════════ 1. the market ═════════════════════════════════ */

/* A stylised region. Ladders are shaped after published ones; ER01's is the real
   one, taken verbatim from its 7 September 2026 offer. Capacities are chosen so
   the dispatchable fleet just covers peak demand -- which is how a real region is
   built, and why the top of the stack is reached only rarely. */
const UNITS = [
  { id: 'SUN',  name: 'Sunraysia Solar',   fuel: 'Solar', semi: true,
    bands: [[-55, 4000]] },
  { id: 'WIND', name: 'Silverton Wind',    fuel: 'Wind', semi: true,
    bands: [[-25, 1200]] },
  { id: 'ERA',  name: 'Eraring',           fuel: 'Black coal',
    bands: [[-983.10, 182], [12.98, 278], [24.57, 100], [42.08, 70], [56.42, 70], [22759.75, 50]] },
  { id: 'BAY',  name: 'Bayswater',         fuel: 'Black coal',
    bands: [[-950, 900], [17.40, 840], [36.80, 500], [61.20, 400]] },
  { id: 'VAL',  name: 'Vales Point',       fuel: 'Black coal',
    bands: [[-700, 300], [26.30, 620], [58.00, 400]] },
  { id: 'MTP',  name: 'Mt Piper',          fuel: 'Black coal',
    bands: [[21.60, 700], [47.50, 400], [74.90, 300]] },
  { id: 'SNO',  name: 'Snowy Hydro',       fuel: 'Hydro',
    bands: [[64, 500], [112, 400], [325, 400], [9500, 300]] },
  { id: 'IMP',  name: 'Victorian import',  fuel: 'Interconnector',
    bands: [[70, 600], [130, 400], [400, 200]] },
  { id: 'TAL',  name: 'Tallawarra CCGT',   fuel: 'Gas',
    bands: [[82, 350], [108, 250], [149, 200]] },
  { id: 'WAR',  name: 'Waratah Battery',   fuel: 'Battery',
    bands: [[95, 400], [185, 400]] },
  { id: 'COL',  name: 'Colongra OCGT',     fuel: 'Gas peaker',
    bands: [[295, 450], [1200, 300], [14500, 300]] },
  { id: 'DR',   name: 'Hunter smelter',    fuel: 'Demand response',
    bands: [[8000, 300]] },
];
const UNIT_BY_ID = Object.fromEntries(UNITS.map(u => [u.id, u]));
const TOTAL_CAP = UNITS.reduce((a, u) => a + u.bands.reduce((b, x) => b + x[1], 0), 0);
const ALL_PRICES = UNITS.flatMap(u => u.bands.map(b => b[0]));
const BID_LO = Math.min(...ALL_PRICES), BID_HI = Math.max(...ALL_PRICES);
const X_MAX = Math.ceil(TOTAL_CAP / 500) * 500 + 200;   /* fixed, so the axis never jumps */

/* The battery's other ladder: bid as load. Charging is negative demand — "buy
   me power if it is cheaper than this" — and it is why midday floors are rising. */
const CHARGE = { mw: 600, bid: 15 };

function buildStack(avail) {
  const steps = [];
  for (const u of UNITS) {
    const a = avail[u.id] ?? 1;
    for (const [price, cap] of u.bands) {
      const m = cap * a;
      if (m > 0.05) steps.push({ unit: u, price, mw: m });
    }
  }
  steps.sort((a, b) => a.price - b.price || a.unit.id.localeCompare(b.unit.id));
  let cum = 0;
  for (const s of steps) { s.x0 = cum; cum += s.mw; s.x1 = cum; }
  return steps;
}

/** Walk the staircase to `demand`; the band it stops on sets the price. */
function walk(steps, demand) {
  for (const s of steps) {
    if (s.x1 >= demand - 1e-9) return { price: s.price, marginal: s, unserved: 0 };
  }
  const supply = steps.length ? steps[steps.length - 1].x1 : 0;
  return { price: MPC, marginal: null, unserved: demand - supply };
}

/**
 * Clear one interval. Price-responsive load (the battery charging) is dispatched
 * to the largest volume whose resulting price still sits at or under its bid —
 * which is what a real engine does when an elastic block turns out to be marginal.
 */
function clearMarket(steps, fixedDemand, charging) {
  let charge = 0;
  if (charging && walk(steps, fixedDemand).price <= CHARGE.bid) {
    let lo = 0, hi = CHARGE.mw;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (walk(steps, fixedDemand + m).price <= CHARGE.bid) lo = m; else hi = m;
    }
    charge = lo;
  }
  const demand = fixedDemand + charge;
  const res = walk(steps, demand);
  for (const s of steps) s.dispatch = clamp(demand - s.x0, 0, s.mw);
  return { ...res, demand, fixedDemand, charge, steps };
}

function byUnit(result) {
  const rows = new Map();
  for (const s of result.steps) {
    if (!rows.has(s.unit.id)) rows.set(s.unit.id, { unit: s.unit, offered: 0, dispatched: 0, bands: [] });
    const r = rows.get(s.unit.id);
    r.offered += s.mw;
    r.dispatched += s.dispatch;
    r.bands.push(s);
  }
  for (const r of rows.values()) {
    r.revenue = r.dispatched * result.price / 12;              /* one 5-min interval */
    r.marginal = r.bands.some(b => b === result.marginal);
    r.lowest = Math.min(...r.bands.map(b => b.price));
  }
  return [...rows.values()].sort((a, b) => b.dispatched - a.dispatched || a.lowest - b.lowest);
}

/* ═══════════════════════════ ladder chart ══════════════════════════════════ */

const availability = { SUN: 1, WIND: 0.55, ERA: 1, BAY: 1, VAL: 1, MTP: 1, SNO: 1,
                       IMP: 1, TAL: 1, WAR: 1, COL: 1, DR: 1 };
const AVAIL_ROWS = [
  { id: 'SUN',  label: 'Sunraysia Solar' },
  { id: 'WIND', label: 'Silverton Wind' },
  { id: 'BAY',  label: 'Bayswater coal' },
  { id: 'IMP',  label: 'Victorian import' },
  { id: 'COL',  label: 'Colongra peaker' },
];

let demandMW = 8600;
let ladderCharging = false;
const ladderHost = document.getElementById('ladderChart');

const BASE_AV = { BAY: 1, IMP: 1, COL: 1 };
const SCENARIOS = [
  { name: 'Sunny midday',            demand:  6900, av: { ...BASE_AV, SUN: 1, WIND: 0.55 } },
  { name: 'Evening peak',            demand: 10400, av: { ...BASE_AV, SUN: 0, WIND: 0.35 } },
  { name: 'Still, hot evening',      demand: 11300, av: { ...BASE_AV, SUN: 0, WIND: 0.05 } },
  { name: 'A coal unit trips',       demand:  8500, av: { ...BASE_AV, SUN: 0, WIND: 0.35, BAY: 0 } },
  { name: 'Interconnector constrained', demand:  9800, av: { ...BASE_AV, SUN: 0, WIND: 0.35, IMP: 0 } },
  { name: 'Not enough to go round',  demand: 11300, av: { SUN: 0, WIND: 0.04, BAY: 0, IMP: 0, COL: 1 } },
];

function drawLadder(svg, w, h) {
  const m = { t: 26, r: 18, b: 46, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const x = v => x0 + (v / X_MAX) * (x1 - x0);
  const y = priceScale(y0, y1, BID_LO, BID_HI);

  const steps = buildStack(availability);
  const res = clearMarket(steps, demandMW, ladderCharging);
  updateLadderPanel(res);

  priceAxis(svg, y, x0, x1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 12, class: 'axisLabel' }, 'Offer $/MWh');

  /* x-axis: cumulative megawatts, thinned so labels never touch */
  const mwStep = [2000, 4000, 6000, 10000].find(v => (v / X_MAX) * (x1 - x0) >= 52) || 10000;
  for (let v = 0; v <= X_MAX; v += mwStep) {
    add(svg, 'line', { x1: x(v), x2: x(v), y1: y1, y2: y1 + 5, class: 'axisline' });
    add(svg, 'text', { x: x(v), y: y1 + 19, 'text-anchor': 'middle', class: 'tickText' },
        v.toLocaleString('en-AU'));
  }
  add(svg, 'line', { x1: x0, x2: x1, y1: y1, y2: y1, class: 'axisline' });
  add(svg, 'text', { x: (x0 + x1) / 2, y: y1 + 38, 'text-anchor': 'middle', class: 'axisLabel' },
      'Cumulative capacity offered, MW');

  const yZero = y(0);
  const gap = 2;                                     /* surface gap, not a stroke */

  /* bands */
  const labels = [];
  for (const s of steps) {
    const raw = x(s.x1) - x(s.x0);
    const bx = x(s.x0), bw = raw > 6 ? raw - gap : Math.max(1, raw);
    const by = y(s.price);
    const dispatched = s.dispatch > 0.05;
    const isMarg = s === res.marginal;
    const fill = isMarg ? cssVar('--marginal') : dispatched ? cssVar('--dispatched') : cssVar('--idle');
    const top = Math.min(by, yZero), bh = Math.max(2, Math.abs(by - yZero));

    /* A partly dispatched band shows the whole block washed and the cleared part
       solid. The marginal band keeps its own colour in the wash too — it is the
       price-setter, and it is usually the one barely dispatched at all. */
    const frac = clamp(s.dispatch / s.mw, 0, 1);
    if (dispatched && frac < 0.995) {
      add(svg, 'rect', { x: bx, y: top, width: bw, height: bh, rx: 2,
                         fill: isMarg ? cssVar('--marginal') : cssVar('--idle'),
                         opacity: isMarg ? 0.34 : 0.85 });
      add(svg, 'rect', { x: bx, y: top, width: Math.max(1.5, bw * frac), height: bh,
                         fill, rx: 2, opacity: 0.95 });
    } else {
      add(svg, 'rect', { x: bx, y: top, width: bw, height: bh, fill,
                         rx: 2, opacity: dispatched ? 0.95 : 0.85 });
    }

    const hit = add(svg, 'rect', { x: bx - 2, y: Math.min(top, y0), width: bw + 4,
                                   height: Math.max(24, bh), fill: 'transparent',
                                   style: 'cursor:pointer' });
    hit.addEventListener('pointermove', ev => showTip(ev, s.unit.name, [
      ['Fuel', s.unit.fuel],
      ['Offer price', money(s.price)],
      ['Band size', mw(s.mw)],
      ['Dispatched', mw(s.dispatch)],
      ['Paid', dispatched ? money(res.price) + '/MWh' : 'not dispatched'],
    ]));
    hit.addEventListener('pointerleave', hideTip);

    if (bw > 40) labels.push({ s, cx: bx + bw / 2, by, w: bw, up: s.price >= 0,
                               isMarg, dispatched });
  }

  /* staircase outline — the supply curve itself */
  const outline = [];
  for (const s of steps) { outline.push([x(s.x0), y(s.price)], [x(s.x1), y(s.price)]); }
  add(svg, 'path', { d: path(outline), fill: 'none', stroke: cssVar('--ink'),
                     'stroke-width': 1.2, opacity: 0.35, 'stroke-linejoin': 'round' });

  /* clearing price */
  const cy = y(res.price);
  add(svg, 'line', { x1: x0, x2: x1, y1: cy, y2: cy, stroke: cssVar('--marginal'), 'stroke-width': 2 });
  const chip = money(res.price);
  add(svg, 'rect', { x: x1 - chip.length * 7.4 - 14, y: cy - 20, rx: 4,
                     width: chip.length * 7.4 + 12, height: 17, fill: cssVar('--marginal') });
  add(svg, 'text', { x: x1 - 8, y: cy - 7, 'text-anchor': 'end',
                     style: `fill:${cssVar('--surface')};font-size:11.5px;font-weight:600` }, chip);

  /* demand line — draggable */
  const dx = x(res.demand);
  add(svg, 'line', { x1: dx, x2: dx, y1: y0 - 4, y2: y1, stroke: cssVar('--ink'), 'stroke-width': 2 });
  add(svg, 'circle', { cx: dx, cy: y0 - 4, r: 5, fill: cssVar('--ink'),
                       stroke: cssVar('--surface'), 'stroke-width': 2 });
  const dLabel = mw(res.demand) + (res.charge > 1 ? ' (incl. charging)' : '');
  add(svg, 'text', { x: clamp(dx + 9, x0, x1 - dLabel.length * 6.2), y: y0 + 6,
                     class: 'markLabel markLabel--strong' }, dLabel);

  /* only when there is genuinely clear space: the demand label owns the top line,
     and a high clearing price puts its own rule through the second one */
  if (x1 - dx > 210 && cy > y0 + 48) {
    add(svg, 'text', { x: (dx + x1) / 2, y: y0 + 22, 'text-anchor': 'middle', class: 'markLabel' },
        'Offered, but not needed at this demand');
  }

  /* selective direct labels: widest bands only, dropping x-overlaps */
  labels.sort((a, b) => (b.isMarg - a.isMarg) || b.w - a.w);
  const placed = [];
  for (const L of labels.slice(0, 10)) {
    const text = L.s.unit.name;
    const halfW = text.length * 3.3 + 4;
    /* A negative band sits below the zero line, so its label goes inside the bar
       when the text genuinely fits (measured, not assumed) and just above the
       zero line otherwise — where the bar's own column is empty either way. */
    const fitsInside = !L.up && 2 * halfW + 12 <= L.w;
    const ly = L.up ? L.by - 7 : fitsInside ? yZero + 15 : yZero - 7;
    if (placed.some(p => Math.abs(p.x - L.cx) < halfW + p.w && Math.abs(p.y - ly) < 12)) continue;
    placed.push({ x: L.cx, y: ly, w: halfW });
    add(svg, 'text', {
      x: clamp(L.cx, x0 + halfW, x1 - halfW), y: ly, 'text-anchor': 'middle',
      class: L.isMarg ? 'markLabel markLabel--strong' : 'markLabel',
      style: fitsInside && L.dispatched ? `fill:${cssVar('--surface')}` : null,
    }, text);
  }

  /* drag handling */
  const drag = add(svg, 'rect', { x: x0, y: y0 - 10, width: x1 - x0, height: y1 - y0 + 10,
                                  fill: 'transparent', style: 'cursor:ew-resize' });
  const set = ev => {
    const r = svg.getBoundingClientRect();
    const v = ((ev.clientX - r.left) / r.width * w - x0) / (x1 - x0) * X_MAX;
    setDemand(clamp(v, 2000, 14000));
  };
  drag.addEventListener('pointerdown', ev => { drag.setPointerCapture(ev.pointerId); set(ev); });
  drag.addEventListener('pointermove', ev => { if (ev.buttons) set(ev); });
}

function setDemand(v) {
  demandMW = Math.round(v / 25) * 25;
  const input = document.getElementById('demandInput');
  input.value = demandMW;
  document.getElementById('demandOut').textContent = mw(demandMW);
  paint(ladderHost);
}

function updateLadderPanel(res) {
  const rows = byUnit(res);
  document.getElementById('clearPrice').textContent = money(res.price);

  const note = document.getElementById('clearNote');
  if (res.marginal) {
    const m = res.marginal;
    note.textContent = `Set by ${m.unit.name}, which offered ${money(m.price)} — ` +
      `it is the last band needed, and only ${mw(m.dispatch)} of its ${mw(m.mw)} is used.`;
  } else {
    note.textContent = `Demand exceeds every offer in the region by ${mw(res.unserved)}. ` +
      `With nothing left to dispatch, the price goes to the market price cap.`;
  }

  const running = rows.filter(r => r.dispatched > 0.05);
  const dispatched = rows.reduce((a, r) => a + r.dispatched, 0);
  const cheapest = running.length ? Math.min(...running.map(r => r.lowest)) : null;
  const stats = [
    ['Dispatched', mw(dispatched)],
    ['Units running', running.length + ' of ' + UNITS.length],
    ['Cost of the interval', money0(dispatched * res.price / 12)],
    ['Cheapest offer used', cheapest === null ? '—' : money(cheapest)],
  ];
  const dl = document.getElementById('ladderStats');
  dl.replaceChildren();
  for (const [k, v] of stats) {
    const d = document.createElement('div');
    d.innerHTML = '<dt></dt><dd></dd>';
    d.firstChild.textContent = k;
    d.lastChild.textContent = v;
    dl.appendChild(d);
  }

  renderTable('ladderTable',
    ['Unit', 'Fuel', 'Lowest offer', 'Offered', 'Dispatched', 'Paid $/MWh', 'Revenue, 5 min'],
    rows.map(r => ({
      state: r.marginal ? 'marginal' : r.dispatched > 0.05 ? 'on' : 'idle',
      cells: [r.unit.name, r.unit.fuel, money(r.lowest), mw(r.offered), mw(r.dispatched),
              r.dispatched > 0.05 ? money(res.price) : '—',
              r.dispatched > 0.05 ? money0(r.revenue) : '—'],
    })));
}

function buildLadderControls() {
  const chips = document.getElementById('scenarioChips');
  SCENARIOS.forEach(sc => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = sc.name;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      Object.assign(availability, sc.av);
      [...chips.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
      syncAvailControls();
      setDemand(sc.demand);
    };
    chips.appendChild(b);
  });

  const host = document.getElementById('availControls');
  for (const row of AVAIL_ROWS) {
    const wrap = document.createElement('div');
    wrap.className = 'availRow';
    wrap.dataset.id = row.id;
    wrap.innerHTML =
      `<label for="av-${row.id}">${row.label}</label><output id="avo-${row.id}"></output>` +
      `<input type="range" id="av-${row.id}" min="0" max="100" step="5">`;
    const input = wrap.querySelector('input');
    input.value = Math.round(availability[row.id] * 100);
    input.oninput = () => {
      availability[row.id] = +input.value / 100;
      document.querySelectorAll('#scenarioChips .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      syncAvailControls();
      paint(ladderHost);
    };
    host.appendChild(wrap);
  }
  syncAvailControls();

  const di = document.getElementById('demandInput');
  di.oninput = () => setDemand(+di.value);
}

function syncAvailControls() {
  for (const row of AVAIL_ROWS) {
    const v = availability[row.id];
    const input = document.getElementById('av-' + row.id);
    if (input) input.value = Math.round(v * 100);
    const out = document.getElementById('avo-' + row.id);
    if (out) out.textContent = v === 0 ? 'off' : Math.round(v * 100) + '%';
    const wrap = document.querySelector(`.availRow[data-id="${row.id}"]`);
    if (wrap) wrap.classList.toggle('availRow--off', v === 0);
  }
}

/* ═══════════════════════════ 2. a day ══════════════════════════════════════ */

const N = 288;
/* Operational demand: what the market must serve after rooftop solar, which AEMO
   models as negative demand rather than as generation. That netting is why the
   midday trough is now half the evening peak in the solar-heavy regions. */
const DEMAND_H = [7400, 7000, 6800, 6700, 6750, 7000, 7300, 7500, 7100, 6500, 5900, 5450,
                  5250, 5200, 5350, 5800, 6600, 7700, 8900, 10400, 10100, 9400, 8600, 7900];
const SOLAR_H  = [0, 0, 0, 0, 0, 0, .04, .24, .50, .72, .88, .97, 1, .97, .88, .71, .49, .24, .05, 0, 0, 0, 0, 0];
const WIND_H   = [.58, .56, .54, .51, .48, .44, .40, .36, .33, .30, .28, .27,
                  .28, .31, .35, .41, .47, .54, .60, .64, .66, .66, .64, .61];

/** Smooth (cosine) interpolation of an hourly profile onto 288 five-minute steps. */
function profile(hourly) {
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const hf = i * 24 / N, h = Math.floor(hf), t = hf - h;
    const a = hourly[h % 24], b = hourly[(h + 1) % 24];
    out[i] = a + (b - a) * (1 - Math.cos(t * Math.PI)) / 2;
  }
  return out;
}
const DAY_DEMAND = profile(DEMAND_H), DAY_SOLAR = profile(SOLAR_H), DAY_WIND = profile(WIND_H);

let dayCharging = false;
let dayIndex = 156;
let playing = false, playTimer = null;

/** Run the model market across all 288 intervals of the day. */
function simulateDay(charging) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const av = { ...availability, SUN: DAY_SOLAR[i], WIND: DAY_WIND[i] };
    const steps = buildStack(av);
    const res = clearMarket(steps, DAY_DEMAND[i], charging);
    const cheap = steps.filter(s => s.price < 50).reduce((a, s) => a + s.mw, 0);
    out.push({ price: res.price, demand: res.demand, fixed: res.fixedDemand,
               charge: res.charge, cheap, marginal: res.marginal ? res.marginal.unit.name : 'cap' });
  }
  return out;
}
let daySim = null;

const hhmm = i => String(Math.floor(i * 5 / 60)).padStart(2, '0') + ':' + String((i * 5) % 60).padStart(2, '0');

function dayX(w) { const m = { l: 62, r: 78 }; return { x0: m.l, x1: w - m.r }; }
function timeAxis(svg, x0, x1, yb) {
  const every = [3, 6, 12].find(h => (h / 24) * (x1 - x0) >= 46) || 12;
  for (let hr = 0; hr <= 24; hr += every) {
    const xx = x0 + (hr / 24) * (x1 - x0);
    add(svg, 'line', { x1: xx, x2: xx, y1: yb, y2: yb + 5, class: 'axisline' });
    add(svg, 'text', { x: xx, y: yb + 19, 'text-anchor': 'middle', class: 'tickText' },
        String(hr).padStart(2, '0') + ':00');
  }
}

function drawDayInputs(svg, w, h) {
  const { x0, x1 } = dayX(w);
  const y0 = 26, y1 = h - 34;
  const maxMW = 12000;
  const X = i => x0 + (i / (N - 1)) * (x1 - x0);
  const Y = v => y1 - (v / maxMW) * (y1 - y0);

  for (let v = 0; v <= maxMW; v += 3000) {
    add(svg, 'line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), class: 'gridline' });
    add(svg, 'text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tickText' },
        v.toLocaleString('en-AU'));
  }
  add(svg, 'text', { x: x0 - 52, y: y0 - 12, class: 'axisLabel' }, 'MW');
  timeAxis(svg, x0, x1, y1);

  /* area: capacity offered below $50 — the cheap end of the stack */
  const area = [[X(0), Y(0)]];
  for (let i = 0; i < N; i++) area.push([X(i), Y(daySim[i].cheap)]);
  area.push([X(N - 1), Y(0)]);
  add(svg, 'path', { d: path(area) + 'Z', fill: cssVar('--s1'), opacity: 0.12 });
  add(svg, 'path', { d: path(daySim.map((d, i) => [X(i), Y(d.cheap)])),
                     class: 'serieLine', stroke: cssVar('--s1'), opacity: 0.55 });

  /* demand */
  add(svg, 'path', { d: path(daySim.map((d, i) => [X(i), Y(d.demand)])),
                     class: 'serieLine', stroke: cssVar('--ink') });

  const cur = daySim[dayIndex];
  add(svg, 'line', { x1: X(dayIndex), x2: X(dayIndex), y1: y0 - 6, y2: y1,
                     stroke: cssVar('--marginal'), 'stroke-width': 1.5 });
  for (const [v, c] of [[cur.demand, cssVar('--ink')], [cur.cheap, cssVar('--s1')]]) {
    add(svg, 'circle', { cx: X(dayIndex), cy: Y(v), r: 4.5, fill: c,
                         stroke: cssVar('--surface'), 'stroke-width': 2 });
  }
  add(svg, 'text', { x: X(N - 1) + 8, y: Y(daySim[N - 1].demand) + 4, class: 'markLabel markLabel--strong' }, 'Demand');
  add(svg, 'text', { x: X(N - 1) + 8, y: Y(daySim[N - 1].cheap) + 4, class: 'markLabel' }, 'Under $50');
  add(svg, 'text', { x: x0, y: y0 - 12, class: 'axisLabel' },
      'Capacity offered under $50/MWh (area) vs demand (line)');
}

function drawDayPrice(svg, w, h) {
  const { x0, x1 } = dayX(w);
  const y0 = 22, y1 = h - 34;
  const X = i => x0 + (i / (N - 1)) * (x1 - x0);
  const prices = daySim.map(d => d.price);
  /* always keep some negative territory on the axis so toggling the battery
     changes the line, not the frame it is read against */
  const y = priceScale(y0, y1, Math.min(-60, ...prices), Math.max(...prices));

  priceAxis(svg, y, x0, x1);
  timeAxis(svg, x0, x1, y1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 10, class: 'axisLabel' }, '$/MWh');

  /* Wash only the negative stretches. Positive is the norm and needs no colour;
     below zero is the state worth pointing at. */
  const yz = y(0);
  let run = null;
  const flush = () => {
    if (run && run.length > 1) {
      add(svg, 'path', { d: path([[run[0][0], yz], ...run, [run[run.length - 1][0], yz]]) + 'Z',
                         fill: cssVar('--neg'), opacity: 0.16 });
    }
    run = null;
  };
  for (let i = 0; i < N; i++) {
    if (prices[i] < 0) (run ||= []).push([X(i), y(prices[i])]); else flush();
  }
  flush();

  add(svg, 'path', { d: path(daySim.map((d, i) => [X(i), y(d.price)])),
                     class: 'serieLine', stroke: cssVar('--s1') });

  const cur = daySim[dayIndex];
  add(svg, 'line', { x1: X(dayIndex), x2: X(dayIndex), y1: y0 - 6, y2: y1,
                     stroke: cssVar('--marginal'), 'stroke-width': 1.5 });
  add(svg, 'circle', { cx: X(dayIndex), cy: y(cur.price), r: 5, fill: cssVar('--marginal'),
                       stroke: cssVar('--surface'), 'stroke-width': 2 });
  const lbl = money(cur.price);
  add(svg, 'text', { x: clamp(X(dayIndex) + 10, x0, x1 - lbl.length * 6.4), y: y(cur.price) - 10,
                     class: 'markLabel markLabel--strong' }, lbl);

  const hit = add(svg, 'rect', { x: x0, y: y0 - 6, width: x1 - x0, height: y1 - y0 + 6, class: 'hitRect' });
  const seek = ev => {
    const r = svg.getBoundingClientRect();
    const i = Math.round(((ev.clientX - r.left) / r.width * w - x0) / (x1 - x0) * (N - 1));
    setDayIndex(clamp(i, 0, N - 1));
  };
  hit.addEventListener('pointerdown', ev => { hit.setPointerCapture(ev.pointerId); stopPlay(); seek(ev); });
  hit.addEventListener('pointermove', ev => { if (ev.buttons) seek(ev); });
}

function setDayIndex(i) {
  dayIndex = i;
  document.getElementById('timeInput').value = i;
  document.getElementById('timeOut').textContent = hhmm(i);
  const c = daySim[i];
  document.getElementById('dayReadout').textContent =
    `${hhmm(i)} — demand ${mw(c.fixed)}${c.charge > 1 ? ` plus ${mw(c.charge)} of battery charging` : ''}, ` +
    `${mw(c.cheap)} offered under $50. Price ${money(c.price)}, set by ${c.marginal}.`;
  paint(document.getElementById('dayInputChart'));
  paint(document.getElementById('dayPriceChart'));
}

function rebuildDay() {
  daySim = simulateDay(dayCharging);
  setDayIndex(dayIndex);
}
function stopPlay() {
  playing = false;
  clearInterval(playTimer);
  document.getElementById('playBtn').textContent = 'Play the day';
}
function buildDayControls() {
  const btn = document.getElementById('playBtn');
  btn.onclick = () => {
    if (playing) return stopPlay();
    playing = true;
    btn.textContent = 'Pause';
    playTimer = setInterval(() => setDayIndex((dayIndex + 1) % N), 45);
  };
  const ti = document.getElementById('timeInput');
  ti.oninput = () => { stopPlay(); setDayIndex(+ti.value); };
  const bt = document.getElementById('batteryToggle');
  bt.onchange = () => { dayCharging = bt.checked; rebuildDay(); };
}

/* ═══════════════════════════ 3. real data ══════════════════════════════════ */

let selected = new Set(ORDER);
let duckStat = 'median';   /* the mean is spike-driven; the median shows the shape */

function drawDaily(svg, w, h) {
  const t = D.daily.t, n = t.length;
  const m = { t: 22, r: 60, b: 44, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const X = i => x0 + (i / (n - 1)) * (x1 - x0);
  const regs = ORDER.filter(r => selected.has(r));
  const solo = regs.length === 1;
  /* one region shows its full daily range, so the axis must cover min..max;
     several regions show medians only, and the axis can fit those instead */
  const seen = regs.flatMap(r => {
    const d = D.daily.regions[r];
    return (solo ? [...d.min, ...d.max] : d.median).filter(v => v !== null);
  });
  const y = priceScale(y0, y1, Math.min(...seen), Math.max(...seen));

  priceAxis(svg, y, x0, x1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 8, class: 'axisLabel' }, '$/MWh');

  const wide = x1 - x0 > 420;
  const fmt = wide ? { month: 'short', year: 'numeric' } : { month: 'short' };
  let lastTick = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!t[i].endsWith('-01') || X(i) - lastTick < (wide ? 70 : 40)) continue;
    lastTick = X(i);
    add(svg, 'line', { x1: X(i), x2: X(i), y1: y1, y2: y1 + 5, class: 'axisline' });
    add(svg, 'text', { x: clamp(X(i), x0 + (wide ? 30 : 14), x1 - 14), y: y1 + 19,
                       'text-anchor': 'middle', class: 'tickText' },
        new Date(t[i] + 'T00:00').toLocaleDateString('en-AU', fmt));
  }
  if (!wide) {
    add(svg, 'text', { x: x1, y: y1 + 34, 'text-anchor': 'end', class: 'axisLabel' },
        new Date(t[0] + 'T00:00').getFullYear());
  }
  add(svg, 'line', { x1: x0, x2: x1, y1: y1, y2: y1, class: 'axisline' });

  /* the min–max band is only legible for one region at a time */
  if (solo) {
    const r = regs[0], s = D.daily.regions[r];
    const up = [], down = [];
    for (let i = 0; i < n; i++) {
      if (s.max[i] === null) continue;
      up.push([X(i), y(s.max[i])]);
      down.unshift([X(i), y(s.min[i])]);
    }
    add(svg, 'path', { d: path(up.concat(down)) + 'Z', fill: regionColour(r), opacity: 0.12 });
    add(svg, 'text', { x: x0 + 4, y: y0 + 10, class: 'markLabel' },
        'Shaded: the day’s full range, lowest to highest five-minute price');
  }

  const ends = [];
  for (const r of regs) {
    const s = D.daily.regions[r];
    const pts = [];
    for (let i = 0; i < n; i++) if (s.median[i] !== null) pts.push([X(i), y(s.median[i])]);
    add(svg, 'path', { d: path(pts), class: 'serieLine', stroke: regionColour(r) });
    ends.push({ y: pts[pts.length - 1][1], text: REGION_SHORT[r], colour: regionColour(r) });
  }
  endLabels(svg, X(n - 1), ends, y0, y1);

  crosshair(svg, w, x0, x1, y0, y1, n, i => ({
    title: new Date(t[i] + 'T00:00').toLocaleDateString('en-AU',
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    rows: regs.map(r => [REGION_NAME[r] + ' median',
                         D.daily.regions[r].median[i] === null ? '—' : money(D.daily.regions[r].median[i])]),
  }));

  renderTable('dailyTable', ['Date', ...regs.map(r => REGION_SHORT[r] + ' median')],
    t.map((d, i) => ({ cells: [d, ...regs.map(r => D.daily.regions[r].median[i] === null ? '—'
                                                 : money(D.daily.regions[r].median[i]))] })));
}

function drawDuck(svg, w, h) {
  const m = { t: 26, r: 62, b: 44, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const regs = ORDER.filter(r => selected.has(r));
  const vals = regs.flatMap(r => D.duck[r][duckStat]);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12;
  const Y = v => y1 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (y1 - y0);
  const X = hr => x0 + (hr / 23) * (x1 - x0);

  /* a plain linear axis: an hour-of-day average has no spike to accommodate */
  const stepSize = niceStep(lo - pad, hi + pad);
  for (let v = Math.ceil((lo - pad) / stepSize) * stepSize; v <= hi + pad; v += stepSize) {
    add(svg, 'line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), class: v === 0 ? 'zeroline' : 'gridline' });
    add(svg, 'text', { x: x0 - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tickText' },
        priceLabel(Math.round(v)));
  }
  add(svg, 'text', { x: x0 - 52, y: y0 - 10, class: 'axisLabel' },
      (duckStat === 'mean' ? 'Mean' : 'Median') + ' $/MWh');
  for (let hr = 0; hr <= 23; hr += 3) {
    add(svg, 'line', { x1: X(hr), x2: X(hr), y1: y1, y2: y1 + 5, class: 'axisline' });
    add(svg, 'text', { x: X(hr), y: y1 + 19, 'text-anchor': 'middle', class: 'tickText' },
        String(hr).padStart(2, '0') + ':00');
  }
  add(svg, 'text', { x: (x0 + x1) / 2, y: y1 + 38, 'text-anchor': 'middle', class: 'axisLabel' },
      'Hour of the market day (UTC+10)');

  const ends = [];
  for (const r of regs) {
    add(svg, 'path', { d: path(D.duck[r][duckStat].map((v, hr) => [X(hr), Y(v)])),
                       class: 'serieLine', stroke: regionColour(r) });
    ends.push({ y: Y(D.duck[r][duckStat][23]), text: REGION_SHORT[r], colour: regionColour(r) });
  }
  endLabels(svg, X(23), ends, y0, y1);

  crosshair(svg, w, x0, x1, y0, y1, 24, hr => ({
    title: String(hr).padStart(2, '0') + ':00 – ' + String((hr + 1) % 24).padStart(2, '0') + ':00',
    rows: regs.map(r => [REGION_NAME[r], money(D.duck[r][duckStat][hr]) +
                         '  ·  ' + pct(D.duck[r].pct_negative[hr], 0) + ' negative']),
  }));

  renderTable('duckTable',
    ['Hour', ...regs.flatMap(r => [`${REGION_SHORT[r]} mean`, `${REGION_SHORT[r]} median`, `${REGION_SHORT[r]} % neg`])],
    Array.from({ length: 24 }, (_, hr) => ({
      cells: [String(hr).padStart(2, '0') + ':00',
              ...regs.flatMap(r => [money(D.duck[r].mean[hr]), money(D.duck[r].median[hr]),
                                    pct(D.duck[r].pct_negative[hr])])],
    })));
}

function drawPDC(svg, w, h) {
  const pctT = D.duration.pct_of_time, n = pctT.length;
  const m = { t: 24, r: 62, b: 46, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const lx = v => Math.log10(clamp(v, 0.01, 100));
  const X = v => x0 + ((lx(v) - lx(0.01)) / (lx(100) - lx(0.01))) * (x1 - x0);
  const regs = ORDER.filter(r => selected.has(r));
  const seen = regs.flatMap(r => D.duration.regions[r]);
  const y = priceScale(y0, y1, Math.min(...seen), Math.max(...seen));

  priceAxis(svg, y, x0, x1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 8, class: 'axisLabel' }, '$/MWh');
  for (const v of [0.01, 0.1, 1, 10, 100]) {
    add(svg, 'line', { x1: X(v), x2: X(v), y1: y0, y2: y1, class: 'gridline' });
    add(svg, 'text', { x: X(v), y: y1 + 19, 'text-anchor': 'middle', class: 'tickText' },
        v < 1 ? v + '%' : v + '%');
  }
  add(svg, 'line', { x1: x0, x2: x1, y1: y1, y2: y1, class: 'axisline' });
  add(svg, 'text', { x: (x0 + x1) / 2, y: y1 + 38, 'text-anchor': 'middle', class: 'axisLabel' },
      'Share of all five-minute intervals at or above this price (log scale)');

  /* $300 — the strike on a standard cap contract, and the usual definition of a spike */
  add(svg, 'line', { x1: x0, x2: x1, y1: y(300), y2: y(300), stroke: cssVar('--axis'), 'stroke-width': 1 });
  add(svg, 'text', { x: x1 - 6, y: y(300) - 7, 'text-anchor': 'end', class: 'markLabel' },
      '$300 — a spike, and the strike on a cap contract');

  const ends = [];
  for (const r of regs) {
    const s = D.duration.regions[r];
    add(svg, 'path', { d: path(s.map((v, i) => [X(pctT[i]), y(v)])),
                       class: 'serieLine', stroke: regionColour(r) });
    ends.push({ y: y(s[n - 1]), text: REGION_SHORT[r], colour: regionColour(r) });
  }
  endLabels(svg, X(pctT[n - 1]), ends, y0, y1);

  crosshair(svg, w, x0, x1, y0, y1, n, i => ({
    title: pctT[i].toFixed(pctT[i] < 1 ? 3 : 1) + '% of the time at or above',
    rows: regs.map(r => [REGION_NAME[r], money(D.duration.regions[r][i])]),
  }), i => X(pctT[i]));

  renderTiles('pdcTiles', regs.map(r => ({
    label: REGION_NAME[r],
    value: pct(D.stats[r].top1pct_revenue_share, 0),
    note: `${pct(D.stats[r].pct_negative)} of its intervals were below $0.`,
  })));

  renderTable('pdcTable', ['% of time at or above', ...regs.map(r => REGION_SHORT[r])],
    pctT.map((p, i) => ({ cells: [p.toFixed(4) + '%', ...regs.map(r => money(D.duration.regions[r][i]))] })));
}

let dayPick = 0;
function drawRealDay(svg, w, h) {
  const rec = D.days[dayPick];
  const m = { t: 24, r: 62, b: 44, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const series = ORDER.filter(r => selected.has(r)).map(r => ({ r, v: rec.regions[r] }));
  const len = Math.max(...series.map(s => s.v.length), 1);
  const X = i => x0 + (i / (len - 1)) * (x1 - x0);
  const seen = series.flatMap(s => s.v);
  const y = priceScale(y0, y1, Math.min(...seen), Math.max(...seen));

  priceAxis(svg, y, x0, x1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 8, class: 'axisLabel' }, '$/MWh');
  timeAxis(svg, x0, x1, y1);

  const ends = [];
  for (const s of series) {
    add(svg, 'path', { d: path(s.v.map((v, i) => [X(i), y(v)])),
                       class: 'serieLine', stroke: regionColour(s.r) });
    ends.push({ y: y(s.v[s.v.length - 1]), text: REGION_SHORT[s.r], colour: regionColour(s.r) });
  }
  endLabels(svg, X(len - 1), ends, y0, y1);

  crosshair(svg, w, x0, x1, y0, y1, len, i => ({
    title: hhmm(i) + ' — ' + new Date(rec.date + 'T00:00')
      .toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
    rows: series.map(s => [REGION_NAME[s.r], money(s.v[i])]),
  }));

  const peak = series.length
    ? series.reduce((a, s) => { const mx = Math.max(...s.v); return mx > a.v ? { r: s.r, v: mx } : a; },
                    { r: null, v: -Infinity })
    : { r: null, v: 0 };
  document.getElementById('realDayNote').textContent = peak.r
    ? `${rec.blurb} Highest price shown: ${money(peak.v)} in ${REGION_NAME[peak.r]}.`
    : rec.blurb;

  renderTable('realDayTable', ['Interval ending', ...series.map(s => REGION_SHORT[s.r])],
    Array.from({ length: len }, (_, i) => ({
      cells: [hhmm((i + 1) % N), ...series.map(s => money(s.v[i]))],
    })));
}

/** Shared crosshair + tooltip for the line charts. */
function crosshair(svg, w, x0, x1, y0, y1, n, get, xOf) {
  const line = add(svg, 'line', { x1: x0, x2: x0, y1: y0, y2: y1,
                                  stroke: cssVar('--axis'), 'stroke-width': 1, opacity: 0 });
  const hit = add(svg, 'rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: 'hitRect' });
  hit.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * w;
    const i = clamp(Math.round((px - x0) / (x1 - x0) * (n - 1)), 0, n - 1);
    const xx = xOf ? xOf(i) : x0 + (i / (n - 1)) * (x1 - x0);
    line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.setAttribute('opacity', 1);
    const d = get(i);
    showTip(ev, d.title, d.rows);
  });
  hit.addEventListener('pointerleave', () => { line.setAttribute('opacity', 0); hideTip(); });
}

/* ═══════════════════════════ the real bid ══════════════════════════════════ */

/* ER01 as offered for 7 September 2026 — the real ten-band ladder. */
const ER01 = [[-983.10, 182], [12.98, 278], [24.57, 100], [42.08, 70], [56.42, 70],
              [63.85, 0], [88.10, 0], [140.00, 0], [231.08, 0], [22759.75, 50]];
const ER_PRICE = 65.50;

function drawEraring(svg, w, h) {
  const m = { t: 26, r: 20, b: 46, l: 62 };
  const x0 = m.l, x1 = w - m.r, y0 = m.t, y1 = h - m.b;
  const total = ER01.reduce((a, b) => a + b[1], 0);
  const X = v => x0 + (v / (total + 40)) * (x1 - x0);
  const y = priceScale(y0, y1, Math.min(...ER01.map(b => b[0])), Math.max(...ER01.map(b => b[0])));

  priceAxis(svg, y, x0, x1);
  add(svg, 'text', { x: x0 - 52, y: y0 - 10, class: 'axisLabel' }, 'Offer $/MWh');
  const erStep = [200, 400].find(v => (v / total) * (x1 - x0) >= 52) || 400;
  for (let v = 0; v <= total; v += erStep) {
    add(svg, 'line', { x1: X(v), x2: X(v), y1: y1, y2: y1 + 5, class: 'axisline' });
    add(svg, 'text', { x: X(v), y: y1 + 19, 'text-anchor': 'middle', class: 'tickText' },
        v.toLocaleString('en-AU'));
  }
  add(svg, 'line', { x1: x0, x2: x1, y1: y1, y2: y1, class: 'axisline' });
  add(svg, 'text', { x: (x0 + x1) / 2, y: y1 + 38, 'text-anchor': 'middle', class: 'axisLabel' },
      'Cumulative MW offered by ER01');

  const yz = y(0);
  let cum = 0;
  ER01.forEach(([price, cap], idx) => {
    if (cap === 0) return;
    const bx = X(cum), bw = Math.max(2, X(cum + cap) - X(cum) - 2);
    cum += cap;
    const on = price <= ER_PRICE;
    const by = y(price);
    add(svg, 'rect', { x: bx, y: Math.min(by, yz), width: bw, height: Math.max(2, Math.abs(by - yz)),
                       fill: on ? cssVar('--dispatched') : cssVar('--idle'), rx: 2, opacity: 0.95 });
    /* negative band: label inside, just under the zero line, where there is room */
    add(svg, 'text', { x: bx + bw / 2, y: price >= 0 ? by - 7 : yz + 15, 'text-anchor': 'middle',
                       class: 'markLabel',
                       style: price < 0 ? `fill:${cssVar('--surface')}` : null }, 'Band ' + (idx + 1));
  });
  add(svg, 'text', { x: x0 + 8, y: y0 + 12, class: 'markLabel' },
      'Bands 6–9 carry a price but zero MW — held in reserve, rebiddable intraday');

  const cy = y(ER_PRICE);
  add(svg, 'line', { x1: x0, x2: x1, y1: cy, y2: cy, stroke: cssVar('--marginal'), 'stroke-width': 2 });
  add(svg, 'text', { x: x0 + 8, y: cy - 8,
                     style: `fill:${cssVar('--marginal')};font-size:11.5px;font-weight:600` },
      'NSW price that week: ' + money(ER_PRICE));
}

/* ═══════════════════════════ chrome ════════════════════════════════════════ */

function renderTiles(id, tiles) {
  const host = document.getElementById(id);
  host.replaceChildren();
  for (const t of tiles) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = '<p class="tile__label"></p><p class="tile__value"></p><p class="tile__note"></p>';
    d.children[0].textContent = t.label;
    d.children[1].textContent = t.value;
    d.children[2].textContent = t.note || '';
    host.appendChild(d);
  }
}

function renderTable(id, headers, rows) {
  const host = document.getElementById(id);
  if (!host) return;
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const hd of headers) { const th = document.createElement('th'); th.textContent = hd; thead.appendChild(th); }
  const tb = table.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    if (r.state) tr.dataset.state = r.state;
    for (const c of r.cells) tr.insertCell().textContent = c;
  }
  host.replaceChildren(table);
}

function buildRegionChips() {
  const host = document.getElementById('regionChips');
  for (const r of ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', 'true');
    b.innerHTML = '<span class="chip__dot"></span><span></span>';
    b.firstChild.style.background = regionColour(r);
    b.lastChild.textContent = REGION_NAME[r];
    b.onclick = () => {
      if (selected.has(r) && selected.size === 1) return;      /* never empty the chart */
      selected.has(r) ? selected.delete(r) : selected.add(r);
      b.setAttribute('aria-pressed', String(selected.has(r)));
      ['dailyChart', 'duckChart', 'pdcChart', 'realDayChart'].forEach(k => paint(document.getElementById(k)));
    };
    host.appendChild(b);
  }
}

function buildDuckToggle() {
  const host = document.getElementById('duckStat');
  for (const [key, label] of [['median', 'Median — the typical hour'], ['mean', 'Mean — where the money is']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === duckStat));
    b.onclick = () => {
      duckStat = key;
      [...host.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
      paint(document.getElementById('duckChart'));
    };
    host.appendChild(b);
  }
}

function buildDayChips() {
  const host = document.getElementById('dayChips');
  D.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(i === dayPick));
    b.textContent = d.title + ' · ' +
      new Date(d.date + 'T00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    b.onclick = () => {
      dayPick = i;
      [...host.children].forEach((c, j) => c.setAttribute('aria-pressed', String(j === i)));
      paint(document.getElementById('realDayChart'));
    };
    host.appendChild(b);
  });
}

function buildTableToggles() {
  for (const btn of document.querySelectorAll('[data-table]')) {
    const host = document.getElementById(btn.dataset.table);
    btn.onclick = () => {
      host.hidden = !host.hidden;
      btn.textContent = (host.hidden ? 'Show' : 'Hide') +
        (btn.dataset.table === 'ladderTable' ? ' the dispatch table' : ' the data table');
    };
  }
}

function buildIntro() {
  const sa = D.stats.SA1;
  renderTiles('introTiles', [
    { label: 'One price every', value: '5 minutes',
      note: '288 intervals a day, cleared separately for each of five regions.' },
    { label: 'Market price cap', value: '$23,200',
      note: 'Per megawatt hour. The floor is −$1,000. Both are real, and both get hit.' },
    { label: 'South Australian intervals below $0', value: pct(sa.pct_negative, 0),
      note: `In the window shown below, generators there paid to produce ${pct(sa.pct_negative, 0)} of the time.` },
    { label: 'SA revenue from its top 1% of intervals', value: pct(sa.top1pct_revenue_share, 0),
      note: 'A few hours a quarter carry almost half the money. That asymmetry is the whole game.' },
  ]);

  const from = new Date(D.meta.from + 'T00:00'), to = new Date(D.meta.to + 'T00:00');
  const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('realIntro').textContent =
    `Everything below is real dispatch data from AEMO's public NEMWeb archive: ` +
    `${D.meta.intervals.toLocaleString('en-AU')} five-minute regional reference prices covering ` +
    `${fmt(from)} to ${fmt(to)}, unsmoothed and unclipped.`;
  document.getElementById('footMeta').textContent =
    `${D.meta.intervals.toLocaleString('en-AU')} intervals, ${fmt(from)} – ${fmt(to)}. ` +
    `Aggregated from the five-minute series, not from AEMO's own summaries.`;
}

/* ═══════════════════════════ init ══════════════════════════════════════════ */

function init() {
  buildIntro();
  buildLadderControls();
  buildRegionChips();
  buildDuckToggle();
  buildDayChips();
  buildTableToggles();
  buildDayControls();

  mount(ladderHost, w => clamp(w * 0.56, 340, 460), drawLadder);
  daySim = simulateDay(dayCharging);
  mount(document.getElementById('dayInputChart'), 210, drawDayInputs);
  mount(document.getElementById('dayPriceChart'), w => clamp(w * 0.34, 240, 330), drawDayPrice);
  mount(document.getElementById('dailyChart'), w => clamp(w * 0.42, 280, 400), drawDaily);
  mount(document.getElementById('duckChart'), w => clamp(w * 0.40, 280, 380), drawDuck);
  mount(document.getElementById('pdcChart'), w => clamp(w * 0.42, 280, 400), drawPDC);
  mount(document.getElementById('realDayChart'), w => clamp(w * 0.36, 250, 340), drawRealDay);
  mount(document.getElementById('erChart'), w => clamp(w * 0.40, 280, 380), drawEraring);

  setDemand(demandMW);
  setDayIndex(dayIndex);
}

document.readyState === 'loading' ? addEventListener('DOMContentLoaded', init) : init();

})();
