#!/usr/bin/env node
// Usage:
//   ONAIR_API_KEY=... ONAIR_COMPANY_ID=... node scripts/build.mjs     # live
//   node scripts/build.mjs --mock                                     # örnek veriyle
//   node scripts/build.mjs --raw path/to/raw.json                     # kayıtlı snapshot'tan
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnAirClient, fetchSnapshot } from './lib/onair-client.mjs';
import { buildDashboard, buildRoutes } from './lib/metrics.mjs';
import { mockSnapshot } from './lib/mock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'site', 'data');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const env = process.env;
const settings = {
  holding: env.HOLDING_MODE || 'auto',            // auto | own | lease | rent
  idleHours: Number(env.IDLE_HOURS || 24),
  flightDays: Number(env.FLIGHT_DAYS || 30),
};

let raw;
if (flag('--mock')) {
  console.log('MOCK veri üretiliyor');
  raw = mockSnapshot();
} else if (opt('--raw')) {
  raw = JSON.parse(await readFile(opt('--raw'), 'utf8'));
} else {
  const apiKey = env.ONAIR_API_KEY?.trim();
  const companyId = env.ONAIR_COMPANY_ID?.trim();
  if (!apiKey || !companyId) {
    console.error('ONAIR_API_KEY ve ONAIR_COMPANY_ID ortam değişkenleri gerekli (ya da --mock).');
    process.exit(1);
  }
  const client = new OnAirClient({ apiKey, baseUrl: env.ONAIR_BASE_URL || undefined });
  raw = await fetchSnapshot({ client, companyId, flightDays: settings.flightDays });
  console.log(`API çağrısı: ${raw.apiCalls}`);
  if (flag('--save-raw')) await writeFile(join(root, 'raw-snapshot.json'), JSON.stringify(raw));
}

const dashboard = buildDashboard(raw, { holding: settings.holding, idleHours: settings.idleHours });
const routes = buildRoutes(raw, dashboard);
if (flag('--mock')) { dashboard.demo = true; routes.demo = true; }

// Shape hints for troubleshooting (keys only + first route, no secrets).
const debug = {
  generatedAt: dashboard.generatedAt,
  counts: { fleet: raw.fleet?.length ?? 0, flights: raw.flights?.length ?? 0, routes: routes.count, economics: Object.values(raw.economics || {}).filter(Boolean).length },
  fleetKeys: raw.fleet?.[0] ? Object.keys(raw.fleet[0]) : [],
  flightKeys: raw.flights?.[0] ? Object.keys(raw.flights[0]) : [],
  economicsKeys: Object.values(raw.economics || {}).find(Boolean) ? Object.keys(Object.values(raw.economics).find(Boolean)) : [],
  regularRoutesType: Array.isArray(raw.regularRoutes) ? 'array' : typeof raw.regularRoutes,
  regularRoutesSample: Array.isArray(raw.regularRoutes) ? raw.regularRoutes.slice(0, 2) : raw.regularRoutes,
  cashMatch: dashboard.cashMatch,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'dashboard.json'), JSON.stringify(dashboard));
await writeFile(join(outDir, 'routes.json'), JSON.stringify(routes));
await writeFile(join(outDir, 'debug.json'), JSON.stringify(debug, null, 2));
console.log(`✓ ${dashboard.aircraft.length} uçak, ${dashboard.totals.idle24h} tanesi ${settings.idleHours}s+ boşta, ${routes.count} rota → site/data/`);
