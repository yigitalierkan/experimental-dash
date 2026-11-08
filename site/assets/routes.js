import { $, esc, fmt, loadJson, statusPill, renderTable, demoBanner, terminalHeader } from './common.js';

const L = window.L;
const dark = true;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COLORS = dark
  ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

let R, D, map, routeLayer, fleetLayer;
const state = { q: '', onlyAssigned: false, sel: null };
const layers = new Map(); // route id -> { line, color }

/** Great-circle interpolation so long routes curve like real tracks. */
function arc(a, b, n = 48) {
  const toR = Math.PI / 180, toD = 180 / Math.PI;
  const [la1, lo1, la2, lo2] = [a.lat * toR, a.lon * toR, b.lat * toR, b.lon * toR];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  if (!d) return [[a.lat, a.lon], [b.lat, b.lon]];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    let lon = Math.atan2(y, x) * toD;
    if (prevLon != null) { // keep continuous across the antimeridian
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * toD, lon]);
  }
  return pts;
}

const located = (r) => r.stops.filter((s) => s.lat != null && s.lon != null);

function visible() {
  return R.routes.filter((r) => {
    if (state.onlyAssigned && !r.aircraft.length) return false;
    if (!state.q) return true;
    const s = `${r.name} ${r.set || ''} ${r.flightNumber || ''} ${r.stops.map((x) => `${x.icao} ${x.city || ''} ${x.name || ''}`).join(' ')} ${r.aircraft.map((a) => a.registration).join(' ')}`.toLowerCase();
    return s.includes(state.q);
  });
}

function drawRoutes() {
  routeLayer.clearLayers(); layers.clear();
  const airports = new Map();
  const list = visible();
  list.forEach((r, i) => {
    const color = COLORS[i % COLORS.length];
    const pts = located(r);
    pts.forEach((s) => airports.set(s.icao, s));
    if (pts.length < 2) return;
    const path = pts.slice(1).flatMap((b, j) => arc(pts[j], b));
    const line = L.polyline(path, { color, weight: 2.5, opacity: 0.85 }).addTo(routeLayer);
    line.bindTooltip(`<b>${esc(r.name)}</b><br>${esc(r.stops.map((s) => s.icao).join(' → '))}${r.distanceNm ? ` · ${fmt.n0(r.distanceNm)} nm` : ''}<br>${r.aircraft.length ? esc(r.aircraft.map((a) => a.registration).join(', ')) : 'Uçak atanmamış'}`, { sticky: true });
    line.on('click', () => select(r.id, false));
    // wider invisible hit target
    L.polyline(path, { color, weight: 14, opacity: 0 }).addTo(routeLayer).on('click', () => select(r.id, false)).bindTooltip(line.getTooltip());
    layers.set(r.id, { line, color });
  });
  for (const ap of airports.values()) {
    L.circleMarker([ap.lat, ap.lon], { radius: 3.5, color: '#000', weight: 1.5, fillColor: '#ffa028', fillOpacity: 1 })
      .addTo(routeLayer)
      .bindTooltip(esc(ap.icao), { permanent: airports.size <= 40, direction: 'right', className: 'ap-label', offset: [6, 0] });
  }
  renderList(list);
  highlight();
  const b = routeLayer.getBounds?.();
  if (b && b.isValid() && !state.sel) map.fitBounds(b.pad(0.15), { maxZoom: 7 });
  $('#kpis').innerHTML = kpiHtml(list);
}

function kpiHtml(list) {
  const assigned = list.filter((r) => r.aircraft.length).length;
  const acs = new Set(list.flatMap((r) => r.aircraft.map((a) => a.id)));
  const nm = list.reduce((s, r) => s + (r.distanceNm || 0), 0);
  const airports = new Set(list.flatMap((r) => r.stops.map((s) => s.icao)));
  const unmapped = list.filter((r) => located(r).length < 2).length;
  return [
    ['Rota', fmt.n0(list.length), `${assigned} tanesine uçak atanmış`],
    ['Atanmış uçak', fmt.n0(acs.size), `filo: ${D ? D.aircraft.length : '—'}`],
    ['Havalimanı', fmt.n0(airports.size), 'rotalarda geçen'],
    ['Toplam mesafe', `${fmt.n0(nm)} nm`, list.length ? `ort. ${fmt.n0(nm / list.length)} nm` : ''],
    ...(unmapped ? [['Haritada yok', fmt.n0(unmapped), 'koordinat bulunamadı']] : []),
  ].map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
}

function renderList(list) {
  $('#list').innerHTML = list.length ? list.map((r) => {
    const c = layers.get(r.id)?.color || 'var(--text-muted)';
    return `<div class="route-item ${state.sel === r.id ? 'sel' : ''}" data-id="${esc(r.id)}">
      <div class="t"><span><i style="display:inline-block;width:10px;height:3px;background:${c};vertical-align:middle;margin-right:6px;border-radius:2px"></i>${esc(r.name)}</span>
      <span class="amb">${r.flightNumber ? '#' + esc(r.flightNumber) : ''}</span></div>
      <div class="s">${r.set ? `${esc(r.set)} · ` : ''}${r.distanceNm ? `${fmt.n0(r.distanceNm)} nm` : ''}${r.schedule?.dep ? ` · ${esc(r.schedule.dep)}–${esc(r.schedule.arr || '')}` : ''}${r.schedule?.days ? ` · ${esc(r.schedule.days)}` : ''}${r.active === false ? ' · <b>Pasif</b>' : ''}</div>
      <div class="ac">${r.aircraft.length ? r.aircraft.map((a) => `<span class="pill">${esc(a.registration)}</span>`).join('') : '<span class="muted">UÇAK ATANMAMIŞ</span>'}</div>
    </div>`;
  }).join('') : '<div class="empty">Rota bulunamadı. (regular_routes boş dönmüş olabilir — data/debug.json dosyasına bakın.)</div>';
  $('#list').querySelectorAll('.route-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.id, true)));
}

function highlight() {
  for (const [id, { line }] of layers) {
    const on = !state.sel || state.sel === id;
    line.setStyle({ opacity: on ? 0.9 : 0.15, weight: state.sel === id ? 4.5 : 2.5 });
    if (state.sel === id) line.bringToFront();
  }
}

function select(id, zoom) {
  state.sel = state.sel === id && zoom ? null : id;
  const r = R.routes.find((x) => x.id === state.sel);
  document.querySelectorAll('.route-item').forEach((el) => el.classList.toggle('sel', el.dataset.id === state.sel));
  highlight();
  const det = $('#detail');
  if (!r) { det.hidden = true; return; }
  det.hidden = false;
  const extra = Object.entries(r.extra || {}).filter(([k]) => !['Name', 'FlightNumber'].includes(k));
  det.innerHTML = `<div class="ph"><h2>${esc(r.name)}${r.flightNumber ? ' · #' + esc(r.flightNumber) : ''}</h2><span class="spacer"></span><a href="#" id="closeDet">KAPAT</a></div>
    <p class="hint">${esc(r.stops.map((s) => `${s.icao}${s.city ? ' (' + s.city + ')' : ''}`).join(' → '))}</p>
    <dl>
      <dt>Uçuş no</dt><dd>${esc(r.flightNumber || '—')}</dd>
      <dt>Mesafe</dt><dd>${r.distanceNm ? fmt.n0(r.distanceNm) + ' nm' : '—'}</dd>
      <dt>Durum</dt><dd>${esc(r.status ?? '—')}</dd>
      ${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
    <div class="h3">Atanmış uçaklar</div>
    ${r.aircraft.length ? `<div class="table-wrap"><table><thead><tr><th>Tescil</th><th>Tip</th><th>Durum</th><th class="n">Uçuş/gün</th><th class="n">Net K/Z (bugüne)</th></tr></thead><tbody>
      ${r.aircraft.map((a) => `<tr><td><b>${esc(a.registration)}</b></td><td>${esc(a.type || '—')}</td><td>${a.status ? statusPill(a.status) : '—'}</td><td class="n">${fmt.n2(a.flightsPerDay7d)}</td><td class="n"><a class="${a.net < 0 ? 'neg' : 'pos'}" href="index.html#${encodeURIComponent(a.registration)}">${fmt.compact(a.net)}</a></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">Bu rotaya uçak atanmamış.</p>'}`;
  $('#closeDet').addEventListener('click', (e) => { e.preventDefault(); state.sel = null; select(null); });
  const ly = layers.get(r.id);
  if (zoom && ly) map.fitBounds(ly.line.getBounds().pad(0.3), { maxZoom: 8 });
}

function drawFleet() {
  fleetLayer.clearLayers();
  if (!D || !$('#showFleet').checked) return;
  for (const a of D.aircraft) {
    const p = a.position || (a.location?.lat != null ? { lat: a.location.lat, lon: a.location.lon } : null);
    if (!p) continue;
    const icon = L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9],
      html: `<div style="transform:rotate(${(p.heading ?? 0) - 45}deg);font-size:15px;line-height:18px;text-align:center;color:${a.status === 'InFlight' ? css('--accent') : css('--text-secondary')};text-shadow:0 0 2px ${css('--surface-1')}">✈</div>` });
    L.marker([p.lat, p.lon], { icon }).addTo(fleetLayer)
      .bindTooltip(`<b>${esc(a.registration)}</b> · ${esc(a.type)}<br>${esc(a.status)} · ${esc(a.location?.icao || '')}<br>Son uçuş: ${esc(fmt.ago(a.hoursSinceLastFlight))} önce`);
  }
}

function assignTable() {
  const rows = R.routes.flatMap((r) => r.aircraft.map((a) => ({ r, a })));
  renderTable($('#assignTable'), [
    { key: 'route', label: 'Rota', get: (x) => x.r.name, render: (x) => `<b>${esc(x.r.name)}</b> <span class="muted">${esc(x.r.flightNumber || '')}</span>` },
    { key: 'set', label: 'Rota seti', get: (x) => x.r.set || '' },
    { key: 'sched', label: 'Sefer (UTC)', get: (x) => x.r.schedule?.dep || '', render: (x) => (x.r.schedule?.dep ? `${esc(x.r.schedule.dep)}–${esc(x.r.schedule.arr || '')} <span class="muted">${esc(x.r.schedule.days || '')}</span>` : '—') },
    { key: 'nm', label: 'Mesafe (nm)', num: true, get: (x) => x.r.distanceNm, render: (x) => fmt.n0(x.r.distanceNm) },
    { key: 'reg', label: 'Tescil', get: (x) => x.a.registration, render: (x) => `<b>${esc(x.a.registration)}</b>` },
    { key: 'type', label: 'Tip', get: (x) => x.a.type || '' },
    { key: 'status', label: 'Durum', get: (x) => x.a.status || '', render: (x) => (x.a.status ? statusPill(x.a.status) : '—') },
    { key: 'fpd', label: 'Uçuş/gün (7g)', num: true, get: (x) => x.a.flightsPerDay7d, render: (x) => fmt.n2(x.a.flightsPerDay7d) },
    { key: 'p', label: 'Net K/Z (bugüne)', num: true, get: (x) => x.a.net, render: (x) => `<a href="index.html#${encodeURIComponent(x.a.registration)}" class="${x.a.net < 0 ? 'neg' : 'pos'}">${fmt.money(x.a.net)}</a>` },
  ], rows, { sortKey: 'route', sortDir: 'asc', empty: 'Rotalara atanmış uçak bulunamadı.' });
}

(async () => {
  try {
    [R, D] = await Promise.all([loadJson('data/routes.json'), loadJson('data/dashboard.json').catch(() => null)]);
  } catch (e) {
    terminalHeader('routes', null);
    $('main').innerHTML = `<div class="banner">VERİ YÜKLENEMEDİ: ${esc(e.message)}</div>`;
    return;
  }
  terminalHeader('routes', D || R);
  demoBanner(D || R);
  map = L.map('map', { worldCopyJump: true, zoomSnap: 0.5 }).setView([40, 20], 3);
  // Keyless basemap: Esri World Dark Gray (no API key); fall back to OpenStreetMap if it fails to load.
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap',
  }).addTo(map);
  let errs = 0;
  esri.on('tileerror', () => {
    if (++errs !== 4) return;
    map.removeLayer(esri);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap', className: 'osm-dark' }).addTo(map);
  });
  routeLayer = L.featureGroup().addTo(map);
  fleetLayer = L.layerGroup().addTo(map);
  drawRoutes(); drawFleet(); assignTable();
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); drawRoutes(); });
  $('#onlyAssigned').addEventListener('change', (e) => { state.onlyAssigned = e.target.checked; drawRoutes(); });
  $('#showFleet').addEventListener('change', drawFleet);
})();
