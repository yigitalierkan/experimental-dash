// Shared helpers (no build step, no dependencies)
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const fmt = {
  n0: (v) => (v == null || !Number.isFinite(v) ? '—' : nf0.format(v)),
  n1: (v) => (v == null || !Number.isFinite(v) ? '—' : nf1.format(v)),
  n2: (v) => (v == null || !Number.isFinite(v) ? '—' : nf2.format(v)),
  money: (v) => (v == null || !Number.isFinite(v) ? '—' : (v < 0 ? '−$' : '$') + nf0.format(Math.abs(Math.round(v)))),
  compact: (v) => {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e9) return `${s}$${nf1.format(a / 1e9)}B`;
    if (a >= 1e6) return `${s}$${nf1.format(a / 1e6)}M`;
    if (a >= 1e3) return `${s}$${nf0.format(a / 1e3)}K`;
    return `${s}$${nf0.format(a)}`;
  },
  pct: (v) => (v == null || !Number.isFinite(v) ? '—' : nf1.format(v) + '%'),
  ago: (h) => {
    if (h == null) return 'hiç uçmamış';
    if (h < 1) return `${Math.round(h * 60)} dk`;
    if (h < 48) return `${nf1.format(h)} saat`;
    return `${nf0.format(h / 24)} gün`;
  },
  date: (iso) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—'),
};

export async function loadJson(path) {
  const r = await fetch(`${path}?t=${Date.now()}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export const STATUS = {
  Idle: ['Boşta', 'good'], InFlight: ['Uçuşta', 'good'], Maintenance: ['Bakımda', 'serious'], ApronWork: ['Apron işi', 'warning'],
  Warp: ['Warp', 'warning'], Ferry: ['Ferry', 'warning'],
};
export const statusPill = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };
export const HOLDING = { own: 'Sahip', lease: 'Leasing', rent: 'Kiralık' };

// ---------------------------------------------------------------- tooltip
const tip = document.createElement('div');
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
export function showTip(e, title, rows) {
  tip.innerHTML = `<b>${esc(title)}</b>` + rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  tip.style.display = 'block';
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = e.clientY - h - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
export const hideTip = () => { tip.style.display = 'none'; };

// ---------------------------------------------------------------- sortable table
/**
 * cols: [{ key, label, num?, get(row) -> sortable value, render(row) -> html }]
 */
export function renderTable(el, cols, rows, { sortKey, sortDir = 'desc', empty = 'Kayıt yok' } = {}) {
  const state = el._state || (el._state = { sortKey, sortDir });
  const col = cols.find((c) => c.key === state.sortKey);
  const sorted = col ? [...rows].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
    const r = typeof va === 'string' ? va.localeCompare(vb, 'tr') : va - vb;
    return state.sortDir === 'asc' ? r : -r;
  }) : rows;
  el.innerHTML = `<table><thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.num ? 'n' : ''}" ${c.key === state.sortKey ? `aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''} ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${sorted.length ? sorted.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'n' : ''}">${c.render ? c.render(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">${esc(empty)}</td></tr>`}</tbody></table>`;
  el.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    state.sortDir = state.sortKey === k && state.sortDir === 'desc' ? 'asc' : 'desc';
    state.sortKey = k;
    renderTable(el, cols, rows, { empty });
  }));
}

/** Horizontal bar list; diverging around zero when values have both signs. */
export function renderBars(el, items, { format = fmt.n0, color = 'var(--seq)', diverging = false, tipRows } = {}) {
  if (!items.length) { el.innerHTML = '<div class="empty">Veri yok</div>'; return; }
  const max = Math.max(...items.map((i) => Math.max(0, i.value)), 0);
  const min = Math.min(...items.map((i) => Math.min(0, i.value)), 0);
  const span = (max - min) || 1;
  const zero = diverging ? (-min / span) * 100 : 0;
  el.innerHTML = `<div class="bars">${items.map((it, idx) => {
    const w = (Math.abs(it.value) / span) * 100;
    const left = it.value >= 0 ? zero : zero - w;
    const c = diverging ? (it.value >= 0 ? 'var(--pos)' : 'var(--neg)') : color;
    return `<div class="row-hit" data-i="${idx}"><div class="lab">${esc(it.label)}</div>
      <div class="track">${diverging ? `<div class="zero" style="left:${zero}%"></div>` : ''}<div class="bar ${it.value < 0 ? 'neg' : ''}" style="left:${left}%;width:${Math.max(w, 0.4)}%;background:${c}"></div></div>
      <div class="val">${esc(format(it.value))}</div></div>`;
  }).join('')}</div>`;
  if (tipRows) el.querySelectorAll('.row-hit').forEach((row) => {
    const it = items[+row.dataset.i];
    row.querySelectorAll('div').forEach((d) => {
      d.addEventListener('mousemove', (e) => showTip(e, it.label, tipRows(it)));
      d.addEventListener('mouseleave', hideTip);
    });
  });
}

export function setUpdated(el, d) {
  const t = d.fetchedAt || d.generatedAt;
  const mins = Math.round((Date.now() - Date.parse(t)) / 60000);
  el.textContent = `Veri: ${fmt.date(t)} (${mins < 60 ? mins + ' dk' : Math.round(mins / 60) + ' saat'} önce)`;
}

export function demoBanner(d) {
  if (!d?.demo) return;
  const b = document.createElement('div');
  b.className = 'card';
  b.style.borderColor = 'var(--warning)';
  b.innerHTML = '<b>Demo verisi gösteriliyor.</b> <span class="muted">Repo ayarlarında ONAIR_API_KEY ve ONAIR_COMPANY_ID secret\'larını ekleyip "Update dashboard" iş akışını çalıştırın.</span>';
  document.querySelector('main').prepend(b);
}
