import { $, esc, fmt, loadJson, statusPill, renderTable, renderBars, setUpdated, demoBanner, showTip, hideTip } from './common.js';

const state = { lease: 'cash', overhead: true, former: true, q: '', sel: null };
let D, LG, CAT;

// ---------------------------------------------------------------- P&L under current settings
function pnl(a) {
  const leaseCash = (a.cats.lease || 0) + (a.cats.leaseRefund || 0);
  const fixed = state.lease === 'accrual' ? a.fixed - leaseCash - a.leaseAccrued : a.fixed;
  const overhead = state.overhead ? a.overhead : 0;
  const cost = fixed + a.variable + overhead; // negative
  const net = a.revenue + cost;
  const days = a.days || null;
  return {
    revenue: a.revenue, fixed, variable: a.variable, overhead, cost, net,
    perDay: days ? net / days : null,
    revPerHour: a.blockHours ? a.revenue / a.blockHours : null,
    costPerHour: a.blockHours ? -cost / a.blockHours : null,
    margin: a.revenue ? (net / a.revenue) * 100 : null,
  };
}

const ledgerRows = () => LG.aircraft.filter((a) => (state.former || a.inFleet) && match(a));
function match(a) {
  if (!state.q) return true;
  return `${a.registration} ${a.type || ''}`.toLowerCase().includes(state.q);
}
const dashById = () => new Map(D.aircraft.map((a) => [a.id, a]));

// ---------------------------------------------------------------- KPIs
function kpis() {
  const rows = ledgerRows().map((a) => pnl(a));
  const s = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const fleetRows = D.aircraft.filter(match);
  const idle = fleetRows.filter((a) => a.idle24h).length;
  const net = s('net');
  const tiles = [
    ['Uçak (filo)', fmt.n0(fleetRows.length), `${LG.aircraft.filter((a) => !a.inFleet).length} iade edilmiş`],
    ['Toplam gelir', fmt.compact(s('revenue')), 'kiralamadan bugüne'],
    ['Sabit gider', fmt.compact(-s('fixed')), state.lease === 'cash' ? 'leasing (ödenen) + park' : 'leasing (tahakkuk) + park'],
    ['Değişken gider', fmt.compact(-s('variable')), 'yakıt, iniş, slot, bakım'],
    ['Genel gider payı', state.overhead ? fmt.compact(-s('overhead')) : '—', state.overhead ? 'personel, otel, ceza, filo yön.' : 'hariç tutuldu'],
    ['Net K/Z', `<span class="${net < 0 ? 'neg' : ''}">${fmt.compact(net)}</span>`, s('revenue') ? `marj ${fmt.pct((net / s('revenue')) * 100)}` : ''],
    ['24s+ uçmayan', fmt.n0(idle), `${fmt.pct(fleetRows.length ? (idle / fleetRows.length) * 100 : 0)} filo`],
  ];
  if (D.cash?.current != null) tiles.push(['Kasa', fmt.compact(D.cash.current), 'şirket nakdi']);
  $('#kpis').innerHTML = tiles.map(([l, v, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
}

// ---------------------------------------------------------------- charts
function charts() {
  const items = ledgerRows().map((a) => ({ a, p: pnl(a) })).map(({ a, p }) => ({ label: a.registration + (a.inFleet ? '' : ' ⟲'), value: p.net, a, p }))
    .sort((x, y) => y.value - x.value);
  $('#pnlHint').textContent = `Kiralamadan bugüne · leasing ${state.lease === 'cash' ? 'ödenen' : 'geçen süreye göre'} · genel gider ${state.overhead ? 'dağıtılmış' : 'hariç'}. ⟲ = iade edilmiş`;
  renderBars($('#pnlBars'), items, {
    diverging: true, format: fmt.compact,
    tipRows: (it) => [['Tip', it.a.type || '—'], ['Gün', fmt.n1(it.a.days)], ['Gelir', fmt.money(it.p.revenue)], ['Sabit', fmt.money(it.p.fixed)], ['Değişken', fmt.money(it.p.variable)], ['Genel gider', fmt.money(it.p.overhead)], ['Net', fmt.money(it.p.net)]],
  });
  $('#pnlBars').querySelectorAll('.row-hit').forEach((row) => row.querySelectorAll('div').forEach((d) => {
    d.style.cursor = 'pointer'; d.addEventListener('click', () => select(items[+row.dataset.i].a.id));
  }));

  const u = D.aircraft.filter(match).map((a) => ({ label: a.registration, value: a.turnover.d7.utilisationPct ?? 0, a })).sort((x, y) => y.value - x.value);
  renderBars($('#utilBars'), u, {
    format: fmt.pct, color: 'var(--seq)',
    tipRows: (it) => [['Tip', it.a.type], ['Uçuş/gün', fmt.n2(it.a.turnover.d7.flightsPerDay)], ['Saat/gün', fmt.n2(it.a.turnover.d7.hoursPerDay)], ['Ort. turnaround', it.a.turnover.d7.avgTurnaroundHours == null ? '—' : fmt.n1(it.a.turnover.d7.avgTurnaroundHours) + ' s'], ['30 gün kullanım', fmt.pct(it.a.turnover.d30.utilisationPct)]],
  });
}

// ---------------------------------------------------------------- tables
const money = (v) => `<span class="${v < 0 ? 'neg' : ''}">${fmt.money(v)}</span>`;
const regCell = (a) => `<span class="reg">${esc(a.registration)}</span>${a.inFleet === false ? ' <span class="pill">iade</span>' : ''}${a.nickname ? ` <span class="muted">${esc(a.nickname)}</span>` : ''}`;
const loc = (a) => (a.location?.icao ? `${esc(a.location.icao)} <span class="muted">${esc(a.location.city || a.location.name || '')}</span>` : '—');

function pnlTable() {
  $('#tableHint').textContent = `Kasa defterinden (${LG.entries} satır, ${fmt.date(LG.from)} → ${fmt.date(LG.to)}). Gelir ve doğrudan giderler OnAir'in her kasa satırına yazdığı uçak kimliğiyle eşleşir; slot ücretleri sefer numarası → rota → uçak ile bağlanır.`;
  const cols = [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: regCell },
    { key: 'type', label: 'Tip', get: (a) => a.type || '' },
    { key: 'since', label: 'Başlangıç', get: (a) => a.since || '', render: (a) => (a.since ? new Date(a.since).toLocaleDateString('tr-TR') : '—') },
    { key: 'days', label: 'Gün', num: true, get: (a) => a.days, render: (a) => fmt.n1(a.days) },
    { key: 'fl', label: 'Uçuş', num: true, get: (a) => a.flights, render: (a) => fmt.n0(a.flights) },
    { key: 'bh', label: 'Blok saat', num: true, get: (a) => a.blockHours, render: (a) => fmt.n1(a.blockHours) },
    { key: 'rev', label: 'Gelir', num: true, get: (a) => pnl(a).revenue, render: (a) => fmt.money(pnl(a).revenue) },
    { key: 'fix', label: 'Sabit gider', num: true, title: 'Leasing + park', get: (a) => pnl(a).fixed, render: (a) => money(pnl(a).fixed) },
    { key: 'var', label: 'Değişken gider', num: true, title: 'Yakıt + iniş + slot + bakım + uçağa ait ceza', get: (a) => pnl(a).variable, render: (a) => money(pnl(a).variable) },
    { key: 'oh', label: 'Genel gider', num: true, get: (a) => pnl(a).overhead, render: (a) => (state.overhead ? money(pnl(a).overhead) : '<span class="muted">—</span>') },
    { key: 'net', label: 'Net K/Z', num: true, get: (a) => pnl(a).net, render: (a) => `<b>${money(pnl(a).net)}</b>` },
    { key: 'pd', label: 'K/Z / gün', num: true, get: (a) => pnl(a).perDay, render: (a) => money(pnl(a).perDay) },
    { key: 'rph', label: 'Gelir / blok saat', num: true, get: (a) => pnl(a).revPerHour, render: (a) => fmt.money(pnl(a).revPerHour) },
    { key: 'cph', label: 'Gider / blok saat', num: true, get: (a) => pnl(a).costPerHour, render: (a) => fmt.money(pnl(a).costPerHour) },
    { key: 'mg', label: 'Marj', num: true, get: (a) => pnl(a).margin, render: (a) => fmt.pct(pnl(a).margin) },
  ];
  const el = $('#pnlTable');
  renderTable(el, cols, ledgerRows(), { sortKey: 'net' });
  wireRowClicks(el);
}
function wireRowClicks(el) {
  // renderTable re-renders on sort; re-wire each time
  const rows = [...el.querySelectorAll('tbody tr')];
  const regs = rows.map((tr) => tr.querySelector('.reg')?.textContent);
  rows.forEach((tr, i) => {
    tr.style.cursor = 'pointer';
    const a = LG.aircraft.find((x) => x.registration === regs[i]);
    if (a && a.id === state.sel) tr.style.background = 'var(--surface-0)';
    tr.addEventListener('click', () => a && select(a.id));
  });
  el.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => setTimeout(() => wireRowClicks(el), 0)));
}

function opsTables() {
  const list = D.aircraft.filter(match);
  const idle = list.filter((a) => a.idle24h);
  $('#idleCount').textContent = `${idle.length} uçak`;
  renderTable($('#idleTable'), [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: regCell },
    { key: 'type', label: 'Tip', get: (a) => a.type },
    { key: 'status', label: 'Durum', get: (a) => a.status, render: (a) => statusPill(a.status) + (a.mustDoMaintenance ? ' <span class="pill critical">Bakım gerekli</span>' : '') },
    { key: 'loc', label: 'Konum', get: (a) => a.location?.icao || '', render: loc },
    { key: 'since', label: 'Son uçuştan beri', num: true, get: (a) => a.hoursSinceLastFlight ?? 1e9, render: (a) => fmt.ago(a.hoursSinceLastFlight) },
    { key: 'last', label: 'Son uçuş bitişi', get: (a) => a.lastFlightEnd || '', render: (a) => fmt.date(a.lastFlightEnd) },
    { key: 'net', label: 'Net K/Z (bugüne)', num: true, get: (a) => a.pnl?.net ?? null, render: (a) => money(a.pnl?.net) },
  ], idle, { sortKey: 'since', empty: 'Harika — son 24 saatte tüm uçaklar uçmuş.' });

  renderTable($('#turnTable'), [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: regCell },
    { key: 'type', label: 'Tip', get: (a) => a.type },
    { key: 'status', label: 'Durum', get: (a) => a.status, render: (a) => statusPill(a.status) },
    { key: 'f7', label: 'Uçuş/gün (7g)', num: true, get: (a) => a.turnover.d7.flightsPerDay, render: (a) => fmt.n2(a.turnover.d7.flightsPerDay) },
    { key: 'f30', label: 'Uçuş/gün (30g)', num: true, get: (a) => a.turnover.d30.flightsPerDay, render: (a) => fmt.n2(a.turnover.d30.flightsPerDay) },
    { key: 'h7', label: 'Saat/gün (7g)', num: true, get: (a) => a.turnover.d7.hoursPerDay, render: (a) => fmt.n2(a.turnover.d7.hoursPerDay) },
    { key: 'u7', label: 'Kullanım 7g', num: true, get: (a) => a.turnover.d7.utilisationPct, render: (a) => fmt.pct(a.turnover.d7.utilisationPct) },
    { key: 'u30', label: 'Kullanım 30g', num: true, get: (a) => a.turnover.d30.utilisationPct, render: (a) => fmt.pct(a.turnover.d30.utilisationPct) },
    { key: 'ta', label: 'Ort. turnaround', num: true, get: (a) => a.turnover.d7.avgTurnaroundHours, render: (a) => (a.turnover.d7.avgTurnaroundHours == null ? '—' : fmt.n1(a.turnover.d7.avgTurnaroundHours) + ' s') },
    { key: 'cond', label: 'Gövde kondisyonu', num: true, get: (a) => a.condition, render: (a) => fmt.pct(a.condition) },
  ], list, { sortKey: 'f7' });
}

// ---------------------------------------------------------------- detail panel
function select(id) {
  state.sel = id;
  renderDetail();
  pnlTable();
  $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDetail() {
  const el = $('#detail');
  const a = LG.aircraft.find((x) => x.id === state.sel);
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const p = pnl(a);
  const ops = dashById().get(a.id);
  const L = a.lease;
  const leaseCash = (a.cats.lease || 0) + (a.cats.leaseRefund || 0);

  // category breakdown grouped
  const groups = [['revenue', 'Gelir'], ['fixed', 'Sabit giderler'], ['variable', 'Değişken giderler'], ['overhead', 'Genel gider payı']];
  const catRows = (g) => {
    let rows = Object.entries(a.cats).filter(([c]) => CAT[c]?.group === g);
    if (g === 'fixed' && state.lease === 'accrual') rows = rows.filter(([c]) => c !== 'lease' && c !== 'leaseRefund').concat([['leaseAccrual', -a.leaseAccrued]]);
    if (g === 'overhead' && !state.overhead) return [];
    return rows.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  };
  const label = (c) => (c === 'leaseAccrual' ? `Leasing (tahakkuk, ${fmt.n1(L?.weeksElapsed)} hafta)` : CAT[c]?.label || c);
  const breakdown = groups.map(([g, title]) => {
    const rows = catRows(g);
    if (!rows.length) return '';
    const sub = rows.reduce((s, [, v]) => s + v, 0);
    return `<tr class="grp"><td><b>${title}</b></td><td class="n"><b>${money(sub)}</b></td><td class="n muted">${p.revenue ? fmt.pct((Math.abs(sub) / p.revenue) * 100) : ''}</td></tr>` +
      rows.map(([c, v]) => `<tr><td style="padding-left:22px">${esc(label(c))}</td><td class="n">${money(v)}</td><td class="n muted">${p.revenue && g !== 'revenue' ? fmt.pct((Math.abs(v) / p.revenue) * 100) : ''}</td></tr>`).join('');
  }).join('') + `<tr class="grp"><td><b>Net K/Z</b></td><td class="n"><b>${money(p.net)}</b></td><td class="n muted">${fmt.pct(p.margin)}</td></tr>`;

  const tiles = [
    ['Net K/Z', money(p.net), `${fmt.n1(a.days)} günde`],
    ['K/Z / gün', money(p.perDay), ''],
    ['Gelir / blok saat', fmt.money(p.revPerHour), `${fmt.n1(a.blockHours)} saat, ${fmt.n0(a.flights)} uçuş`],
    ['Gider / blok saat', fmt.money(p.costPerHour), 'tüm giderler'],
    ['Başabaş uçuş saati', breakEven(a), 'haftalık leasing\'i karşılamak için'],
  ];

  el.innerHTML = `
    <div class="card-head"><h2>${esc(a.registration)} <span class="muted" style="font-weight:500">${esc(a.type || '')}</span> ${a.inFleet ? (ops ? statusPill(ops.status) : '') : '<span class="pill">iade edildi</span>'}</h2>
      <span class="spacer"></span><a href="#" id="closeDet">kapat ✕</a></div>
    <p class="hint">${L ? `Leasing: haftalık ${fmt.money(L.weekly)} · ${fmt.date(L.start)} → ${fmt.date(L.end)} (${fmt.n0(L.totalWeeks)} hafta, ${fmt.n1(L.weeksElapsed)} hafta geçti) · sonraki ödeme ${fmt.date(L.next)} · ödenen toplam ${fmt.money(-leaseCash)}` : 'Leasing bilgisi yok (iade edilmiş olabilir).'}</p>
    <div class="kpis" style="margin-bottom:12px">${tiles.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value" style="font-size:18px">${v}</div><div class="sub">${s}</div></div>`).join('')}</div>
    <div class="grid2">
      <div><h3 class="h3">Kalem kırılımı</h3><div class="table-wrap" style="max-height:none"><table class="breakdown"><thead><tr><th>Kalem</th><th class="n">Tutar</th><th class="n">Gelire oranı</th></tr></thead><tbody>${breakdown}</tbody></table></div></div>
      <div><h3 class="h3">Kümülatif gelir, gider ve net (nakit bazında)</h3>
        <div class="legend"><span><i style="background:var(--series-rev)"></i>Gelir</span><span><i style="background:var(--series-cost)"></i>Gider</span><span><i style="background:var(--text-primary)"></i>Net</span></div>
        <div id="cumChart" class="linechart"></div></div>
    </div>
    <h3 class="h3" style="margin-top:14px">Son kasa hareketleri</h3>
    <div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Tarih</th><th>Kalem</th><th>Açıklama</th><th class="n">Tutar</th></tr></thead><tbody>
      ${a.tx.map((t) => `<tr><td>${fmt.date(t.t)}</td><td>${esc(CAT[t.cat]?.label || t.cat)}</td><td class="muted" style="white-space:normal">${esc(t.desc)}</td><td class="n">${money(t.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Kayıt yok</td></tr>'}
    </tbody></table></div>`;
  $('#closeDet').addEventListener('click', (e) => { e.preventDefault(); state.sel = null; el.hidden = true; pnlTable(); });
  lineChart($('#cumChart'), a.timeline);
}

/** Weekly block hours needed so that flight contribution (revenue − variable cost) covers the weekly lease. */
function breakEven(a) {
  const L = a.lease;
  if (!L?.weekly || !a.inFleet || !a.blockHours) return '—';
  const contrib = (a.revenue + a.variable) / a.blockHours;
  if (contrib <= 0) return '<span class="neg">uçuş başına zarar</span>';
  const need = L.weekly / contrib;
  const now = a.days ? a.blockHours / (a.days / 7) : 0;
  return `${fmt.n1(need)} s/hafta <span class="muted" style="font-size:12px">(şu an ${fmt.n1(now)})</span>`;
}

/** Cumulative line chart: revenue, total cost (abs), net. timeline rows: [day, rev, fixed, variable, overhead] (cumulative). */
function lineChart(el, tl) {
  if (!tl?.length) { el.innerHTML = '<div class="empty">Veri yok</div>'; return; }
  const pts = tl.map(([d, r, f, v, o]) => ({ d, rev: r, cost: -(f + v + (state.overhead ? o : 0)), net: r + f + v + (state.overhead ? o : 0) }));
  if (pts.length === 1) pts.unshift({ ...pts[0], rev: 0, cost: 0, net: 0 });
  const W = el.clientWidth || 560, H = 240, m = { l: 64, r: 12, t: 10, b: 24 };
  const xs = pts.map((p) => Date.parse(p.d));
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const vals = pts.flatMap((p) => [p.rev, p.cost, p.net, 0]);
  const y0 = Math.min(...vals), y1 = Math.max(...vals);
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(Date.parse(p.d)).toFixed(1)},${Y(p[k]).toFixed(1)}`).join('');
  const ticks = niceTicks(y0, y1, 4);
  const dTicks = [pts[0], pts[Math.floor(pts.length / 2)], pts.at(-1)];
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Kümülatif gelir, gider ve net">
    ${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${fmt.compact(v)}</text>`).join('')}
    <line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--text-muted)"/>
    ${dTicks.map((p) => `<text x="${X(Date.parse(p.d))}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${new Date(p.d).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' })}</text>`).join('')}
    <path d="${path('rev')}" fill="none" stroke="var(--series-rev)" stroke-width="2"/>
    <path d="${path('cost')}" fill="none" stroke="var(--series-cost)" stroke-width="2"/>
    <path d="${path('net')}" fill="none" stroke="var(--text-primary)" stroke-width="2.5"/>
    <line id="xh" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-muted)" stroke-dasharray="3 3" visibility="hidden"/>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="hit"/>
  </svg>`;
  const svg = el.querySelector('svg'), xh = svg.querySelector('#xh');
  svg.querySelector('#hit').addEventListener('mousemove', (e) => {
    const bx = svg.getBoundingClientRect().left;
    const t = x0 + ((e.clientX - bx - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const p = pts.reduce((best, q) => (Math.abs(Date.parse(q.d) - t) < Math.abs(Date.parse(best.d) - t) ? q : best));
    const xx = X(Date.parse(p.d)); xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.setAttribute('visibility', 'visible');
    showTip(e, new Date(p.d).toLocaleDateString('tr-TR'), [['Kümülatif gelir', fmt.money(p.rev)], ['Kümülatif gider', fmt.money(p.cost)], ['Net', fmt.money(p.net)]]);
  });
  svg.querySelector('#hit').addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
}
function niceTicks(a, b, n) {
  const span = b - a || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= step0);
  const out = []; for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(v); return out;
}

// ---------------------------------------------------------------- wiring
function render() { kpis(); charts(); pnlTable(); renderDetail(); opsTables(); }

function seg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    fn(b.dataset.v); render();
  });
}

(async () => {
  try {
    D = await loadJson('data/dashboard.json');
  } catch (e) {
    $('main').innerHTML = `<div class="card"><h2>Veri yüklenemedi</h2><p class="hint">${esc(e.message)}. GitHub Actions iş akışının çalıştığından emin olun.</p></div>`;
    return;
  }
  LG = D.ledger || { aircraft: [], categories: {} };
  CAT = LG.categories;
  if (D.company?.name) { $('#title').innerHTML = `${esc(D.company.name)} <small>${esc(D.company.code || '')}</small>`; document.title = `${D.company.name} · Filo`; }
  $('#idleH').textContent = D.settings?.idleHours ?? 24;
  setUpdated($('#updated'), D);
  demoBanner(D);
  if (LG.excluded?.n) $('#foot').textContent += ` Uçak dışı tutulan şirket kalemleri (sermaye, FBO vb.): ${LG.excluded.n} satır, ${fmt.money(LG.excluded.sum)}.`;
  seg('#leaseBasis', (v) => { state.lease = v; });
  seg('#overhead', (v) => { state.overhead = v === '1'; });
  $('#showFormer').addEventListener('change', (e) => { state.former = e.target.checked; render(); });
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const pre = LG.aircraft.find((a) => a.registration === fromHash);
  if (pre) state.sel = pre.id;
  render();
})();
