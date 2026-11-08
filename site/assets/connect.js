import { $, terminalHeader, meStore } from './common.js';
import { OnAirClient, fetchSnapshot, slimSnapshot } from '../lib/onair-client.mjs';
import { buildLedger } from '../lib/ledger.mjs';
import { buildDashboard, buildRoutes } from '../lib/metrics.mjs';

terminalHeader('connect', null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let mode = 'va';
let defaultProxy = '';

const con = $('#console');
const line = (msg, cls = '') => {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = `${new Date().toISOString().slice(11, 19)}  ${msg}\n`;
  con.appendChild(s); con.scrollTop = con.scrollHeight;
};

function setMode(v) {
  mode = v;
  $('#mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === v));
  $('#idLabel').textContent = v === 'va' ? 'VA Id' : 'Company Id';
  $('#idHelp').textContent = v === 'va' ? 'OnAir client → Virtual Airline → Settings → VA Id' : 'OnAir client → Company → Settings → Company Id';
  $('#keyHelp').textContent = v === 'va' ? 'Aynı ekrandaki API Key (VA\'nın kendi anahtarı)' : 'Aynı ekrandaki şirket API Key\'i';
}
$('#mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });

// restore remembered credentials / existing data
const cred = meStore.get('cred');
if (cred) { setMode(cred.mode); $('#id').value = cred.id; $('#key').value = cred.key; $('#remember').checked = true; if (cred.proxy) $('#proxy').value = cred.proxy; }
if (meStore.get('dashboard')) { $('#open').hidden = false; line('Bu tarayıcıda daha önce yüklenmiş veri var → "Panoya git" ile açabilir ya da güncelleyebilirsin.', 'i'); }

try { defaultProxy = (await (await fetch(`config.json?t=${Date.now()}`)).json()).proxyUrl || ''; } catch {}
if (!defaultProxy) line('Uyarı: Bu sitede varsayılan proxy tanımlı değil. Gelişmiş bölümünden bir proxy URL gir veya site sahibinden kurmasını iste.', 'w');

$('#forget').addEventListener('click', () => {
  meStore.clear();
  $('#key').value = ''; $('#id').value = ''; $('#remember').checked = false; $('#open').hidden = true;
  line('Bu tarayıcıdaki key ve veriler silindi.', 'w');
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#id').value.trim(), key = $('#key').value.trim();
  const proxy = ($('#proxy').value.trim() || defaultProxy).replace(/\/$/, '');
  const remember = $('#remember').checked;
  if (!UUID.test(id) || !UUID.test(key)) { line('Id ve API key UUID formatında olmalı (xxxxxxxx-xxxx-…).', 'e'); return; }
  if (id === key) { line('Id ve API key aynı olamaz.', 'e'); return; }
  if (!proxy) { line('Proxy URL yok — OnAir API tarayıcıdan doğrudan çağrılamıyor (CORS).', 'e'); return; }

  $('#go').disabled = true; $('#status').textContent = 'yükleniyor…';
  if (remember) meStore.set('cred', { id, key, mode, proxy: $('#proxy').value.trim() }, true);
  else { try { localStorage.removeItem('oa:me:cred'); } catch {} }

  const client = new OnAirClient({ apiKey: key, baseUrl: `${proxy}/api/v1`, minIntervalMs: 1200, log: (m) => line(m.trim(), /429/.test(m) ? 'w' : 'i') });
  const tick = setInterval(() => { $('#calls').textContent = `${client.calls} İSTEK`; }, 500);
  try {
    let prev = meStore.get('snapshot');
    if (prev && prev.companyId !== id) prev = null;
    line(`${mode === 'va' ? 'Virtual Airline' : 'Şirket'} verisi çekiliyor${prev ? ' (önbellekten artımlı)' : ' (ilk yükleme, birkaç dakika sürebilir)'}…`);
    const raw = slimSnapshot(await fetchSnapshot({ client, companyId: id, vaMode: mode === 'va', prev, budgetMs: 15 * 60_000, log: (m) => line(m.trim()) }));
    line('Hesaplanıyor…');
    const ledger = buildLedger(raw);
    const dashboard = buildDashboard(raw, { idleHours: 24, ledger });
    const routes = buildRoutes(raw, dashboard);
    meStore.set('dashboard', dashboard, remember);
    meStore.set('routes', routes, remember);
    if (remember) meStore.set('snapshot', raw, true);
    line(`✓ ${dashboard.company?.name ?? ''}: ${dashboard.aircraft.length} uçak, ${raw.flights.length} uçuş, ${ledger.entries} kasa satırı, ${routes.count} rota (${client.calls} istek)`, '');
    $('#status').textContent = 'hazır';
    $('#open').hidden = false;
    setTimeout(() => { location.href = 'index.html?me'; }, 900);
  } catch (err) {
    const msg = String(err?.message || err);
    line(msg, 'e');
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) line('Proxy\'ye ulaşılamadı. Proxy URL\'sini ve bu sitenin proxy\'de izinli olduğunu kontrol et.', 'w');
    if (/401|403|not found|Sequence contains no elements/i.test(msg)) line('Id/API key eşleşmiyor olabilir: VA modunda VA Id + VA API key, şirket modunda Company Id + şirket API key kullanılmalı.', 'w');
    $('#status').textContent = 'hata';
  } finally {
    clearInterval(tick); $('#calls').textContent = `${client.calls} İSTEK`; $('#go').disabled = false;
  }
});
