import { $, esc, fmt, loadJson, statusPill, HOLDING, renderTable, renderBars, setUpdated, demoBanner } from './common.js';

const state = { weeks: 4.2857, basis: 'd7', q: '' };
let D;

const weeklyHours = (a) =>
  state.basis === 'd7' ? a.turnover.d7.blockHours
  : state.basis === 'd30' ? a.turnover.d30.blockHours * (7 / 30)
  : a.economics?.onairWeeklyHours ?? 0;

function project(a) {
  const m = a.economics;
  if (!m) return null;
  const h = weeklyHours(a) * state.weeks;
  const revenue = m.revenuePerHour * h;
  const variable = m.variableCostPerHour * h;
  const fixed = m.fixedCostPerWeek * state.weeks;
  return { hours: h, revenue, variable, fixed, cost: variable + fixed, profit: revenue - variable - fixed };
}

const horizonLabel = () => ({ 1: '1 hafta', 4.2857: '30 gün', 13.0357: '90 gün', 52.1429: '1 yıl' }[state.weeks] || `${state.weeks} hafta`);
const basisLabel = () => ({ d7: 'son 7 günün kullanımı', d30: 'son 30 günün kullanımı', onair: 'OnAir tip ortalaması' }[state.basis]);

function match(a) {
  if (!state.q) return true;
  const s = `${a.registration} ${a.nickname || ''} ${a.type} ${a.location?.icao || ''} ${a.location?.name || ''}`.toLowerCase();
  return s.includes(state.q);
}

function kpis(list) {
  const p = list.map(project).filter(Boolean);
  const sum = (k) => p.reduce((s, x) => s + x[k], 0);
  const h7 = list.reduce((s, a) => s + a.turnover.d7.blockHours, 0);
  const f7 = list.reduce((s, a) => s + a.turnover.d7.flights, 0);
  const idle = list.filter((a) => a.idle24h).length;
  const tiles = [
    ['Uçak', fmt.n0(list.length), D.company ? esc(D.company.name) : ''],
    ['Uçuş (7 gün)', fmt.n0(f7), `${fmt.n2(list.length ? f7 / 7 / list.length : 0)} uçuş/gün/uçak`],
    ['Blok saat (7 gün)', fmt.n1(h7), `Filo kullanımı ${fmt.pct(list.length ? (h7 / (168 * list.length)) * 100 : 0)}`],
    [`Gelir (${horizonLabel()})`, fmt.compact(sum('revenue')), basisLabel()],
    [`Gider (${horizonLabel()})`, fmt.compact(sum('cost')), `Sabit: ${fmt.compact(sum('fixed'))}`],
    [`Kâr (${horizonLabel()})`, `<span class="${sum('profit') < 0 ? 'neg' : ''}">${fmt.compact(sum('profit'))}</span>`, 'öngörü'],
    ['24s+ uçmayan', fmt.n0(idle), `${fmt.pct(list.length ? (idle / list.length) * 100 : 0)} filo`],
  ];
  if (D.cash?.current != null) tiles.push(['Kasa', fmt.compact(D.cash.current), 'şirket nakdi']);
  $('#kpis').innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
}

function charts(list) {
  const items = list.map((a) => ({ a, p: project(a) })).filter((x) => x.p)
    .map(({ a, p }) => ({ label: a.registration, value: p.profit, a, p })).sort((x, y) => y.value - x.value);
  $('#profitHint').textContent = `${horizonLabel()} · ${basisLabel()} · sabit giderler (sahiplik/leasing) dahil`;
  renderBars($('#profitBars'), items, {
    diverging: true, format: fmt.compact,
    tipRows: (it) => [['Tip', it.a.type], ['Saat', fmt.n1(it.p.hours)], ['Gelir', fmt.money(it.p.revenue)], ['Değişken gider', fmt.money(it.p.variable)], ['Sabit gider', fmt.money(it.p.fixed)], ['Kâr', fmt.money(it.p.profit)]],
  });
  const u = list.map((a) => ({ label: a.registration, value: a.turnover.d7.utilisationPct ?? 0, a })).sort((x, y) => y.value - x.value);
  renderBars($('#utilBars'), u, {
    format: fmt.pct, color: 'var(--seq)',
    tipRows: (it) => [['Tip', it.a.type], ['Uçuş/gün', fmt.n2(it.a.turnover.d7.flightsPerDay)], ['Saat/gün', fmt.n2(it.a.turnover.d7.hoursPerDay)], ['Ort. turnaround', it.a.turnover.d7.avgTurnaroundHours == null ? '—' : fmt.n1(it.a.turnover.d7.avgTurnaroundHours) + ' s'], ['30 gün kullanım', fmt.pct(it.a.turnover.d30.utilisationPct)]],
  });
}

const regCell = (a) => `<span class="reg">${esc(a.registration)}</span>${a.nickname ? ` <span class="muted">${esc(a.nickname)}</span>` : ''}`;
const loc = (a) => (a.location?.icao ? `${esc(a.location.icao)} <span class="muted">${esc(a.location.city || a.location.name || '')}</span>` : '—');

function tables(list) {
  const idle = list.filter((a) => a.idle24h);
  $('#idleCount').textContent = `${idle.length} uçak`;
  renderTable($('#idleTable'), [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: regCell },
    { key: 'type', label: 'Tip', get: (a) => a.type },
    { key: 'status', label: 'Durum', get: (a) => a.status, render: (a) => statusPill(a.status) + (a.mustDoMaintenance ? ' <span class="pill critical">Bakım gerekli</span>' : '') },
    { key: 'loc', label: 'Konum', get: (a) => a.location?.icao || '', render: loc },
    { key: 'since', label: 'Son uçuştan beri', num: true, get: (a) => a.hoursSinceLastFlight ?? 1e9, render: (a) => fmt.ago(a.hoursSinceLastFlight) },
    { key: 'last', label: 'Son uçuş bitişi', get: (a) => a.lastFlightEnd || '', render: (a) => fmt.date(a.lastFlightEnd) },
    { key: 'fixed', label: 'Boşta haftalık sabit gider', num: true, get: (a) => a.economics?.fixedCostPerWeek ?? null, render: (a) => fmt.money(a.economics?.fixedCostPerWeek) },
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
    { key: 'n30', label: 'Uçuş (30g)', num: true, get: (a) => a.turnover.d30.flights, render: (a) => fmt.n0(a.turnover.d30.flights) },
    { key: 'cond', label: 'Gövde kondisyonu', num: true, get: (a) => a.condition, render: (a) => fmt.pct(a.condition) },
  ], list, { sortKey: 'f7' });

  $('#projHint').textContent = `${horizonLabel()} için, ${basisLabel()} varsayımıyla. Saatlik değerler OnAir economic_details'ten; "Gerçek 30g" kasa hareketlerinde tescil geçen satırların toplamıdır (eşleşen ${D.cashMatch?.matched ?? 0}/${D.cashMatch?.total ?? 0} satır).`;
  renderTable($('#projTable'), [
    { key: 'reg', label: 'Tescil', get: (a) => a.registration, render: regCell },
    { key: 'type', label: 'Tip', get: (a) => a.type },
    { key: 'hold', label: 'Sahiplik', get: (a) => a.holding, render: (a) => esc(HOLDING[a.holding] || a.holding) },
    { key: 'rph', label: 'Gelir/saat', num: true, get: (a) => a.economics?.revenuePerHour ?? null, render: (a) => fmt.money(a.economics?.revenuePerHour) },
    { key: 'cph', label: 'Değişken gider/saat', num: true, title: 'Yakıt + ekip + bakım (+ kira)', get: (a) => a.economics?.variableCostPerHour ?? null, render: (a) => fmt.money(a.economics?.variableCostPerHour) },
    { key: 'fpw', label: 'Sabit gider/hafta', num: true, get: (a) => a.economics?.fixedCostPerWeek ?? null, render: (a) => fmt.money(a.economics?.fixedCostPerWeek) },
    { key: 'wh', label: 'Haftalık saat', num: true, get: (a) => weeklyHours(a), render: (a) => fmt.n1(weeklyHours(a)) },
    { key: 'rev', label: 'Gelir', num: true, get: (a) => project(a)?.revenue ?? null, render: (a) => fmt.money(project(a)?.revenue) },
    { key: 'cost', label: 'Gider', num: true, get: (a) => project(a)?.cost ?? null, render: (a) => fmt.money(project(a)?.cost) },
    { key: 'profit', label: 'Kâr', num: true, get: (a) => project(a)?.profit ?? null, render: (a) => { const p = project(a)?.profit; return `<span class="${p < 0 ? 'neg' : ''}">${fmt.money(p)}</span>`; } },
    { key: 'be', label: 'Başabaş saat/hafta', num: true, title: 'Sabit gideri karşılamak için gereken haftalık uçuş saati',
      get: (a) => breakEven(a), render: (a) => fmt.n1(breakEven(a)) },
    { key: 'act', label: 'Gerçek 30g (kasa)', num: true, get: (a) => a.cashFlow30d?.net ?? null, render: (a) => (a.cashFlow30d ? `<span class="${a.cashFlow30d.net < 0 ? 'neg' : ''}">${fmt.money(a.cashFlow30d.net)}</span>` : '<span class="muted">—</span>') },
  ], list, { sortKey: 'profit' });
}

function breakEven(a) {
  const m = a.economics;
  if (!m) return null;
  const margin = m.revenuePerHour - m.variableCostPerHour;
  return margin > 0 ? m.fixedCostPerWeek / margin : null;
}

function render() {
  const list = D.aircraft.filter(match);
  kpis(list); charts(list); tables(list);
}

function seg(id, key, parse = (v) => v) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    state[key] = parse(b.dataset.v); render();
  });
}

(async () => {
  try {
    D = await loadJson('data/dashboard.json');
  } catch (e) {
    $('main').innerHTML = `<div class="card"><h2>Veri yüklenemedi</h2><p class="hint">${esc(e.message)}. GitHub Actions iş akışının çalıştığından emin olun.</p></div>`;
    return;
  }
  if (D.company?.name) { $('#title').innerHTML = `${esc(D.company.name)} <small>${esc(D.company.code || '')}</small>`; document.title = `${D.company.name} · Filo`; }
  $('#idleH').textContent = D.settings?.idleHours ?? 24;
  setUpdated($('#updated'), D);
  demoBanner(D);
  seg('#horizon', 'weeks', Number); seg('#basis', 'basis');
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  render();
})();
