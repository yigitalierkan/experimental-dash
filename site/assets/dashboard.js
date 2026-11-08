import { $, esc, fmt, loadJson, statusPill, renderTable, renderBars, demoBanner, showTip, hideTip, terminalHeader } from './common.js';

const DAY = 86400_000;
const state = { period: '30', lease: 'cash', overhead: true, former: true, q: '', sel: null };
let D, LG, CAT, NOW;

// ---------------------------------------------------------------- period math
const periodStart = () => (state.period === 'all' ? -Infinity : NOW - Number(state.period) * DAY);
const periodLabel = () => (state.period === 'all' ? 'TÜM ZAMANLAR' : `SON ${state.period} GÜN`);
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const utc = (s) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');

/** Category sums for an aircraft within the selected period (cash basis). */
function catsInPeriod(a) {
  const from = periodStart();
  const fromDay = Number.isFinite(from) ? dayStr(from) : '';
  const out = {};
  for (const [day, cats] of a.daily) if (day >= fromDay) for (const [c, v] of Object.entries(cats)) out[c] = (out[c] || 0) + v;
  return out;
}

/** Weeks of the lease that fall inside the period. */
function leaseWeeksInPeriod(a) {
  const L = a.lease;
  if (!L) return 0;
  const s = Math.max(utc(L.start), periodStart());
  const e = Math.min(utc(L.end), NOW);
  return Math.max(0, (e - s) / (7 * DAY));
}

const flightsByAc = new Map();
function opsInPeriod(a) {
  const from = periodStart();
  const fl = (flightsByAc.get(a.id) || []).filter((f) => f.t >= from);
  const hours = fl.reduce((s, f) => s + (f.hours || 0), 0);
  const start = a.since ? Date.parse(a.since) : NOW;
  const end = a.inFleet ? NOW : Math.max(start, ...a.daily.map(([d]) => Date.parse(d) + DAY));
  const spanDays = Math.max((end - Math.max(start, Number.isFinite(from) ? from : start)) / DAY, 1 / 24);
  return { flights: fl.length, hours, spanDays, util: (hours / (spanDays * 24)) * 100, perDay: fl.length / spanDays };
}

function pnl(a) {
  const c = catsInPeriod(a);
  const g = (grp) => Object.entries(c).filter(([k]) => CAT[k]?.group === grp).reduce((s, [, v]) => s + v, 0);
  const leaseCash = (c.lease || 0) + (c.leaseRefund || 0);
  const leaseAcc = a.lease ? -a.lease.weekly * leaseWeeksInPeriod(a) : leaseCash;
  const fixed = state.lease === 'accrual' ? g('fixed') - leaseCash + leaseAcc : g('fixed');
  const revenue = g('revenue'), variable = g('variable'), overhead = state.overhead ? g('overhead') : 0;
  const cost = fixed + variable + overhead;
  const net = revenue + cost;
  const ops = opsInPeriod(a);
  return { c, revenue, fixed, variable, overhead, cost, net, leaseAcc, ops,
    perDay: net / ops.spanDays, revPerHour: ops.hours ? revenue / ops.hours : null, costPerHour: ops.hours ? -cost / ops.hours : null,
    margin: revenue ? (net / revenue) * 100 : null, active: Object.keys(c).length > 0 || ops.flights > 0 };
}

function rows() {
  return LG.aircraft
    .filter((a) => (state.former || a.inFleet) && (!state.q || `${a.registration} ${a.type || ''}`.toLowerCase().includes(state.q)))
    .map((a) => ({ a, p: pnl(a) }))
    .filter(({ a, p }) => a.inFleet || p.active);
}

// ---------------------------------------------------------------- formatting
const sgn = (v, f = fmt.money) => (v == null || !Number.isFinite(v) ? '<span class="muted">—</span>' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${f(v)}</span>`);
const mny = (v) => sgn(v, fmt.money);
const cmp = (v) => sgn(v, fmt.compact);

// ---------------------------------------------------------------- KPI + ticker
function kpis(R) {
  const s = (k) => R.reduce((t, r) => t + (r.p[k] || 0), 0);
  const fl = R.reduce((t, r) => t + r.p.ops.flights, 0), hr = R.reduce((t, r) => t + r.p.ops.hours, 0);
  const idle = D.aircraft.filter((a) => a.idle24h).length;
  const rev = s('revenue'), net = s('net');
  const tiles = [
    ['Gelir', fmt.compact(rev), periodLabel()],
    ['Sabit gider', cmp(s('fixed')), state.lease === 'cash' ? 'leasing ödenen + park' : 'leasing süreye göre + park'],
    ['Değişken gider', cmp(s('variable')), 'yakıt·iniş·slot·bakım'],
    ['Genel gider', state.overhead ? cmp(s('overhead')) : '<span class="muted">HARİÇ</span>', 'personel·otel·ceza·filo yön.'],
    ['Net K/Z', cmp(net), rev ? `marj ${fmt.pct((net / rev) * 100)}` : ''],
    ['Uçuş / blok saat', `${fmt.n0(fl)} <span class="muted" style="font-size:13px">/ ${fmt.n0(hr)}s</span>`, `${D.aircraft.length} uçak filoda`],
    ['24s+ uçmayan', `<span class="${idle ? 'amb' : ''}">${idle}</span>`, 'şu an'],
  ];
  if (D.cash?.current != null) tiles.push(['Kasa', fmt.compact(D.cash.current), 'şirket nakdi']);
  $('#kpis').innerHTML = tiles.map(([l, v, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');

  const items = R.filter((r) => r.a.inFleet).sort((x, y) => y.p.net - x.p.net)
    .map(({ a, p }) => `<span class="it"><b>${esc(a.registration)}</b>${esc((a.type || '').toUpperCase())} ${cmp(p.net)} ${p.net >= 0 ? '<span class="pos">▲</span>' : '<span class="neg">▼</span>'} <span class="muted">${fmt.n0(p.ops.flights)} UÇ</span></span>`);
  $('#ticker').innerHTML = `<span class="it"><b>${esc(periodLabel())}</b>NET ${cmp(net)}</span>` + items.join('');
}

// ---------------------------------------------------------------- charts
function pnlBars(R) {
  $('#pnlMeta').textContent = periodLabel();
  const items = R.map(({ a, p }) => ({ label: a.registration + (a.inFleet ? '' : ' ⟲'), value: p.net, a, p })).sort((x, y) => y.value - x.value);
  renderBars($('#pnlBars'), items, {
    diverging: true, format: (v) => `${v > 0 ? '+' : ''}${fmt.compact(v)}`,
    tipRows: (it) => [['Tip', it.a.type || '—'], ['Uçuş', fmt.n0(it.p.ops.flights)], ['Gelir', fmt.money(it.p.revenue)], ['Sabit', fmt.money(it.p.fixed)], ['Değişken', fmt.money(it.p.variable)], ['Genel gider', fmt.money(it.p.overhead)], ['Net', fmt.money(it.p.net)]],
  });
  $('#pnlBars').querySelectorAll('.bar').forEach((b) => { b.style.background = b.classList.contains('neg') ? 'var(--neg)' : 'var(--pos)'; });
  $('#pnlBars').querySelectorAll('.row-hit').forEach((row) => row.querySelectorAll('div').forEach((d) => d.addEventListener('click', () => select(items[+row.dataset.i].a.id))));
}

/** Daily revenue (up) / cost (down) histogram + cumulative net line. */
function dailyChart(el, R, single = false) {
  const from = periodStart();
  const fromDay = Number.isFinite(from) ? dayStr(from) : '';
  const byDay = new Map();
  for (const { a } of R) for (const [day, cats] of a.daily) {
    if (day < fromDay) continue;
    const o = byDay.get(day) || { rev: 0, cost: 0 };
    for (const [c, v] of Object.entries(cats)) {
      const g = CAT[c]?.group;
      if (g === 'revenue') o.rev += v;
      else if (g === 'overhead' && !state.overhead) continue;
      else if (state.lease === 'accrual' && a.lease && (c === 'lease' || c === 'leaseRefund')) continue;
      else o.cost += v;
    }
    byDay.set(day, o);
  }
  if (state.lease === 'accrual') { // spread lease evenly per day over the lease window
    for (const { a } of R) if (a.lease) {
      const s = utc(a.lease.start), e = Math.min(utc(a.lease.end), NOW);
      for (let t = Math.max(s, Number.isFinite(from) ? from : s); t < e; t += DAY) {
        const k = dayStr(t); const o = byDay.get(k) || { rev: 0, cost: 0 }; o.cost -= a.lease.weekly / 7; byDay.set(k, o);
      }
    }
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) { el.innerHTML = '<div class="empty">Bu periyotta hareket yok</div>'; return; }
  const all = []; for (let t = Date.parse(days[0]); t <= Date.parse(days.at(-1)); t += DAY) all.push(dayStr(t));
  let cum = 0;
  const pts = all.map((d) => { const o = byDay.get(d) || { rev: 0, cost: 0 }; cum += o.rev + o.cost; return { d, rev: o.rev, cost: o.cost, net: o.rev + o.cost, cum }; });
  if (!single) $('#dailyMeta').textContent = `${periodLabel()} · ${pts.length} GÜN`;
  const W = el.clientWidth || 700, H = single ? 220 : 250, m = { l: 58, r: 58, t: 10, b: 22 };
  const maxBar = Math.max(1, ...pts.map((p) => Math.max(p.rev, -p.cost)));
  const cmin = Math.min(0, ...pts.map((p) => p.cum)), cmax = Math.max(0, ...pts.map((p) => p.cum));
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const bw = Math.max(1, iw / pts.length - 2);
  const X = (i) => m.l + (i + 0.5) * (iw / pts.length);
  const Yb = (v) => m.t + ih / 2 - (v / maxBar) * (ih / 2);
  const Yc = (v) => m.t + (1 - (v - cmin) / (cmax - cmin || 1)) * ih;
  const lbl = [0, Math.floor(pts.length / 2), pts.length - 1].filter((v, i, arr) => arr.indexOf(v) === i);
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Günlük gelir ve gider, kümülatif net">
    ${[maxBar, maxBar / 2, 0, -maxBar / 2, -maxBar].map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Yb(v)}" y2="${Yb(v)}" stroke="${v === 0 ? '#444' : '#1a1a1a'}"/><text x="${m.l - 6}" y="${Yb(v) + 3}" text-anchor="end" font-size="10" fill="#7d7d7d">${fmt.compact(v)}</text>`).join('')}
    ${[cmin, (cmin + cmax) / 2, cmax].map((v) => `<text x="${W - m.r + 6}" y="${Yc(v) + 3}" font-size="10" fill="#b9b9b9">${fmt.compact(v)}</text>`).join('')}
    ${pts.map((p, i) => `<rect x="${X(i) - bw / 2}" y="${Yb(p.rev)}" width="${bw}" height="${Math.max(0, Yb(0) - Yb(p.rev))}" fill="var(--pos)" opacity=".85"/><rect x="${X(i) - bw / 2}" y="${Yb(0)}" width="${bw}" height="${Math.max(0, Yb(p.cost) - Yb(0))}" fill="var(--neg)" opacity=".85"/>`).join('')}
    <path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Yc(p.cum).toFixed(1)}`).join('')}" fill="none" stroke="#fff" stroke-width="1.6"/>
    ${lbl.map((i) => `<text x="${X(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#7d7d7d">${pts[i].d.slice(5).replace('-', '/')}</text>`).join('')}
    <line class="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--amber)" stroke-dasharray="2 2" visibility="hidden"/>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
  </svg>`;
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
  svg.querySelector('.hit').addEventListener('mousemove', (e) => {
    const i = Math.min(pts.length - 1, Math.max(0, Math.floor(((e.clientX - svg.getBoundingClientRect().left - m.l) / iw) * pts.length)));
    const p = pts[i]; xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('visibility', 'visible');
    showTip(e, p.d, [['Gelir', fmt.money(p.rev)], ['Gider', fmt.money(p.cost)], ['Gün net', fmt.money(p.net)], ['Kümülatif net', fmt.money(p.cum)]]);
  });
  svg.querySelector('.hit').addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}

// ---------------------------------------------------------------- main table
const regCell = (a) => `<span class="reg">${esc(a.registration)}</span>${a.inFleet === false ? '<span class="tag">İADE</span>' : ''}`;
function table(R) {
  $('#tableHint').textContent = `${periodLabel()} · leasing ${state.lease === 'cash' ? 'ödenen' : 'süreye göre'} · genel gider ${state.overhead ? 'dağıtılmış' : 'hariç'} · kaynak: ${LG.entries} kasa satırı (${fmt.date(LG.from)} → ${fmt.date(LG.to)}). Gelir ve doğrudan giderler OnAir'in her satıra yazdığı uçak kimliğiyle eşleşir.`;
  const cols = [
    { key: 'reg', label: 'Tescil', get: (r) => r.a.registration, render: (r) => regCell(r.a) },
    { key: 'type', label: 'Tip', get: (r) => r.a.type || '', render: (r) => `<span class="muted">${esc(r.a.type || '')}</span>` },
    { key: 'fl', label: 'Uçuş', num: true, get: (r) => r.p.ops.flights, render: (r) => fmt.n0(r.p.ops.flights) },
    { key: 'fpd', label: 'Uçuş/gün', num: true, title: 'Turnover: periyottaki günlük uçuş sayısı', get: (r) => r.p.ops.perDay, render: (r) => fmt.n2(r.p.ops.perDay) },
    { key: 'bh', label: 'Blok s', num: true, get: (r) => r.p.ops.hours, render: (r) => fmt.n1(r.p.ops.hours) },
    { key: 'ut', label: 'Kullanım', num: true, get: (r) => r.p.ops.util, render: (r) => fmt.pct(r.p.ops.util) },
    { key: 'rev', label: 'Gelir', num: true, get: (r) => r.p.revenue, render: (r) => fmt.money(r.p.revenue) },
    { key: 'fix', label: 'Sabit', num: true, title: 'Leasing + park', get: (r) => r.p.fixed, render: (r) => mny(r.p.fixed) },
    { key: 'var', label: 'Değişken', num: true, title: 'Yakıt + iniş + slot + bakım + ceza', get: (r) => r.p.variable, render: (r) => mny(r.p.variable) },
    { key: 'oh', label: 'Genel', num: true, get: (r) => r.p.overhead, render: (r) => (state.overhead ? mny(r.p.overhead) : '<span class="muted">—</span>') },
    { key: 'net', label: 'Net K/Z', num: true, get: (r) => r.p.net, render: (r) => `<b>${mny(r.p.net)}</b>` },
    { key: 'mg', label: 'Marj', num: true, get: (r) => r.p.margin, render: (r) => sgn(r.p.margin, fmt.pct) },
    { key: 'pd', label: 'K/Z/gün', num: true, get: (r) => r.p.perDay, render: (r) => mny(r.p.perDay) },
    { key: 'rph', label: 'Gelir/blok s', num: true, get: (r) => r.p.revPerHour, render: (r) => fmt.money(r.p.revPerHour) },
    { key: 'cph', label: 'Gider/blok s', num: true, get: (r) => r.p.costPerHour, render: (r) => fmt.money(r.p.costPerHour) },
  ];
  renderTable($('#pnlTable'), cols, R, { sortKey: 'net', rowAttrs: (r) => `data-id="${esc(r.a.id)}" class="${r.a.id === state.sel ? 'sel' : ''}"`, onRow: select });
}

function idleTable() {
  const idle = D.aircraft.filter((a) => a.idle24h);
  const lease = (a) => LG.aircraft.find((x) => x.id === a.id)?.lease?.weekly ?? null;
  $('#idleCount').textContent = `${idle.length} UÇAK`;
  renderTable($('#idleTable'), [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: (a) => `<span class="reg">${esc(a.registration)}</span>` },
    { key: 'type', label: 'Tip', get: (a) => a.type, render: (a) => `<span class="muted">${esc(a.type)}</span>` },
    { key: 'status', label: 'Durum', get: (a) => a.status, render: (a) => statusPill(a.status) + (a.mustDoMaintenance ? ' <span class="pill critical">Bakım gerekli</span>' : '') },
    { key: 'loc', label: 'Konum', get: (a) => a.location?.icao || '', render: (a) => (a.location?.icao ? `<span class="amb">${esc(a.location.icao)}</span> <span class="muted">${esc(a.location.city || a.location.name || '')}</span>` : '—') },
    { key: 'since', label: 'Son uçuştan beri', num: true, get: (a) => a.hoursSinceLastFlight ?? 1e9, render: (a) => `<span class="${(a.hoursSinceLastFlight ?? 1e9) > 72 ? 'neg' : 'amb'}">${fmt.ago(a.hoursSinceLastFlight)}</span>` },
    { key: 'last', label: 'Son uçuş bitişi', get: (a) => a.lastFlightEnd || '', render: (a) => fmt.date(a.lastFlightEnd) },
    { key: 'lw', label: 'Haftalık leasing', num: true, get: lease, render: (a) => fmt.money(lease(a)) },
    { key: 'net', label: 'Net K/Z (tümü)', num: true, get: (a) => a.pnl?.net ?? null, render: (a) => mny(a.pnl?.net) },
  ], idle, { sortKey: 'since', empty: 'Son 24 saatte tüm uçaklar uçmuş.', rowAttrs: (a) => `data-id="${esc(a.id)}"`, onRow: select });
}

// ---------------------------------------------------------------- detail
function select(id) {
  state.sel = state.sel === id ? null : id;
  history.replaceState(null, '', state.sel ? '#' + encodeURIComponent(LG.aircraft.find((a) => a.id === id)?.registration || '') : location.pathname);
  render();
  if (state.sel) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function detail() {
  const el = $('#detail');
  const a = LG.aircraft.find((x) => x.id === state.sel);
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const p = pnl(a);
  const ops = D.aircraft.find((x) => x.id === a.id);
  const L = a.lease;
  const groups = [['revenue', 'Gelir'], ['fixed', 'Sabit giderler'], ['variable', 'Değişken giderler'], ['overhead', 'Genel gider payı']];
  const catRows = (g) => {
    if (g === 'overhead' && !state.overhead) return [];
    let r = Object.entries(p.c).filter(([c]) => CAT[c]?.group === g);
    if (g === 'fixed' && state.lease === 'accrual' && L) r = r.filter(([c]) => c !== 'lease' && c !== 'leaseRefund').concat([['leaseAccrual', p.leaseAcc]]);
    return r.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  };
  const name = (c) => (c === 'leaseAccrual' ? `Leasing (süreye göre, ${fmt.n1(leaseWeeksInPeriod(a))} hf)` : CAT[c]?.label || c);
  const breakdown = groups.map(([g, title]) => {
    const r = catRows(g); if (!r.length) return '';
    const sub = r.reduce((s, [, v]) => s + v, 0);
    return `<tr class="grp"><td>${title.toUpperCase()}</td><td class="n">${mny(sub)}</td><td class="n">${p.revenue && g !== 'revenue' ? fmt.pct((-sub / p.revenue) * 100) : ''}</td></tr>` +
      r.map(([c, v]) => `<tr><td style="padding-left:18px">${esc(name(c))}</td><td class="n">${mny(v)}</td><td class="n muted">${p.revenue && g !== 'revenue' ? fmt.pct((-v / p.revenue) * 100) : ''}</td></tr>`).join('');
  }).join('') + `<tr class="tot"><td><b>NET K/Z</b></td><td class="n"><b>${mny(p.net)}</b></td><td class="n">${sgn(p.margin, fmt.pct)}</td></tr>`;

  const contrib = p.ops.hours ? (p.revenue + p.variable) / p.ops.hours : null;
  const be = L?.weekly && contrib > 0 ? L.weekly / contrib : null;
  const nowWk = p.ops.spanDays ? p.ops.hours / (p.ops.spanDays / 7) : 0;
  const leasePct = L?.totalWeeks ? Math.min(100, (L.weeksElapsed / L.totalWeeks) * 100) : 0;
  const tiles = [
    ['Net K/Z', mny(p.net), periodLabel()],
    ['K/Z / gün', mny(p.perDay), `${fmt.n1(p.ops.spanDays)} gün`],
    ['Uçuş · blok s', `${fmt.n0(p.ops.flights)} · ${fmt.n1(p.ops.hours)}`, `${fmt.n2(p.ops.perDay)} uçuş/gün · ${fmt.pct(p.ops.util)}`],
    ['Gelir / blok s', fmt.money(p.revPerHour), `gider ${fmt.money(p.costPerHour)}`],
    ['Başabaş', be ? `${fmt.n1(be)} s/hf` : contrib != null && contrib <= 0 ? '<span class="neg">KATKI NEGATİF</span>' : '—', `leasing için gereken · şu an ${fmt.n1(nowWk)} s/hf`],
  ];
  el.innerHTML = `
    <div class="ph"><h2>${esc(a.registration)} · ${esc(a.type || '')}</h2>${a.inFleet ? (ops ? statusPill(ops.status) : '') : '<span class="tag">İADE EDİLDİ</span>'}
      ${ops?.location?.icao ? `<span class="meta">@ <span class="amb">${esc(ops.location.icao)}</span></span>` : ''}<span class="spacer"></span><a href="#" id="closeDet">KAPAT [ESC]</a></div>
    <p class="hint">${L ? `LEASING ${fmt.money(L.weekly)}/hf · ${fmt.date(L.start)} → ${fmt.date(L.end)} · ${fmt.n1(L.weeksElapsed)}/${fmt.n0(L.totalWeeks)} hafta · sonraki ödeme ${fmt.date(L.next)} · tüm zamanlarda ödenen ${fmt.money(-((a.cats.lease || 0) + (a.cats.leaseRefund || 0)))}` : 'Leasing bilgisi yok.'}</p>
    ${L ? `<div class="leasebar" title="Leasing süresi"><i style="width:${leasePct}%"></i></div>` : ''}
    <section class="kpis" style="border-left:0;border-right:0">${tiles.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value" style="font-size:17px">${v}</div><div class="sub">${s}</div></div>`).join('')}</section>
    <div class="grid2" style="gap:0">
      <div style="border-right:1px solid var(--line)"><div class="h3">Kalem kırılımı — ${periodLabel()}</div>
        <table class="breakdown"><thead><tr><th>Kalem</th><th class="n">Tutar</th><th class="n">Gelire oranı</th></tr></thead><tbody>${breakdown}</tbody></table></div>
      <div><div class="h3">Günlük gelir / gider — ${periodLabel()}</div>
        <div class="legend"><span><i style="background:var(--pos)"></i>Gelir</span><span><i style="background:var(--neg)"></i>Gider</span><span><i style="background:#fff"></i>Kümülatif net</span></div>
        <div id="acChart" class="linechart"></div></div>
    </div>
    <div class="h3" style="border-top:1px solid var(--line)">Son kasa hareketleri</div>
    <div class="table-wrap" style="max-height:300px"><table><thead><tr><th>Tarih (UTC)</th><th>Kalem</th><th>Açıklama</th><th class="n">Tutar</th></tr></thead><tbody>
      ${a.tx.map((t) => `<tr><td class="muted">${t.t.slice(0, 16).replace('T', ' ')}</td><td class="amb">${esc((CAT[t.cat]?.label || t.cat).toUpperCase())}</td><td style="white-space:normal">${esc(t.desc)}</td><td class="n">${mny(t.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Kayıt yok</td></tr>'}
    </tbody></table></div>`;
  $('#closeDet').addEventListener('click', (e) => { e.preventDefault(); select(state.sel); });
  dailyChart($('#acChart'), [{ a }], true);
}

// ---------------------------------------------------------------- wiring
function render() {
  const R = rows();
  kpis(R); dailyChart($('#dailyChart'), R); pnlBars(R); table(R); detail(); idleTable();
}

const setSeg = (id, v) => $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === v));
function seg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg(id, b.dataset.v); fn(b.dataset.v); render();
  });
}

(async () => {
  try {
    D = await loadJson('data/dashboard.json');
  } catch (e) {
    terminalHeader('fleet', null);
    $('main').innerHTML = `<div class="banner">VERİ YÜKLENEMEDİ: ${esc(e.message)}</div>`;
    return;
  }
  NOW = Date.parse(D.generatedAt);
  LG = D.ledger || { aircraft: [], categories: {} };
  for (const a of LG.aircraft) { a.daily ||= []; a.tx ||= []; a.cats ||= {}; }
  CAT = LG.categories;
  for (const f of D.flights || []) {
    if (!flightsByAc.has(f.aircraftId)) flightsByAc.set(f.aircraftId, []);
    flightsByAc.get(f.aircraftId).push({ t: Date.parse(f.start), hours: f.hours });
  }
  terminalHeader('fleet', D);
  demoBanner(D);
  if (LG.excluded?.n) $('#foot').textContent += ` · Uçak dışı şirket kalemleri (sermaye, FBO): ${LG.excluded.n} satır, ${fmt.money(LG.excluded.sum)}.`;
  seg('#period', (v) => { state.period = v; });
  seg('#leaseBasis', (v) => { state.lease = v; });
  seg('#overhead', (v) => { state.overhead = v === '1'; });
  $('#showFormer').addEventListener('change', (e) => { state.former = e.target.checked; render(); });
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input')) return;
    const map = { 1: '7', 2: '30', 3: '90', 4: 'all' };
    if (map[e.key]) { state.period = map[e.key]; setSeg('#period', map[e.key]); render(); }
    if (e.key === 'Escape' && state.sel) select(state.sel);
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  });
  const h = decodeURIComponent(location.hash.slice(1));
  const pre = LG.aircraft.find((a) => a.registration === h && a.inFleet) || LG.aircraft.find((a) => a.registration === h);
  if (pre) state.sel = pre.id;
  render();
  addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 150); });
})();
