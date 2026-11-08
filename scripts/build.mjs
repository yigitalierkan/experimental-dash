#!/usr/bin/env node
// Usage:
//   ONAIR_API_KEY=... ONAIR_COMPANY_ID=... node scripts/build.mjs     # live
//   node scripts/build.mjs --mock                                     # örnek veriyle
//   node scripts/build.mjs --raw path/to/raw.json                     # kayıtlı snapshot'tan
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnAirClient, fetchSnapshot, slimSnapshot } from './lib/onair-client.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildDashboard, buildRoutes } from './lib/metrics.mjs';
import { buildLedger } from './lib/ledger.mjs';
import { mockSnapshot } from './lib/mock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'site', 'data');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const env = process.env;
const settings = {
  idleHours: Number(env.IDLE_HOURS || 24),
  flightDays: Number(env.FLIGHT_DAYS || 30),
};

const proxyUrl = (env.PROXY_URL || (await readFile(join(root, 'proxy', 'url.txt'), 'utf8').catch(() => '')) || '').trim().replace(/\/$/, '');
async function writeShared() {
  // Browser-side "Kendi verin" mode reuses the exact same pure modules.
  await mkdir(join(root, 'site', 'lib'), { recursive: true });
  for (const f of ['onair-client.mjs', 'metrics.mjs', 'ledger.mjs']) await copyFile(join(root, 'scripts', 'lib', f), join(root, 'site', 'lib', f));
  await writeFile(join(root, 'site', 'config.json'), JSON.stringify({ proxyUrl, team: !flag('--public') }));
}

if (flag('--public')) {
  // No team credentials: publish the app only — every visitor connects with their own key.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeShared();
  console.log(`✓ Herkese açık mod: ortak veri yok, proxy=${proxyUrl || '(yok)'}`);
  process.exit(0);
}

let raw;
if (flag('--mock')) {
  console.log('MOCK veri üretiliyor');
  raw = mockSnapshot();
} else if (opt('--raw')) {
  const buf = await readFile(opt('--raw'));
  raw = JSON.parse((opt('--raw').endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
  console.log(`Kayıtlı snapshot kullanılıyor (${raw.fetchedAt})`);
} else {
  const apiKey = env.ONAIR_API_KEY?.trim();
  const vaId = env.ONAIR_VA_ID?.trim();
  const companyId = vaId || env.ONAIR_COMPANY_ID?.trim();
  const vaMode = !!vaId;
  console.log(`Mod: ${vaMode ? 'Virtual Airline' : 'Company'}`);
  if (!apiKey || !companyId) {
    console.error('ONAIR_API_KEY ve ONAIR_VA_ID (veya ONAIR_COMPANY_ID) gerekli (ya da --mock).');
    process.exit(1);
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  console.log(`Secret kontrolü: ID uzunluk=${companyId.length} uuid=${UUID.test(companyId)} | API_KEY uzunluk=${apiKey.length} uuid=${UUID.test(apiKey)} | aynı değer=${apiKey === companyId}`);
  if (!UUID.test(companyId)) { console.error('VA/Company ID UUID formatında değil (ör. 1a2b3c4d-....). Tırnak/boşluk/fazla karakter olmadığından emin ol.'); process.exit(1); }
  if (apiKey === companyId) { console.error('ONAIR_API_KEY ile ID aynı — ikisi farklı değerler olmalı.'); process.exit(1); }
  const client = new OnAirClient({ apiKey, baseUrl: env.ONAIR_BASE_URL || undefined });
  let prev = null;
  if (opt('--cache')) {
    try { const b = await readFile(opt('--cache')); prev = JSON.parse((opt('--cache').endsWith('.gz') ? gunzipSync(b) : b).toString('utf8')); }
    catch { console.log('Önbellek yok, tam çekim yapılacak.'); }
    if (prev && prev.companyId && prev.companyId !== companyId) prev = null; // different VA/company
  }
  raw = slimSnapshot(await fetchSnapshot({ client, companyId, vaMode, prev, flightDays: settings.flightDays, budgetMs: Number(env.FETCH_BUDGET_MS || 420_000) }));
  console.log(`API çağrısı: ${raw.apiCalls}`);
  if (flag('--save-raw')) await writeFile(join(root, 'raw-snapshot.json'), JSON.stringify(raw));
}

const ledger = buildLedger(raw);
const dashboard = buildDashboard(raw, { idleHours: settings.idleHours, ledger });
const routes = buildRoutes(raw, dashboard);
if (flag('--mock')) { dashboard.demo = true; routes.demo = true; }
if (opt('--raw')) { dashboard.stale = true; routes.stale = true; }

// Shape hints for troubleshooting (keys only, no secrets).
const debug = {
  generatedAt: dashboard.generatedAt,
  counts: { fleet: raw.fleet?.length ?? 0, flights: raw.flights?.length ?? 0, routes: routes.count, ledgerEntries: ledger.entries },
  ledger: { from: ledger.from, to: ledger.to, catTotals: ledger.catTotals, excluded: ledger.excluded },
};

await mkdir(outDir, { recursive: true });
await writeShared();
await writeFile(join(outDir, 'dashboard.json'), JSON.stringify(dashboard));
await writeFile(join(outDir, 'routes.json'), JSON.stringify(routes));
await writeFile(join(outDir, 'debug.json'), JSON.stringify(debug, null, 2));
if (!flag('--mock')) await writeFile(join(outDir, 'snapshot.json.gz'), gzipSync(JSON.stringify(raw))); // fallback for future runs
console.log(`✓ ${dashboard.aircraft.length} uçak, ${dashboard.totals.idle24h} tanesi ${settings.idleHours}s+ boşta, ${routes.count} rota, ${ledger.aircraft.length} uçak defteri → site/data/`);

// Run summary (GitHub Actions log + job summary) — computed metrics only
const m = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const rows = ledger.aircraft.map((a) => `| ${a.registration}${a.inFleet ? '' : ' (iade)'} | ${a.type ?? '—'} | ${a.since?.slice(0, 10) ?? '—'} | ${a.flights} | ${a.blockHours} | ${m(a.revenue)} | ${m(a.fixed)} | ${m(a.variable)} | ${m(a.overhead)} | ${m(a.revenue + a.fixed + a.variable + a.overhead)} |`);
const summary = [`### ${dashboard.company?.name ?? 'OnAir'} — kiralamadan bugüne uçak başına K/Z (nakit, ${ledger.entries} kasa satırı ${ledger.from?.slice(0, 10)} → ${ledger.to?.slice(0, 10)})`, '',
  '| Tescil | Tip | Başlangıç | Uçuş | Blok saat | Gelir | Sabit | Değişken | Genel gider | Net |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '',
  `Kategori toplamları: ${Object.entries(ledger.catTotals).map(([k, v]) => `${k}=${m(v)}`).join(', ')}`,
  `Uçak dışı (hariç): ${ledger.excluded.n} satır, ${m(ledger.excluded.sum)} — ${ledger.excluded.top.map(([k, v]) => `${k}: ${m(v)}`).join('; ')}`].join('\n');
console.log(summary);
if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, summary + '\n', { flag: 'a' });
