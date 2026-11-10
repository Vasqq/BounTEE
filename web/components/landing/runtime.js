// @ts-nocheck
// The locked landing page's script (landing C3, Nov 6 2026), moved here unchanged except for
// its data: every value it states about the demo bounty now arrives through `update`, read
// live from the chains (R15.6). Its four parts run once per page load, in the page's order.
let started = null;

export function startLanding() {
  if (started) return started;
  const api = (() => {
/* =====================================================================
   DATA. The one mainnet demo bounty, won by an AI agent with a claim key
   (ADR-0018).
   ===================================================================== */
const X = { near: 'https://nearblocks.io/', base: 'https://basescan.org/', arb: 'https://arbiscan.io/' };
// Every value the story states about the bounty comes from the chains (R15.6), through
// `live`, which `update` fills once the app's server has read them. Until then, and for
// anything not on chain yet, a value is an en dash and a transaction is "tx pending".
const DASH = '–';
const CHAIN_EXPLORER = { Base: X.base, 'Arbitrum One': X.arb };
const live = { protocol: null, name: null, amount: DASH, min: DASH, delay: null, pauses: null, chains: null, steps: [], checked: false, claimKey: null, verdict: null, cheat: false, paidOnce: false, landed: null, verified: null, published: false };
const BOUNTY = {
  actor: 'agent', who: 'Whitehat',
  get name() { return live.name || DASH; }
};
const STEPS = ['Posted', 'Sealed', 'Checked', 'Signed', 'Paid', 'Landed', 'Verified', 'Published'];
const days = n => n == null ? DASH + ' days' : `${n === 1 ? 'one-day' : n + '-day'}`;
const chainList = () => live.chains ? (live.chains.length > 1 ? live.chains.slice(0, -1).join(', ') + ' and ' + live.chains.at(-1) : live.chains[0]) : DASH;
const all = pair => !!pair && pair[1] > 0 && pair[0] === pair[1];
// Each sentence states only what the chains show: a fact not read (or not true) of this
// bounty is left out, not asserted.
function stepsFor() {
  const t = (chain, href) => ({ chain, href });
  const ex = live.steps;
  const tx = (i, fallback) => ex[i] && ex[i].length ? ex[i] : fallback;
  return [
    { d: live.checked
        ? `The Protocol granted BounTEE the pause role on its vault on ${chainList()}, topped up pause gas, and locked ${live.amount} behind rules nobody can change.`
        : `The Protocol locks ${live.amount} behind rules nobody can change, once the posting check confirms the pause role and pause gas on ${chainList()}.`,
      tx: tx(0, [t('NEAR', X.near)]) },
    { d: live.claimKey
        ? 'The Whitehat\'s AI agent, holding only a claim key, sealed the exploit it found so only the bounty contract\'s enclave job can read it, and filed the claim. The key can claim and nothing else.'
        : 'The Whitehat seals the exploit so only the bounty contract\'s enclave job can read it, and files the claim.',
      tx: tx(1, [t('NEAR', X.near)]) },
    { d: (live.verdict === 'PAYS'
          ? `The Enclave replayed the exploit with revm against a covered chain's recent state. It took more than the ${live.min} minimum theft.`
          : `The Enclave replays the exploit with revm against a covered chain's recent state, and pays only a theft of at least the ${live.min} minimum.`) +
        (live.cheat ? ' An earlier cheat claim, passed off as theft, scored zero and nothing moved.' : ''),
      chips: [...(live.verdict === 'PAYS' ? [['ok', 'Verdict PAYS']] : []), ...(live.cheat ? [['mute', 'Cheat claim: ZERO']] : [])], tx: tx(2, [t('NEAR', X.near)]) },
    { d: `NEAR's MPC network ${ex[3] && ex[3].length ? 'signed' : 'signs'} a pause for every covered contract. Only the bounty contract can ask it to, and only after a PAYS verdict.`, tx: tx(3, [t('NEAR MPC', X.near)]) },
    { d: live.paidOnce ? `${live.amount} went to the Whitehat's account, once.` : `${live.amount} goes to the Whitehat's account, once.`, chips: live.paidOnce ? [['ok', live.amount]] : [], tx: tx(4, [t('NEAR', X.near)]) },
    { d: `The signed pauses reach ${chainList()}. Anyone can send them; nobody can change them.` + (all(live.landed) ? ' Every covered vault now reads paused.' : ''), tx: tx(5, (live.chains || []).map(c => t(c, CHAIN_EXPLORER[c] || X.near))) },
    { d: 'NEAR\'s MPC network confirms each pause in a block safe from reorganisation, and the bounty contract records it as a verified pause.', chips: live.verified ? [[all(live.verified) ? 'ok' : 'mute', `${live.verified[0]} of ${live.verified[1]} verified`]] : [], tx: tx(6, [t('NEAR', X.near)]) },
    { d: `After the ${days(live.delay)} disclosure delay the winning exploit is published, so anyone can re-run it. Until then only the Protocol can open it.`, tx: tx(7, []), pending: live.published ? null : `pending · after ${live.delay == null ? DASH : live.delay === 1 ? '1 day' : live.delay + ' days'}` }
  ];
}
const cmdFor = () => `bountee verify ${live.name ? live.protocol + '/' + live.name : '<protocol>/<name>'} --contract bounty.bountee.near --network mainnet`;
const ext = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4 2h6v6M10 2 3 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const short = h => h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
const copyIco = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M8.5 1.5h-6a1 1 0 0 0-1 1v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
const checkIco = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 6.5 2.3 2.3L9.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Everything put into HTML from the chains is escaped, attributes included.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* =====================================================================
   THE ISOMETRIC WORLD. One projection, a handful of primitives, used by
   every picture on the page.
   ===================================================================== */
const NS = 'http://www.w3.org/2000/svg';
const K = Math.cos(Math.PI / 6), S = 20;
const r2 = n => Math.round(n * 100) / 100;
const P = (x, y, z = 0) => [(x - y) * K * S, ((x + y) / 2 - z) * S];
const pp = a => a.map(q => P(...q).map(r2).join(',')).join(' ');
function E(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const M = {
  bone:  { n: 'bone',  t: '#dfe1e3', l: '#b6b7b9', r: '#8d8f90' },
  stone: { n: 'stone', t: '#414244', l: '#303132', r: '#252627' },
  graph: { n: 'graph', t: '#5b5c5e', l: '#444547', r: '#343536' },
  ok:    { n: 'ok',    t: '#4cf0a3', l: '#25bd7b', r: '#03965f' },
  clay:  { n: 'clay',  t: '#afb0b2', l: '#8f9092', r: '#6d6f71' }
};
const PANEL = '#19191a', TRACE = '#333435', TRACE_HOT = '#858688';
// face transforms: local px coordinates drawn on a plane of the world
const onTop = (x, y, z) => { const [a, b] = P(x, y, z); return `matrix(${K} .5 ${-K} .5 ${r2(a)} ${r2(b)})`; };
const onLeft = (x, y, z) => { const [a, b] = P(x, y, z); return `matrix(${K} .5 0 1 ${r2(a)} ${r2(b)})`; };   // plane y = const, faces +y
const onRight = (x, y, z) => { const [a, b] = P(x, y, z); return `matrix(${K} -.5 0 1 ${r2(a)} ${r2(b)})`; }; // plane x = const, faces +x

(function defs() {
  const d = document.getElementById('isoDefs');
  Object.values(M).forEach(m => {
    const g = E('linearGradient', { id: 'cy-' + m.n, x1: 0, x2: 1, y1: 0, y2: 0 }, d);
    [[0, m.l], [0.5, m.l], [0.5, m.r], [1, m.r]].forEach(([o, c]) => E('stop', { offset: o, 'stop-color': c }, g));
    const s = E('radialGradient', { id: 'sp-' + m.n, cx: 0.36, cy: 0.32, r: 0.75 }, d);
    [[0, m.t], [0.55, m.l], [1, m.r]].forEach(([o, c]) => E('stop', { offset: o, 'stop-color': c }, s));
  });
})();

function box(g, x, y, z, w, d, h, m, cls) {
  const G = E('g', cls ? { class: cls } : {}, g);
  const face = (pts, fill) => E('polygon', { points: pp(pts), fill, stroke: fill, 'stroke-width': 0.6, 'stroke-linejoin': 'round' }, G);
  face([[x + w, y, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x + w, y, z]], m.r);
  face([[x, y + d, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x, y + d, z]], m.l);
  face([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], m.t);
  E('polyline', { points: pp([[x, y + d, z + h], [x + w, y + d, z + h], [x + w, y, z + h]]), fill: 'none', stroke: 'rgba(255,255,255,.2)', 'stroke-width': 0.8 }, G);
  return G;
}
function cyl(g, cx, cy, z, r, h, m) {
  const [X0, Y0] = P(cx, cy, z), rx = r * 1.2247 * S, ry = r * 0.7071 * S, H = h * S;
  const G = E('g', {}, g);
  E('path', { d: `M${r2(X0 - rx)},${r2(Y0 - H)}L${r2(X0 - rx)},${r2(Y0)}A${r2(rx)},${r2(ry)} 0 0 0 ${r2(X0 + rx)},${r2(Y0)}L${r2(X0 + rx)},${r2(Y0 - H)}Z`, fill: `url(#cy-${m.n})` }, G);
  E('ellipse', { cx: r2(X0), cy: r2(Y0 - H), rx: r2(rx), ry: r2(ry), fill: m.t }, G);
  return G;
}
function sphere(g, cx, cy, z, r, m) { const [a, b] = P(cx, cy, z); return E('circle', { cx: r2(a), cy: r2(b), r: r * S, fill: `url(#sp-${m.n})` }, g); }
function pad(g, cx, cy, half, cls) {
  const h = half;
  return E('polygon', { class: cls || 'pad', points: pp([[cx - h, cy - h, 0], [cx + h, cy - h, 0], [cx + h, cy + h, 0], [cx - h, cy + h, 0]]), fill: 'none', stroke: '#444547', 'stroke-width': 1 }, g);
}
function lock(G, cx, cy, sz, color, hole) {
  E('path', { d: `M${cx - sz * .3},${cy}v${-sz * .2}a${sz * .3},${sz * .3} 0 0 1 ${sz * .6},0v${sz * .2}`, fill: 'none', stroke: color, 'stroke-width': sz * .12 }, G);
  E('rect', { x: cx - sz * .44, y: cy - sz * .02, width: sz * .88, height: sz * .64, rx: sz * .08, fill: color }, G);
  E('rect', { x: cx - sz * .05, y: cy + sz * .16, width: sz * .1, height: sz * .22, rx: sz * .05, fill: hole }, G);
}
function groundText(g, x, y, str, cls) {
  const G = E('g', { transform: onTop(x, y, 0) }, g);
  const t = E('text', { x: 0, y: 0, 'font-size': 13, fill: '#919395', 'font-weight': 500, class: cls || '' }, G);
  t.textContent = str; return t;
}

/* polyline helpers (world coordinates, on the ground) */
function route(pts, trimA = 0, trimB = 0) {
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  const along = d => { d = Math.max(0, Math.min(total, d)); for (let i = 0; i < seg.length; i++) { if (d <= seg[i] || i === seg.length - 1) { const k = seg[i] ? d / seg[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; } d -= seg[i]; } };
  const a = trimA, b = total - trimB;
  // trimmed polyline for drawing
  const out = [along(a)]; let acc = 0;
  for (let i = 0; i < seg.length - 1; i++) { acc += seg[i]; if (acc > a && acc < b) out.push(pts[i + 1]); }
  out.push(along(b));
  return { pts: out, at: f => along(a + (b - a) * Math.max(0, Math.min(1, f))) };
}
function bus(g, rt, n = 3, gap = 0.32, color = TRACE) {
  // n parallel traces along an axis-aligned route, with small vias at each end
  const G = E('g', {}, g), lines = [];
  for (let k = 0; k < n; k++) {
    const o = (k - (n - 1) / 2) * gap;
    const pts = rt.pts.map((p, i) => {
      const q = rt.pts[Math.min(i + 1, rt.pts.length - 1)], pr = rt.pts[Math.max(i - 1, 0)];
      const dx = (q[0] - pr[0]), dy = (q[1] - pr[1]);
      // offset perpendicular in world space (axis-aligned legs)
      return Math.abs(dx) > Math.abs(dy) ? [p[0], p[1] + o, 0] : [p[0] + o, p[1], 0];
    });
    lines.push(E('polyline', { points: pp(pts), fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }, G));
    [pts[0], pts[pts.length - 1]].forEach(p => { const [a, b] = P(...p); E('ellipse', { cx: r2(a), cy: r2(b), rx: 2.2, ry: 1.3, fill: color }, G); });
  }
  return { g: G, lines };
}

/* a seeded circuit field on the ground, faded at its edges */
function field(svg, g, cx, cy, R, seed, count) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const id = 'fm' + seed;
  const defs = E('defs', {}, svg);
  const [mx, my] = P(cx, cy);
  const rg = E('radialGradient', { id: id + 'g', gradientUnits: 'userSpaceOnUse', cx: mx, cy: my, r: R * S * 1.05 }, defs);
  [[0, '#fff', 1], [0.55, '#fff', 0.85], [1, '#fff', 0]].forEach(([o, c, a]) => E('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, rg));
  const mask = E('mask', { id, maskUnits: 'userSpaceOnUse', x: mx - R * S * 1.2, y: my - R * S * 1.2, width: R * S * 2.4, height: R * S * 2.4 }, defs);
  E('rect', { x: mx - R * S * 1.2, y: my - R * S * 1.2, width: R * S * 2.4, height: R * S * 2.4, fill: `url(#${id}g)` }, mask);
  const F = E('g', { mask: `url(#${id})` }, g);
  for (let i = 0; i < count; i++) {
    let x = cx + Math.round((rnd() * 2 - 1) * R * 1.1), y = cy + Math.round((rnd() * 2 - 1) * R * 1.1);
    const pts = [[x, y, 0]]; let ax = rnd() < 0.5;
    const legs = 2 + Math.floor(rnd() * 3);
    for (let l = 0; l < legs; l++) {
      const len = (2 + Math.floor(rnd() * 6)) * (rnd() < 0.5 ? -1 : 1);
      if (ax) x += len; else y += len; ax = !ax; pts.push([x, y, 0]);
    }
    const str = pp(pts);
    E('polyline', { points: str, fill: 'none', stroke: '#262728', 'stroke-width': 1 }, F);
    const end = P(...pts[pts.length - 1]);
    E('ellipse', { cx: r2(end[0]), cy: r2(end[1]), rx: 3, ry: 1.75, fill: 'none', stroke: '#353637', 'stroke-width': 1 }, F);
    if (rnd() < 0.45) E('polyline', { class: 'pulse', points: str, pathLength: 100, fill: 'none', stroke: '#858688', 'stroke-opacity': 0.55, 'stroke-width': 1.2, style: `--dur:${(5 + rnd() * 5).toFixed(1)}s;--dl:${(-rnd() * 8).toFixed(1)}s` }, F);
  }
  return F;
}

/* ---------------- objects ---------------- */
function enclave(g, cx, cy, w, h) {
  const x = cx - w / 2, y = cy - w / 2, z0 = 0.5, zt = z0 + h, inset = w * 0.14;
  const base = pad(g, cx, cy, w / 2 + 1.3);
  box(g, x - 0.6, y - 0.6, 0, w + 1.2, w + 1.2, z0, M.stone);
  box(g, x, y, z0, w, w, h, M.bone);
  const zl = z0 + h * 0.74;
  E('polyline', { points: pp([[x, y + w, zl], [x + w, y + w, zl], [x + w, y, zl]]), fill: 'none', stroke: '#717375', 'stroke-width': 1 }, g);
  // lock on the left face
  const L = E('g', { transform: onLeft(x, y + w, zt) }, g);
  lock(L, w * S * 0.5, h * S * 0.48, Math.min(w, h) * S * 0.34, '#565759', '#b6b7b9');
  // rivets on the right face
  const R = E('g', { transform: onRight(x + w, y + w, zt) }, g);
  [0.2, 0.4, 0.6, 0.8].forEach(f => E('rect', { x: w * S * f - 3, y: h * S * 0.47, width: 6, height: 2, rx: 1, fill: '#717375' }, R));
  // the display on top
  const T = E('g', { transform: onTop(x, y, zt) }, g);
  const pw = (w - 2 * inset) * S;
  E('rect', { x: inset * S, y: inset * S, width: pw, height: pw, rx: 5, fill: PANEL }, T);
  const scan = E('g', { class: 'fx', opacity: 0 }, T);
  const bars = [0, 1, 2, 3].map(i => E('rect', { x: inset * S + pw * 0.14, y: inset * S + pw * (0.26 + i * 0.15), width: 0, height: pw * 0.06, rx: 1.5, fill: '#858688' }, scan));
  const idle = E('g', { class: 'fx' }, T);
  [0, 1, 2].forEach(i => E('circle', { cx: inset * S + pw * (0.36 + i * 0.14), cy: inset * S + pw / 2, r: pw * 0.035, fill: '#444547' }, idle));
  const pays = E('text', { class: 'fx', x: inset * S + pw / 2, y: inset * S + pw / 2 + pw * 0.11, 'text-anchor': 'middle', 'font-size': r2(pw * 0.3), 'font-weight': 800, fill: '#00ec97', opacity: 0, style: 'font-family:var(--display);letter-spacing:-.02em' }, T);
  pays.textContent = 'PAYS';
  return {
    top: zt,
    set(state, prog = 0) {
      idle.setAttribute('opacity', state === 'idle' ? 1 : 0);
      scan.setAttribute('opacity', state === 'work' ? 1 : 0);
      pays.setAttribute('opacity', state === 'pays' ? 1 : 0);
      bars.forEach((b, i) => b.setAttribute('width', r2(pw * 0.72 * Math.max(0, Math.min(1, prog * 1.6 - i * 0.2)))));
      base.setAttribute('stroke', state === 'pays' ? '#00ec97' : '#444547');
    }
  };
}
/* Covered chains wear their brand colours while live. When the pause lands the block
   drains to a dim grey and the green lid closes over the mark, so a disabled contract
   reads at a glance. Colours and marks are the official ones: Base Blue and the Square
   (brand.base.org); Arbitrum One Navy Blue and Blue Shift with the all-white logomark,
   the version its guidelines give for dark grounds (Arbitrum Foundation brand kit). The
   marks are drawn unaltered; only the block around them mutes. */
const BASE_SQUARE = 'M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76C1213.51,0,1230.84,0,1244.16,6.53c12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z';
const ARB_MARK = [
  'm187.11,26.09c1.03,0,1.98.26,2.93.77l154.13,89.64c1.81,1.03,2.93,2.93,2.84,4.99l-.6,178.33c0,2.07-1.12,3.96-2.93,4.99l-154.65,88.6c-.86.52-1.89.77-2.93.77s-1.98-.26-2.93-.77L28.85,303.78c-1.81-1.03-2.93-2.93-2.84-4.99l.6-178.33c0-2.07,1.12-3.96,2.93-4.99L184.27,26.78c.86-.43,1.89-.69,2.84-.69m.09-26.09c-5.51,0-11.02,1.38-15.93,4.22L16.62,92.82C6.72,98.51.6,109.01.6,120.38l-.6,178.33c0,11.37,6.03,21.87,15.84,27.64l154.13,89.64c4.91,2.84,10.42,4.31,15.93,4.31s11.02-1.38,15.93-4.22l154.65-88.6c9.9-5.68,16.02-16.19,16.02-27.55l.6-178.33c0-11.37-6.03-21.87-15.84-27.64L203.13,4.31c-4.91-2.84-10.42-4.31-15.93-4.31h0Z',
  'm218.45,97.21h-22.56c-1.72,0-3.19,1.03-3.79,2.67l-72.67,199.16c-.52,1.29.52,2.67,1.89,2.67h22.56c1.72,0,3.19-1.03,3.79-2.67l72.67-199.16c.52-1.29-.52-2.67-1.89-2.67Zm-39.52,0h-22.56c-1.72,0-3.19,1.03-3.79,2.67l-72.59,199.08c-.52,1.29.52,2.67,1.89,2.67h22.56c1.72,0,3.19-1.03,3.79-2.67l72.59-199.08c.52-1.29-.43-2.67-1.89-2.67Zm29.28,77.15c-.6-1.81-3.19-1.81-3.79,0l-11.71,32.2c-.34.86-.34,1.89,0,2.76l32.72,89.64c.6,1.55,2.07,2.67,3.79,2.67h22.56c1.38,0,2.41-1.38,1.89-2.67l-45.46-124.6Zm84.9,124.6l-65.18-178.76c-.6-1.81-3.19-1.81-3.79,0l-11.71,32.2c-.34.86-.34,1.89,0,2.76l52.44,143.8c.6,1.55,2.07,2.67,3.79,2.67h22.56c1.46.09,2.41-1.38,1.89-2.67Z'
];
const CHAIN = {
  base: { t: '#0000ff', l: '#0000d0', r: '#0000a2', line: '#3c8aff' },
  arb:  { t: '#213147', l: '#1a2739', r: '#131d2b', line: '#1b4add' }
};
function mute(hex) {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return '#' + c.map(v => Math.round((v * 0.08 + L * 0.92) * 0.42 + 30 * 0.58).toString(16).padStart(2, '0')).join('');
}
function chainBlock(g, cx, cy, chain) {
  const C = CHAIN[chain], w = 3.4, h = 2.4, x = cx - w / 2, y = cy - w / 2;
  const base = pad(g, cx, cy, w / 2 + 0.9);
  const tints = [];
  const tint = (el, prop, c) => { el.classList.add('tint'); el.style[prop] = c; tints.push([el, prop, c, mute(c)]); return el; };
  const G = E('g', {}, g);
  const face = (pts, c) => { const f = E('polygon', { points: pp(pts), 'stroke-width': 0.6, 'stroke-linejoin': 'round' }, G); tint(f, 'fill', c); tint(f, 'stroke', c); };
  face([[x + w, y, h], [x + w, y + w, h], [x + w, y + w, 0], [x + w, y, 0]], C.r);
  face([[x, y + w, h], [x + w, y + w, h], [x + w, y + w, 0], [x, y + w, 0]], C.l);
  face([[x, y, h], [x + w, y, h], [x + w, y + w, h], [x, y + w, h]], C.t);
  E('polyline', { points: pp([[x, y + w, h], [x + w, y + w, h], [x + w, y, h]]), fill: 'none', stroke: 'rgba(255,255,255,.22)', 'stroke-width': 0.8 }, G);
  // ledger lines on the left face: blocks of a chain
  const L = E('g', { transform: onLeft(x, y + w, h) }, g);
  [0.3, 0.55, 0.8].forEach(f => tint(E('rect', { x: 8, y: h * S * f - 1, width: w * S - 16, height: 2, rx: 1 }, L), 'fill', C.line));
  // the chain's official mark on top, centred, untinted
  const T = E('g', { transform: onTop(x, y, h) }, g);
  const iw = w * S, m = iw / 2;
  if (chain === 'base') {
    const k = iw * 0.44 / 1280;
    E('path', { d: BASE_SQUARE, fill: '#ffffff', transform: `translate(${r2(m - iw * 0.22)} ${r2(m - iw * 0.22)}) scale(${k})` }, T);
  } else {
    const k = iw * 0.56 / 420.29;
    const G2 = E('g', { transform: `translate(${r2(m - 373.1 * k / 2)} ${r2(m - iw * 0.28)}) scale(${k})` }, T);
    ARB_MARK.forEach(d => E('path', { d, fill: '#ffffff' }, G2));
  }
  // the lid that clamps down when paused
  const lidY = E('g', { class: 'fx', opacity: 0, transform: 'translate(0,-26)' }, g);
  box(lidY, x + 0.2, y + 0.2, h, w - 0.4, w - 0.4, 0.42, M.ok);
  const LT = E('g', { transform: onTop(x + 0.2, y + 0.2, h + 0.42) }, lidY);
  const lw = (w - 0.4) * S;
  [0.36, 0.58].forEach(f => E('rect', { x: lw * f, y: lw * 0.24, width: lw * 0.1, height: lw * 0.52, rx: 2, fill: '#00653e' }, LT));
  return {
    top: h + 0.42,
    set(paused) {
      lidY.setAttribute('opacity', paused ? 1 : 0);
      lidY.setAttribute('transform', paused ? 'translate(0,0)' : 'translate(0,-26)');
      tints.forEach(([el, prop, live, dim]) => { el.style[prop] = paused ? dim : live; });
      base.setAttribute('stroke', paused ? '#00ec97' : '#444547');
    }
  };
}
function whitehat(g, cx, cy) {
  // a desk, a laptop facing the person, and the person seen from behind
  const dw = 4.4, dd = 2.4, dh = 1.75, x = cx - dw / 2, y = cy - dd / 2;
  const base = pad(g, cx, cy + 0.6, 3.2);
  box(g, x + 0.3, y + 0.3, 0, 0.3, 0.3, dh - 0.25, M.stone);
  box(g, x + dw - 0.6, y + 0.3, 0, 0.3, 0.3, dh - 0.25, M.stone);
  box(g, x + 0.3, y + dd - 0.6, 0, 0.3, 0.3, dh - 0.25, M.stone);
  box(g, x + dw - 0.6, y + dd - 0.6, 0, 0.3, 0.3, dh - 0.25, M.stone);
  box(g, x, y, dh - 0.25, dw, dd, 0.25, M.graph);
  // laptop: base slab and a screen standing on the back edge, facing +y
  const lx = x + 0.9, ly = y + 0.5, lw = 2.6, ld = 1.6;
  box(g, lx, ly, dh, lw, ld, 0.1, M.bone);
  box(g, lx, ly - 0.08, dh + 0.1, lw, 0.08, 1.65, M.bone);
  const scr = E('g', { transform: onLeft(lx, ly, dh + 1.75) }, g);
  E('rect', { x: 3, y: 3, width: lw * S - 6, height: 1.65 * S - 6, rx: 2, fill: PANEL }, scr);
  [[0.1, 0.5], [0.1, 0.32], [0.18, 0.44], [0.18, 0.26], [0.1, 0.38]].forEach(([a, b], i) => E('rect', { x: lw * S * a, y: 8 + i * 5, width: lw * S * b, height: 2, rx: 1, fill: i === 3 ? '#00ec97' : '#646567' }, scr));
  // the person, standing at the +y side, back to us
  const px = cx + 0.9, py = y + dd + 1.15;
  cyl(g, px, py, 0, 0.42, 1.5, M.stone);         // legs
  cyl(g, px, py, 1.5, 0.72, 1.55, M.clay);        // body
  sphere(g, px, py, 3.55, 0.56, M.clay);          // head
  return { pad: base };
}
function agentUnit(g, cx, cy) {
  const w = 2.6, h = 3.3, x = cx - w / 2, y = cy - w / 2;
  const base = pad(g, cx, cy, 2.4);
  box(g, x - 0.3, y - 0.3, 0, w + 0.6, w + 0.6, 0.3, M.stone);
  box(g, x, y, 0.3, w, w, h, M.graph);
  const R = E('g', { transform: onRight(x + w, y + w, 0.3 + h) }, g);
  for (let i = 0; i < 6; i++) E('rect', { x: 9, y: 12 + i * 7, width: w * S - 18, height: 2.2, rx: 1, fill: '#2b2c2d' }, R);
  const L = E('g', { transform: onLeft(x, y + w, 0.3 + h) }, g);
  E('rect', { x: 8, y: 10, width: w * S - 16, height: 14, rx: 3, fill: PANEL }, L);
  const led = [0, 1, 2].map(i => E('circle', { cx: 16 + i * 9, cy: 17, r: 2.4, fill: i === 0 ? '#00ec97' : '#444547' }, L));
  E('rect', { x: 8, y: h * S - 18, width: 18, height: 6, rx: 2, fill: '#2b2c2d' }, L);
  cyl(g, cx, cy, 0.3 + h, 0.55, 0.32, M.stone);
  cyl(g, cx, cy, 0.62 + h, 0.3, 0.5, M.graph);
  return { pad: base, led };
}
/* NEAR's N mark, as near.org draws it (16 x 16 box). NEAR runs the bounty contract and
   the MPC network that signs every pause, so both carry it. */
const NEAR_MARK = 'M13.9017 0.646973C13.3462 0.646973 12.8304 0.929357 12.5394 1.39357L9.40403 5.95741C9.30186 6.10784 9.34331 6.31059 9.49675 6.41075C9.6211 6.49202 9.78561 6.48196 9.89889 6.38645L12.9851 3.76201C13.0364 3.71677 13.1154 3.72137 13.1616 3.77165C13.1825 3.79469 13.1937 3.82444 13.1937 3.85502V12.0719C13.1937 12.1397 13.1377 12.1942 13.0684 12.1942C13.0312 12.1942 12.9962 12.1783 12.9727 12.1502L3.6435 1.20169C3.33966 0.850174 2.89352 0.647392 2.42388 0.646973H2.09782C1.21536 0.646973 0.5 1.34833 0.5 2.2135V13.7863C0.5 14.6515 1.21536 15.3528 2.09782 15.3528C2.65336 15.3528 3.16915 15.0704 3.46017 14.6062L6.59558 10.0424C6.69769 9.89194 6.65624 9.68919 6.50279 9.58903C6.37845 9.50776 6.21394 9.51782 6.10071 9.61334L3.01446 12.2378C2.96318 12.283 2.88412 12.2784 2.83797 12.2281C2.81703 12.2051 2.80592 12.1753 2.80634 12.1447V3.92583C2.80634 3.85796 2.86232 3.80349 2.93155 3.80349C2.96831 3.80349 3.00377 3.81941 3.02728 3.84748L12.3552 14.7981C12.659 15.1496 13.1052 15.3524 13.5749 15.3528H13.9009C14.7833 15.3532 15.4992 14.6523 15.5 13.7871V2.2135C15.5 1.34833 14.7842 0.646973 13.9017 0.646973Z';
function nearMark(G, cx, cy, size) {
  const k = size / 16;
  E('path', { d: NEAR_MARK, fill: '#ffffff', transform: `translate(${r2(cx - 8 * k)} ${r2(cy - 8 * k)}) scale(${r2(k)})` }, G);
}
function vault(g, cx, cy) {
  const w = 4.4, h = 2.6, x = cx - w / 2, y = cy - w / 2;
  const base = pad(g, cx, cy, w / 2 + 1);
  box(g, x, y, 0, w, w, h, M.stone);
  const L = E('g', { transform: onLeft(x, y + w, h) }, g);
  nearMark(L, w * S * 0.5, h * S * 0.5, h * S * 0.5);
  const R = E('g', { transform: onRight(x + w, y + w, h) }, g);
  [0.25, 0.5, 0.75].forEach(f => E('rect', { x: w * S * f - 1, y: 10, width: 2, height: h * S - 20, rx: 1, fill: '#303132' }, R));
  const coins = E('g', { class: 'fx', opacity: 0 }, g);
  [[-0.7, -0.5], [0.6, -0.2], [-0.1, 0.8]].forEach(([dx, dy], i) => { for (let k = 0; k < 3 - (i % 2); k++) cyl(coins, cx + dx, cy + dy, h + k * 0.22, 0.62, 0.2, M.ok); });
  return { top: h, base, set(locked) { coins.setAttribute('opacity', locked ? 1 : 0); } };
}
function mpcCluster(g, cx, cy) {
  const base = pad(g, cx, cy, 3.1);
  box(g, cx - 2.4, cy - 2.4, 0, 4.8, 4.8, 0.35, M.stone);
  const at = [[-1.1, -1.1], [1.2, -0.6], [-0.6, 1.2]];
  const tops = at.map(([dx, dy]) => P(cx + dx, cy + dy, 0.35 + 1.9));
  nearMark(E('g', { transform: onTop(cx - 2.4, cy - 2.4, 0.35) }, g), 3.65 * S, 3.65 * S, 0.95 * S);
  const links = E('g', {}, g);
  const pills = at.map(([dx, dy]) => cyl(g, cx + dx, cy + dy, 0.35, 0.62, 1.9, M.graph));
  const caps = at.map(([dx, dy]) => { const [a, b] = P(cx + dx, cy + dy, 2.25); return E('ellipse', { class: 'fx', cx: r2(a), cy: r2(b), rx: r2(0.62 * 1.2247 * S), ry: r2(0.62 * 0.7071 * S), fill: M.graph.t }, g); });
  const ln = E('polygon', { points: tops.map(t => t.map(r2).join(',')).join(' '), fill: 'none', stroke: '#646567', 'stroke-width': 1, 'stroke-dasharray': '2 3' }, g);
  return { top: 2.3, base, set(state) { caps.forEach(c => c.setAttribute('fill', state === 'ok' ? M.ok.t : state === 'hot' ? '#858688' : M.graph.t)); ln.setAttribute('stroke', state === 'ok' ? '#00ec97' : '#646567'); } };
}
// moving things: built at the world origin and translated
function packet(g, kind) {
  const G = E('g', { class: 'pk', opacity: 0 }, g);
  if (kind === 'coin') { cyl(G, 0, 0, 0.35, 0.72, 0.24, M.ok); cyl(G, 0, 0, 0.59, 0.72, 0.24, M.ok); }
  else if (kind === 'sealed') {
    box(G, -0.75, -0.55, 0.3, 1.5, 1.1, 0.55, M.bone);
    const T = E('g', { transform: onTop(-0.75, -0.55, 0.85) }, G);
    lock(T, 15, 9, 12, '#565759', M.bone.t);
  } else if (kind === 'pause') {
    box(G, -0.6, -0.6, 0.3, 1.2, 1.2, 0.45, M.ok);
    const T = E('g', { transform: onTop(-0.6, -0.6, 0.75) }, G);
    E('rect', { x: 7, y: 6, width: 3, height: 12, rx: 1, fill: '#00653e' }, T); E('rect', { x: 14, y: 6, width: 3, height: 12, rx: 1, fill: '#00653e' }, T);
  } else if (kind === 'ok') box(G, -0.6, -0.6, 0.3, 1.2, 1.2, 0.4, M.ok);
  else box(G, -0.6, -0.6, 0.3, 1.2, 1.2, 0.4, M.graph);
  return G;
}
const place = (el, xy, z = 0) => { const [a, b] = P(xy[0], xy[1], z); el.setAttribute('transform', `translate(${r2(a)} ${r2(b)})`); };
function fit(svg, pad = 12) {
  const b = svg.getBBox();
  svg.setAttribute('viewBox', `${r2(b.x - pad)} ${r2(b.y - pad)} ${r2(b.width + 2 * pad)} ${r2(b.height + 2 * pad)}`);
}
function fitTo(svg, g, pad = 12) {
  const b = g.getBBox();
  svg.setAttribute('viewBox', `${r2(b.x - pad)} ${r2(b.y - pad)} ${r2(b.width + 2 * pad)} ${r2(b.height + 2 * pad)}`);
}

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = v => Math.max(0, Math.min(1, v));
const ease = v => 1 - Math.pow(1 - v, 3);
const seg = (t, a, b) => clamp01((t - a) / (b - a));

/* =====================================================================
   STORY: the same world, laid out as the system. Scroll drives the step.
   ===================================================================== */
function buildStory(svg, bounty, opts = {}) {
  const world = E('g', {}, svg);
  field(svg, world, 4, 2, 22, opts.seed || 11, 60);
  const pos = { near: [0, 0], wh: [0, 10.5], enc: [-10.5, 0], mpc: [9.5, 0], base: [9.5, -10.5], arb: [20, 0] };
  const R = {
    whNear: route([pos.wh, pos.near], 3.2, 3.6),
    nearEnc: route([pos.near, pos.enc], 3.4, 4.2),
    nearMpc: route([pos.near, pos.mpc], 3.4, 3.4),
    mpcBase: route([pos.mpc, pos.base], 3.4, 3.4),
    mpcArb: route([pos.mpc, pos.arb], 3.4, 3.8)
  };
  const B = {}; for (const k in R) B[k] = bus(world, R[k], 2, 0.34);
  const enc = enclave(world, ...pos.enc, 4.6, 3.0);
  const base = chainBlock(world, ...pos.base, 'base');
  const near = vault(world, ...pos.near);
  const mpc = mpcCluster(world, ...pos.mpc);
  const actor = bounty.actor === 'agent' ? agentUnit(world, ...pos.wh) : whitehat(world, ...pos.wh);
  const arb = chainBlock(world, ...pos.arb, 'arb');
  const fx = E('g', {}, world);
  const tags = E('g', {}, world);

  // floating tags: title + state, in screen space above each object
  const mctx = document.createElement('canvas').getContext('2d');
  const titles = { wh: bounty.who, near: 'Bounty contract', enc: 'Enclave', mpc: 'MPC network', base: 'Base', arb: 'Arbitrum One' };
  const subs = { wh: bounty.actor === 'agent' ? 'AI agent' : 'command-line tool', near: 'NEAR · ' + bounty.name, enc: 'OutLayer · Intel TDX', mpc: 'NEAR · signs pauses', base: 'covered vault', arb: 'covered vault' };
  const heights = { wh: bounty.actor === 'agent' ? 4.6 : 4.8, near: 3.9, enc: 3.8, mpc: 3.4, base: 3.0, arb: 3.0 };
  const T = {};
  Object.keys(titles).forEach(k => {
    const [a, b] = P(pos[k][0], pos[k][1], heights[k]);
    const G = E('g', { transform: `translate(${r2(a)} ${r2(b - 20)})` }, tags);
    const rect = E('rect', { y: -46, height: 46, rx: 7, fill: 'rgba(24, 24, 25, .94)', stroke: '#424345' }, G);
    E('path', { d: 'M-5,0L0,6L5,0', fill: 'rgba(24, 24, 25, .94)', stroke: '#424345' }, G);
    E('rect', { x: -6, y: -1.5, width: 12, height: 2.4, fill: 'rgb(24, 24, 25)' }, G);
    const t1 = E('text', { y: -27, 'font-size': 13, 'font-weight': 700, fill: '#eceeef' }, G); t1.textContent = titles[k];
    const t2 = E('text', { y: -11, 'font-size': 11, fill: '#919395', class: 'mono' }, G);
    const dot = E('circle', { cy: -31, r: 3, fill: '#424345' }, G);
    T[k] = { G, rect, t1, t2, dot, last: '' };
  });
  function setTag(k, text, ok, hot) {
    const o = T[k];
    const txt = text || subs[k];
    if (o.last !== txt + ok + hot) {
      o.last = txt + ok + hot;
      o.t2.textContent = txt;
      mctx.font = '700 13px "Switzer", system-ui'; const w1 = mctx.measureText(titles[k]).width;
      mctx.font = '400 11px "IBM Plex Mono", monospace'; const w2 = mctx.measureText(txt).width;
      const w = Math.max(w1 + 22, w2) + 24;
      o.rect.setAttribute('x', r2(-w / 2)); o.rect.setAttribute('width', r2(w));
      o.t1.setAttribute('x', r2(-w / 2 + 12)); o.t2.setAttribute('x', r2(-w / 2 + 12));
      o.dot.setAttribute('cx', r2(w / 2 - 14));
      o.t2.setAttribute('fill', ok ? '#00ec97' : hot ? '#b9bbbc' : '#919395');
      o.rect.setAttribute('stroke', ok ? 'rgba(0, 236, 151, .55)' : hot ? '#727375' : '#424345');
      o.dot.setAttribute('fill', ok ? '#00ec97' : hot ? '#b9bbbc' : '#424345');
    }
  }
  // packets and their labels
  const PK = {};
  const mk = (key, kind) => {
    const el = packet(fx, kind);
    const lab = E('g', { opacity: 0 }, tags);
    const r = E('rect', { height: 22, rx: 6, fill: kind === 'ok' || kind === 'coin' || kind === 'pause' ? '#262729' : '#232425', stroke: kind === 'ok' || kind === 'coin' ? '#00ec97' : '#727375' }, lab);
    const t = E('text', { y: 15, 'font-size': 11, class: 'mono', fill: kind === 'ok' || kind === 'coin' ? '#00ec97' : '#eceeef' }, lab);
    PK[key] = { el, lab, r, t, txt: '' };
  };
  [['claim', 'sealed'], ['claim2', 'sealed'], ['pays', 'ok'], ['sign', 'plain'], ['coin', 'coin'], ['pB', 'pause'], ['pA', 'pause'], ['lB', 'plain'], ['lA', 'plain'], ['ver', 'ok'], ['sig1', 'ok'], ['sig2', 'ok'], ['pub', 'plain']].forEach(a => mk(...a));
  function showPk(key, xy, label, alpha) {
    const o = PK[key];
    o.el.setAttribute('opacity', r2(alpha)); o.lab.setAttribute('opacity', r2(alpha));
    if (alpha <= 0) return;
    place(o.el, xy);
    if (o.txt !== label) { o.txt = label; o.t.textContent = label; const w = label.length * 6.6 + 18; o.r.setAttribute('x', r2(-w / 2)); o.r.setAttribute('width', r2(w)); o.t.setAttribute('x', r2(-w / 2 + 9)); }
    const [a, b] = P(xy[0], xy[1], 1.4);
    o.lab.setAttribute('transform', `translate(${r2(a)} ${r2(b - 30)})`);
  }
  const ride = (key, rt, f, rev, label, alpha) => showPk(key, rt.at(rev ? 1 - f : f), label, alpha);
  const hot = (k, on, dashed) => B[k].lines.forEach(l => { l.setAttribute('stroke', on ? TRACE_HOT : TRACE); l.setAttribute('stroke-dasharray', dashed ? '3 4' : 'none'); });

  // frame on the objects (field bleeds past)
  const vb = [-318, -268, 766, 536];
  svg.setAttribute('viewBox', vb.map(r2).join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  function draw(s, t) {
    const p = k => (s > k ? 1 : s < k ? 0 : t);
    const e = (k, a, b) => ease(seg(p(k), a, b));
    const fl = (k, a, b) => { const v = seg(p(k), a, b); return v > 0 && v < 1 ? Math.min(1, v * 8, (1 - v) * 8) : 0; };
    const st = {}; Object.keys(titles).forEach(k => st[k] = {});
    st.near.text = p(0) > 0.3 ? `${live.amount} locked` : 'posting';
    if (p(1) > 0.85) st.near.text = '1 claim sealed';
    if (p(2) > 0.95) { st.near.text = 'verdict PAYS'; st.near.ok = true; }
    if (p(4) > 0.8) { st.near.text = `paid ${live.amount} · closed`; st.near.ok = true; }
    if (p(6) > 0.92) { st.near.text = `${live.pauses ?? DASH}/${live.pauses ?? DASH} pauses verified`; st.near.ok = true; }
    if (p(7) > 0.55) { st.near.text = 'exploit published'; st.near.ok = true; }
    st.near.hot = s === 0 || s === 1 || s === 7;
    st.wh.text = p(1) > 0.05 ? (bounty.actor === 'agent' ? 'AI agent · claim filed' : 'claim filed') : subs.wh;
    if (p(4) > 0.8) { st.wh.text = `+${live.amount}`; st.wh.ok = true; }
    st.wh.hot = s === 1 || s === 4;
    let encState = 'idle', work = 0;
    st.enc.text = 'judge attested';
    if (p(2) > 0.28 && p(2) < 0.7) { st.enc.text = 'replaying in revm'; encState = 'work'; work = seg(p(2), 0.28, 0.7); st.enc.hot = true; }
    if (p(2) >= 0.7) { st.enc.text = `PAYS · > ${live.min}`; st.enc.ok = true; encState = 'pays'; }
    st.mpc.text = 'waiting';
    if (p(3) > 0.3) { st.mpc.text = `signing ${live.pauses ?? DASH} pauses`; st.mpc.hot = true; }
    if (p(3) > 0.85) { st.mpc.text = `${live.pauses ?? DASH} pauses signed`; st.mpc.ok = true; st.mpc.hot = false; }
    if (p(6) > 0.25 && p(6) < 0.6) { st.mpc.text = 'confirming'; st.mpc.ok = false; st.mpc.hot = true; }
    if (p(6) >= 0.6) { st.mpc.text = 'pauses confirmed'; st.mpc.ok = true; }
    const paused = {};
    ['base', 'arb'].forEach((k, i) => {
      st[k].text = p(0) > 0.6 ? 'pause role granted' : 'live';
      paused[k] = p(5) > 0.62 + i * 0.12;
      if (paused[k]) { st[k].text = 'paused'; st[k].ok = true; }
      if (p(6) > 0.5) { st[k].text = 'paused · verified'; st[k].ok = true; }
      if (s === 0 && t > 0.4 && t < 0.9) st[k].hot = true;
    });
    Object.keys(st).forEach(k => setTag(k, st[k].text, st[k].ok, st[k].hot));
    enc.set(encState, work);
    base.set(paused.base); arb.set(paused.arb);
    near.set(p(0) > 0.3 && p(4) < 0.8);
    near.base.setAttribute('stroke', st.near.ok ? '#00ec97' : '#444547');
    mpc.set(st.mpc.ok ? 'ok' : st.mpc.hot ? 'hot' : '');
    mpc.base.setAttribute('stroke', st.mpc.ok ? '#00ec97' : '#444547');
    actor.pad.setAttribute('stroke', st.wh.ok ? '#00ec97' : '#444547');

    hot('whNear', s === 1 || s === 4); hot('nearEnc', s === 2); hot('nearMpc', s === 3 || s === 6);
    hot('mpcBase', s === 5 || s === 6, p(5) < 0.1); hot('mpcArb', s === 5 || s === 6, p(5) < 0.1);
    Object.keys(PK).forEach(k => showPk(k, [0, 0], '', 0));
    if (s === 1) ride('claim', R.whNear, e(1, 0.08, 0.85), false, 'sealed claim', fl(1, 0.08, 0.9));
    if (s === 2) {
      ride('claim2', R.nearEnc, e(2, 0, 0.26), false, 'sealed claim', fl(2, 0, 0.28));
      ride('pays', R.nearEnc, e(2, 0.72, 0.95), true, 'PAYS', fl(2, 0.72, 0.97));
    }
    if (s === 3) {
      ride('sign', R.nearMpc, e(3, 0.02, 0.32), false, 'sign pauses', fl(3, 0.02, 0.34));
      if (t > 0.5 && t < 0.97) {
        const a = Math.min(1, (t - 0.5) * 6, (0.97 - t) * 10);
        showPk('sig1', [pos.mpc[0] + 3.6, pos.mpc[1] - 1.4], 'sig', a);
        showPk('sig2', [pos.mpc[0] + 1.4, pos.mpc[1] + 3.6], 'sig', a * clamp01((t - 0.6) * 8));
      }
    }
    if (s === 4) ride('coin', R.whNear, e(4, 0.12, 0.8), true, live.amount, fl(4, 0.12, 0.84));
    if (s === 5) {
      ride('pB', R.mpcBase, e(5, 0.06, 0.62), false, 'signed pause', fl(5, 0.06, 0.66));
      ride('pA', R.mpcArb, e(5, 0.18, 0.74), false, 'signed pause', fl(5, 0.18, 0.78));
    }
    if (s === 6) {
      ride('lB', R.mpcBase, e(6, 0, 0.4), true, 'landed', fl(6, 0, 0.42));
      ride('lA', R.mpcArb, e(6, 0.05, 0.45), true, 'landed', fl(6, 0.05, 0.47));
      ride('ver', R.nearMpc, e(6, 0.55, 0.9), true, `verified ×${live.pauses ?? DASH}`, fl(6, 0.55, 0.93));
    }
    if (s === 7) showPk('pub', [pos.near[0] + 3.6, pos.near[1] + 3.6], 'day 1 · published', clamp01(t * 4));
  }
  return { draw };
}

/* render loop that sleeps off-screen */
function loop(el, frame) {
  let raf = 0, visible = false, last = 0;
  const tick = now => { const dt = last ? Math.min(64, now - last) : 16; last = now; frame(dt); raf = requestAnimationFrame(tick); };
  const start = () => { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(tick); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; visible ? start() : stop(); }).observe(el);
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
}

/* =====================================================================
   SMALL PICTURES: glyphs, FAQ, close. Same primitives.
   ===================================================================== */
const GLYPHS = {
  vault(g) { box(g, -1.2, -1.2, 0, 2.4, 2.4, 1.6, M.stone); const L = E('g', { transform: onLeft(-1.2, 1.2, 1.6) }, g); lock(L, 24, 14, 16, '#919395', M.stone.l); },
  rules(g) { [0, 1, 2].forEach(i => box(g, -1.3, -1.3, i * 0.5, 2.6, 2.6, 0.36, i === 2 ? M.bone : M.stone)); },
  funds(g) { box(g, -1.4, -1.4, 0, 2.8, 2.8, 0.4, M.stone); cyl(g, -0.3, 0.2, 0.4, 0.6, 0.22, M.ok); cyl(g, -0.3, 0.2, 0.62, 0.6, 0.22, M.ok); cyl(g, 0.6, -0.5, 0.4, 0.6, 0.22, M.ok); },
  sealed(g) { box(g, -1.3, -0.9, 0, 2.6, 1.8, 0.9, M.bone); const T = E('g', { transform: onTop(-1.3, -0.9, 0.9) }, g); lock(T, 26, 14, 16, '#565759', M.bone.t); },
  enclave(g) { box(g, -1.3, -1.3, 0, 2.6, 2.6, 1.9, M.bone); const T = E('g', { transform: onTop(-1.3, -1.3, 1.9) }, g); E('rect', { x: 8, y: 8, width: 36, height: 36, rx: 3, fill: PANEL }, T); E('rect', { x: 14, y: 22, width: 24, height: 6, rx: 2, fill: '#00ec97' }, T); },
  mpc(g) { box(g, -1.5, -1.5, 0, 3, 3, 0.25, M.stone); [[-0.7, -0.7], [0.7, -0.3], [-0.3, 0.7]].forEach(([x, y]) => cyl(g, x, y, 0.25, 0.42, 1.3, M.graph)); },
  rpc(g) { [[-1, 0.8], [0, 0], [1, -0.8]].forEach(([x, y], i) => box(g, x - 0.4, y - 0.4, 0, 0.8, 0.8, 1.2 + i * 0.35, M.graph)); },
  whitehat(g) { whitehat(g, 0, 0); },
  agent(g) { agentUnit(g, 0, 0); },
  base(g) { chainBlock(g, 0, 0, 'base'); },
  arb(g) { chainBlock(g, 0, 0, 'arb'); },
  near(g) { vault(g, 0, 0).set(true); },
  enc(g) { enclave(g, 0, 0, 5, 3.2).set('pays'); },
  code(g) { box(g, -1.4, -1.1, 0, 2.8, 2.2, 0.5, M.stone); const T = E('g', { transform: onTop(-1.4, -1.1, 0.5) }, g); [0, 1, 2, 3].forEach(i => E('rect', { x: 8 + (i % 2) * 6, y: 7 + i * 8, width: 26 - (i % 3) * 6, height: 3, rx: 1.5, fill: i === 1 ? '#00ec97' : '#727375' }, T)); }
};
function buildGlyphs() {
  document.querySelectorAll('svg[data-glyph]').forEach(svg => { const g = E('g', {}, svg); GLYPHS[svg.dataset.glyph](g); fit(svg, 2); });
}
function buildFaq() {
  const svg = document.getElementById('faqArt'); const g = E('g', {}, svg);
  field(svg, g, 0, 0, 9, 41, 22);
  bus(g, route([[0, 0], [0, 7]], 3.4, 2.6), 2, 0.34);
  bus(g, route([[0, 0], [7, 0]], 3.4, 2.4), 2, 0.34);
  enclave(g, 0, 0, 4.2, 2.8).set('idle');
  agentUnit(g, 7, 0);
  whitehat(g, 0, 7.5);
  svg.setAttribute('viewBox', [-9 * K * S, -6 * S - 40, 18 * K * S + 20, 13 * S + 70].map(r2).join(' '));
}
function buildClose() {
  const svg = document.getElementById('closeArt'); const g = E('g', {}, svg);
  field(svg, g, 0, 0, 13, 59, 34);
  bus(g, route([[0, 0], [-8, 0]], 3, 2.6), 3); bus(g, route([[0, 0], [0, -8]], 3, 2.6), 3); bus(g, route([[0, 0], [7, 0]], 3, 2.6), 3);
  const a = chainBlock(g, 0, -8, 'arb'), b = chainBlock(g, -8, 0, 'base');
  const v = vault(g, 0, 0); v.set(true);
  enclave(g, 7.5, 0, 4, 2.6).set('idle');
  a.set(false); b.set(false);
  groundText(g, -2.4, 3.9, 'Your bounty');
  svg.setAttribute('viewBox', [-11 * K * S - 20, -11 * S - 20, 22 * K * S + 60, 17 * S + 60].map(r2).join(' '));
}

/* =====================================================================
   PAGE
   ===================================================================== */
const num = n => `${n + 1}.`;
const chipHTML = s => (s.chips || []).map(([c, l]) => `<span class="chip ${c}">${esc(l)}</span>`).join('') +
  s.tx.map(x => x.hash
    ? `<span class="tx"><span class="chip">${esc(x.chain)}</span><span class="chip link"><a href="${esc(x.href)}" target="_blank" rel="noopener" title="${esc(x.hash)}">${esc(short(x.hash))}${ext}</a><button type="button" class="cp" aria-label="Copy transaction hash" data-hash="${esc(x.hash)}">${copyIco}</button></span></span>`
    : `<span class="chip">${esc(x.chain)}</span><a class="chip" href="${esc(x.href)}" target="_blank" rel="noopener">${esc(x.label || 'tx pending')}${ext}</a>`).join('') +
  (s.pending ? `<span class="chip">NEAR</span><span class="chip mute">${s.pending}</span>` : '');

// the story
document.getElementById('storyName').textContent = BOUNTY.name;
const panelsEl = document.getElementById('panels');
panelsEl.innerHTML = stepsFor().map((s, i) => `<li class="panel${i ? '' : ' on'}" data-step="${i}"><h3><span class="n">${num(i)}</span>${STEPS[i]}</h3><p>${esc(s.d)}</p><div class="meta">${chipHTML(s)}</div></li>`).join('');
// Live data swaps into the panels in place: their text and chips, never their order or state.
function renderStory() {
  document.getElementById('storyName').textContent = BOUNTY.name;
  stepsFor().forEach((s, i) => { const li = panelsEl.children[i]; li.querySelector('p').textContent = s.d; li.querySelector('.meta').innerHTML = chipHTML(s); });
  document.getElementById('cmd').innerHTML = `<span class="p" aria-hidden="true">$</span>${esc(cmdFor())}`;
  document.getElementById('termNote').textContent = `reading ${BOUNTY.name} from NEAR, ${chainList()}`;
  story.draw(Math.max(0, active), reduce ? 1 : 0.999);
}
// Copying a hash is announced, as the app's own tx chips do.
const copied = Object.assign(document.createElement('span'), { className: 'sr-only' });
copied.setAttribute('aria-live', 'polite');
panelsEl.after(copied);
panelsEl.addEventListener('click', async e => {
  const b = e.target.closest('.cp'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.hash); b.innerHTML = checkIco; copied.textContent = 'Copied'; setTimeout(() => { b.innerHTML = copyIco; copied.textContent = ''; }, 1600); } catch {}
});
const dock = document.getElementById('dock');
dock.innerHTML = STEPS.map((n, i) => `<button type="button" data-go="${i}"><span class="k">${num(i)}</span><span class="lbl">${n}</span></button>`).join('');

// verify
document.getElementById('cmd').innerHTML = `<span class="p" aria-hidden="true">$</span>${esc(cmdFor())}`;
document.getElementById('termNote').textContent = `reading ${BOUNTY.name} from NEAR, ${chainList()}`;

// pictures
const story = buildStory(document.getElementById('storyArt'), BOUNTY);
buildGlyphs(); buildFaq(); buildClose();

// scroll-driven story + dock
const track = document.getElementById('track');
const storyArt = document.getElementById('storyArt');
const storyNow = document.getElementById('storyNow');
const panels = [...panelsEl.children];
const dockBtns = [...dock.querySelectorAll('button')];
let active = -1, st = 0;
function setStep(i) {
  if (i === active) return;
  active = i; st = 0;
  panels.forEach((p, k) => p.classList.toggle('on', k === i));
  dockBtns.forEach((b, k) => { b.classList.toggle('done', k < i); k === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current'); });
  storyNow.textContent = num(i) + ' ' + STEPS[i];
  if (reduce) story.draw(i, 1);
}
function stepFromScroll() {
  const r = track.getBoundingClientRect(), range = track.offsetHeight - innerHeight;
  setStep(Math.min(7, Math.floor(clamp01(-r.top / Math.max(1, range)) * 8)));
}
function goTo(i) {
  const range = track.offsetHeight - innerHeight;
  scrollTo({ top: track.getBoundingClientRect().top + scrollY + range * ((i + 0.5) / 8), behavior: reduce ? 'auto' : 'smooth' });
}
dockBtns.forEach(b => b.addEventListener('click', () => goTo(+b.dataset.go)));
panels.forEach((p, k) => p.addEventListener('focusin', () => { if (k !== active) goTo(k); }));
const RUN = 2600, HOLD = 1400;
if (!reduce) loop(storyArt, dt => { st = (st + dt) % (RUN + HOLD); story.draw(active, Math.min(1, st / RUN)); });
new IntersectionObserver(([en]) => dock.classList.toggle('show', en.isIntersecting), { rootMargin: '-35% 0px -35% 0px' }).observe(track);

// statement lights word by word
const stmt = document.getElementById('statement');
const okWords = new Set(['proves', 'pays', 'once,', 'stop']);
stmt.innerHTML = stmt.textContent.trim().split(/\s+/).map(w => `<span class="w${okWords.has(w) ? ' ok' : ''}">${w}</span>`).join(' ');
const words = [...stmt.querySelectorAll('.w')];
function lightWords() {
  if (reduce) { words.forEach(w => w.classList.add('lit')); return; }
  const r = stmt.getBoundingClientRect(), a = innerHeight * 0.85, b = innerHeight * 0.3;
  const n = Math.round(clamp01((a - r.top) / (a - b + r.height * 0.6)) * words.length);
  words.forEach((w, i) => w.classList.toggle('lit', i < n));
}
const nav = document.getElementById('nav');
let ticking = false;
function onScroll() { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; stepFromScroll(); lightWords(); nav.classList.toggle('solid', scrollY > 8); }); }
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
stepFromScroll(); lightWords();
story.draw(Math.max(0, active), reduce ? 1 : 0);
if (document.fonts) document.fonts.ready.then(() => story.draw(Math.max(0, active), 1));

// entrances
const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('.rise').forEach(el => io.observe(el));

// verify run plays once
const term = document.getElementById('term');
[...term.querySelectorAll('.run li, .sum')].forEach((l, i) => l.style.transitionDelay = (reduce ? 0 : 120 + i * 140) + 'ms');
new IntersectionObserver(([en], o) => { if (en.isIntersecting) { term.classList.add('ran'); o.disconnect(); } }, { rootMargin: '0px 0px -20% 0px' }).observe(term);

// copy buttons
document.querySelectorAll('.copy').forEach(btn => btn.addEventListener('click', async () => {
  const src = document.getElementById(btn.dataset.copy);
  const text = src.textContent.replace(/^\$/, '').trim();
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { const s = getSelection(), r = document.createRange(); r.selectNodeContents(src); s.removeAllRanges(); s.addRange(r); btn.textContent = 'Selected'; }
  setTimeout(() => btn.textContent = 'Copy', 1600);
}));

// faq
document.querySelectorAll('.qa button').forEach(b => b.addEventListener('click', () => { const open = b.closest('.qa').toggleAttribute('data-open'); b.setAttribute('aria-expanded', open); }));

return {
  update(next) {
    Object.assign(live, next);
    renderStory();
  }
};
})();
  (() => {
  const roll = document.getElementById('roll'), chains = [...roll.querySelectorAll('.chain')];
  const fitW = c => { roll.style.width = c.scrollWidth + 'px'; };
  document.fonts.ready.then(() => fitW(chains[0]));
  roll.querySelectorAll('img').forEach(im => im.addEventListener('load', () => fitW(roll.querySelector('.chain.on'))));
  let ci = 0;
  const nextChain = (onSwap) => {
    const cur = chains[ci], nxt = chains[(ci + 1) % chains.length];
    cur.classList.remove('on'); cur.classList.add('off');
    nxt.classList.remove('off'); nxt.classList.add('on'); fitW(nxt);
    setTimeout(() => cur.classList.remove('off'), 700);
    ci = (ci + 1) % chains.length;
    if (onSwap) onSwap(nxt);
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the drifting parts lean away from the pointer, nearer ones more
  const fl = [...document.querySelectorAll('.fl')];
  if (!reduce) addEventListener('pointermove', e => {
    const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
    fl.forEach(f => { const k = +f.dataset.k * 22; f.style.transform = `translate(${(-x * k).toFixed(1)}px, ${(-y * k).toFixed(1)}px)`; });
  });
})();
  (() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lines = [...document.querySelectorAll('[data-dec]')], last = document.querySelector('.pw .ln.last');
  const reveal = () => { const r = document.getElementById('roll'); r.style.width = r.querySelector('.chain.on').scrollWidth + 'px'; last.classList.add('in'); };
  const ease = x => 1 - Math.pow(1 - x, 3);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (reduce) { document.fonts.ready.then(reveal); document.querySelectorAll('.pw .roll .wm').forEach(i => i.style.visibility = 'visible'); return; }

  // draw a line's text into a canvas laid exactly over it, then reveal it cell by cell
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const overlay = el => {
    // measure the text, not the element: a whole line is a full-width block, its text centred inside it
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), pad = Math.ceil(fs * 0.3);
    el.style.visibility = 'visible'; const color = cs.color; el.style.color = 'transparent';
    const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    const rg = document.createRange(); rg.selectNodeContents(el); const rect = rg.getBoundingClientRect();
    el.appendChild(probe); const base = probe.getBoundingClientRect().top - rect.top; probe.remove();
    const dpr = devicePixelRatio || 1, W = Math.ceil(rect.width + pad * 2), H = Math.ceil(rect.height + pad * 2);
    const cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
    cv.style.cssText = `position:absolute;left:${rect.left + scrollX - pad}px;top:${rect.top + scrollY - pad}px;width:${W}px;height:${H}px;pointer-events:none;z-index:5`;
    document.body.appendChild(cv);
    const T = document.createElement('canvas'); T.width = cv.width; T.height = cv.height;
    const t = T.getContext('2d'); t.scale(dpr, dpr);
    t.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; t.letterSpacing = cs.letterSpacing; t.fillStyle = color;
    t.fillText(el.textContent, pad, base + pad);
    const done = () => { el.style.color = ''; cv.style.transition = 'opacity 160ms'; cv.style.opacity = '0'; setTimeout(() => cv.remove(), 200); };
    return { cv, ctx: cv.getContext('2d'), T, W, H, dpr, done };
  };
  const ditherMask = (o, cell, k) => {
    const cw = Math.ceil(o.W / cell), ch = Math.ceil(o.H / cell);
    const M = document.createElement('canvas'); M.width = cw; M.height = ch;
    const m = M.getContext('2d'), img = m.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const th = BAYER[(y % 4) * 4 + (x % 4)], on = k * 1.35 - (x / cw) * 0.35 > th;
      img.data[(y * cw + x) * 4 + 3] = on ? 255 : 0;
    }
    m.putImageData(img, 0, 0); return M;
  };

  const STAGGER = 150;
  const run = (el) => new Promise(done => {
    const o = overlay(el), DUR = 1250, t0 = performance.now();
    const P = document.createElement('canvas'), p = P.getContext('2d');
    o.ctx.imageSmoothingEnabled = false;
    const step = now => {
      const k = Math.min(1, (now - t0) / DUR), e = ease(k);
      const px = Math.max(1, Math.round((1 - e) * 18 * o.dpr));
      P.width = Math.ceil(o.cv.width / px); P.height = Math.ceil(o.cv.height / px);
      p.imageSmoothingEnabled = true; p.drawImage(o.T, 0, 0, P.width, P.height);
      o.ctx.globalCompositeOperation = 'source-over'; o.ctx.clearRect(0, 0, o.cv.width, o.cv.height);
      o.ctx.drawImage(P, 0, 0, o.cv.width, o.cv.height);
      o.ctx.globalCompositeOperation = 'destination-in'; o.ctx.drawImage(ditherMask(o, Math.max(2, px / o.dpr), Math.min(1, e * 1.15)), 0, 0, o.cv.width, o.cv.height);
      o.cv.style.filter = k < 1 ? `blur(${((1 - e) * 9).toFixed(1)}px)` : '';
      if (k < 1) requestAnimationFrame(step); else { o.done(); done(); }
    };
    requestAnimationFrame(step);
  });

  // the covered chain: a wordmark dithers out, the next dithers in
  const roll = document.getElementById('roll'), chains = [...roll.querySelectorAll('.chain')];
  const ditherImg = (img, dir, dur) => new Promise(done => {
    const r = img.getBoundingClientRect(), dpr = devicePixelRatio || 1, W = Math.ceil(r.width), H = Math.ceil(r.height);
    const cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
    cv.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${W}px;height:${H}px;pointer-events:none;z-index:5`;
    document.body.appendChild(cv); img.style.visibility = 'hidden';
    const ctx = cv.getContext('2d'), t0 = performance.now(), o = { W, H };
    ctx.imageSmoothingEnabled = false;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), v = dir > 0 ? ease(k) : 1 - ease(k);
      ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(ditherMask(o, 4, v), 0, 0, cv.width, cv.height);
      if (k < 1) return requestAnimationFrame(step);
      if (dir > 0) img.style.visibility = 'visible';
      cv.remove(); done();
    };
    requestAnimationFrame(step);
  });
  const fit = c => { roll.style.width = c.scrollWidth + 'px'; };
  let ci = 0;
  const swap = async () => {
    const cur = chains[ci], nxt = chains[(ci + 1) % chains.length];
    await ditherImg(cur.querySelector('img'), -1, 260);
    cur.classList.remove('on'); nxt.classList.add('on'); fit(nxt);
    ci = (ci + 1) % chains.length;
    await ditherImg(nxt.querySelector('img'), 1, 380);
  };
  // set each wordmark like a word: resting on the line's baseline, as tall as its capitals
  // (each official file's artwork fills its own height, so every logo ends on the baseline)
  const lastLine = roll.parentElement;
  const centre = () => {
    const cs = getComputedStyle(lastLine), c = document.createElement('canvas').getContext('2d');
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const cap = c.measureText('P').actualBoundingBoxAscent;
    const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    roll.before(probe); const baseY = probe.getBoundingClientRect().top; probe.remove();
    chains.forEach(ch => {
      const im = ch.querySelector('img'), k = +(im.dataset.scale || 1);
      im.style.height = (cap * k).toFixed(1) + 'px'; im.style.transform = '';
      const r = im.getBoundingClientRect();
      im.style.transform = `translateY(${(baseY - (r.top + r.height * +(im.dataset.base || 1))).toFixed(1)}px)`;
    });
    fit(roll.querySelector('.chain.on'));
  };
  addEventListener('resize', centre);
  const chainIn = async () => {
    const img = chains[0].querySelector('img');
    await Promise.all(chains.map(ch => ch.querySelector('img')).map(im => im.complete ? 0 : new Promise(r => im.addEventListener('load', r, { once: true }))));
    fit(chains[0]); centre();
    await ditherImg(img, 1, 420);
    setInterval(swap, 3000);
  };
  lines.forEach(l => { l.dataset.t = l.textContent; l.style.visibility = 'hidden'; });
  document.fonts.ready
    .then(() => Promise.all(lines.map((l, i) => wait(i * STAGGER).then(() => run(l, l.dataset.t)))))
    .then(reveal).then(() => wait(440)).then(chainIn);
})();
  (() => {
  const cv = document.getElementById('heroBg'), hero = cv.parentElement, ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  let W = 0, H = 0, dpr = 1, visible = true, px = -1e4, py = -1e4, lastMove = -1e9;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(hero);
  addEventListener('pointermove', e => { const r = hero.getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top; lastMove = performance.now(); });

  // the circuit: the demo's isometric projection, random traces along its two axes
  const K = Math.cos(Math.PI / 6), S = 22;
  const rnd = (() => { let s = 11; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const traces = [];
  for (let i = 0; i < 120; i++) {
    let x = Math.round((rnd() - 0.5) * 70), y = Math.round((rnd() - 0.5) * 70); const pts = [[x, y]];
    for (let k = 0; k < 3; k++) { if (rnd() < 0.5) x += Math.round((rnd() - 0.5) * 16); else y += Math.round((rnd() - 0.5) * 16); pts.push([x, y]); }
    traces.push({ pts, speed: 0.05 + rnd() * 0.08, off: rnd(), hot: rnd() < 0.3 });
  }
  const iso = (x, y) => [W / 2 + (x - y) * K * S, H * 0.6 + (x + y) / 2 * S];
  // the words stay clear: brightness fades out in an ellipse behind them
  const fade = (x, y) => { const dx = (x - W / 2) / (W * 0.36), dy = (y - H * 0.42) / (H * 0.4); const cx = (x - W / 2) / 170, cy = (y - (H - 70)) / 90, cue = Math.min(1, Math.sqrt(cx * cx + cy * cy));
    return Math.min(1, Math.max(0, Math.sqrt(dx * dx + dy * dy) - 0.55) * 1.5) * Math.min(1, Math.max(0, (y - 70) / 140)) * Math.min(1, Math.max(0, (H - 30 - y) / (H * 0.13))) * cue; };
  // a brightness map of the circuit at a given cell size
  const buildMap = cell => {
    const w = Math.ceil(W / cell), h = Math.ceil(H / cell), c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.scale(1 / cell, 1 / cell); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = typeof LINE === 'number' ? LINE : 2.2;
    g.filter = `blur(${Math.max(0.6, cell * 0.12)}px)`;
    for (const tr of traces) {
      const P = tr.pts.map(p => iso(...p)); g.beginPath(); P.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.stroke();
      [P[0], P[P.length - 1]].forEach(p => { g.beginPath(); g.ellipse(p[0], p[1], 5, 3, 0, 0, Math.PI * 2); g.fill(); });
    }
    const d = g.getImageData(0, 0, w, h).data, v = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = (d[(y * w + x) * 4] / 255) * fade(x * cell, y * cell);
    return { w, h, v, cell };
  };
  // where each moving packet is now
  const packets = now => {
    const out = [];
    for (const tr of traces) {
      if (!tr.hot) continue;
      const P = tr.pts.map(p => iso(...p)), segs = []; let L = 0;
      for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); segs.push(l); L += l; }
      let d = ((now / 1000 * tr.speed + tr.off) % 1) * L, i = 0; while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
      const k = segs[i] ? d / segs[i] : 0;
      out.push([P[i][0] + (P[i + 1][0] - P[i][0]) * k, P[i][1] + (P[i + 1][1] - P[i][1]) * k]);
    }
    return out;
  };
  // the light: the pointer, or a slow drift once the pointer has rested
  const light = now => { if (now - lastMove < 2200) return [px, py]; const t = now / 1000; return [W * (0.5 + 0.36 * Math.sin(t * 0.19)), H * (0.55 + 0.3 * Math.sin(t * 0.31 + 1))]; };
  let map;
  const size = () => { dpr = devicePixelRatio || 1; W = hero.clientWidth; H = hero.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); map = buildMap(CELL); setup(); };

  const CELL = 2, LINE = 1.1;
  let small, sctx, img;
  let setup = () => { small = document.createElement('canvas'); small.width = map.w; small.height = map.h; sctx = small.getContext('2d'); img = sctx.createImageData(map.w, map.h); };
  const blit = () => { sctx.putImageData(img, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, map.w * CELL, map.h * CELL); };
  const set = (i, r, g, b, a) => { const d = img.data; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; };

  // the plain lines, drawn once
  let lines;
  const drawLines = () => {
    lines = document.createElement('canvas'); lines.width = W * dpr; lines.height = H * dpr;
    const g = lines.getContext('2d'); g.scale(dpr, dpr); g.lineWidth = 1;
    for (const tr of traces) {
      const Q = tr.pts.map(p => iso(...p)), a = fade(Q[0][0], Q[0][1]); if (a < 0.02) continue;
      g.strokeStyle = `rgba(92, 94, 98, ${(0.55 * a).toFixed(2)})`;
      g.beginPath(); Q.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.stroke();
      g.fillStyle = `rgba(110, 112, 116, ${(0.7 * a).toFixed(2)})`;
      [Q[0], Q[Q.length - 1]].forEach(p => { g.beginPath(); g.ellipse(p[0], p[1], 2.4, 1.4, 0, 0, Math.PI * 2); g.fill(); });
    }
  };
  const setupDither = setup;
  setup = () => { setupDither(); drawLines(); };
  const draw = now => {
    const P = reduce ? [] : packets(now), [lx, ly] = reduce ? [W * 0.78, H * 0.7] : light(now), { w, h, v } = map;
    img.data.fill(0);
    // the scan: only within the light, the lines become green dither
    const R = 230, x0 = Math.max(0, Math.floor((lx - R) / CELL)), x1 = Math.min(w, Math.ceil((lx + R) / CELL)),
          y0 = Math.max(0, Math.floor((ly - R) / CELL)), y1 = Math.min(h, Math.ceil((ly + R) / CELL));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const b = v[y * w + x]; if (b < 0.02) continue;
      const d = Math.hypot(x * CELL - lx, y * CELL - ly), k = Math.max(0, 1 - d / R), e = k * k * (3 - 2 * k);
      if (b * e * 1.3 > BAYER[(y & 3) * 4 + (x & 3)]) set((y * w + x) * 4, 0, 236, 151, Math.round(120 + e * 130));
    }
    for (const [qx, qy] of P) {
      const a = fade(qx, qy); if (a < 0.05) continue;
      const cx = qx / CELL, cy = qy / CELL;
      for (let y = Math.floor(cy - 4); y <= cy + 4; y++) for (let x = Math.floor(cx - 6); x <= cx + 6; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = Math.hypot((x - cx) / 1.7, y - cy), b = Math.max(0, 1 - d / 3.2) * a * 0.8;
        if (b > BAYER[(y & 3) * 4 + (x & 3)]) set((y * w + x) * 4, 0, 236, 151, 200);
      }
    }
    sctx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(lines, 0, 0, W, H);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, map.w * CELL, map.h * CELL);
  };
  addEventListener('resize', size); size();
  const loop = now => { if (visible) draw(now); if (!reduce) requestAnimationFrame(loop); };
  if (reduce) draw(0); else requestAnimationFrame(loop);
})();
  started = api;
  return api;
}
