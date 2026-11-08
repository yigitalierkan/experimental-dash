#!/usr/bin/env node
// One-off structure discovery for per-aircraft P&L. Prints templates/aggregates, not raw dumps.
import { OnAirClient, shape, asArray } from './lib/onair-client.mjs';

const env = process.env;
const id = (env.ONAIR_VA_ID || env.ONAIR_COMPANY_ID || '').trim();
const client = new OnAirClient({ apiKey: env.ONAIR_API_KEY?.trim() });
const C = `/companies/${id}`;
const out = (...a) => console.log(...a);
const MONEY = /pay|cost|fee|revenue|price|income|amount|cash|salary|penal|bonus|tax|rent|lease|charge|paid|fuel/i;

const fleet = asArray(await client.get(`${C}/fleet`));
const regs = fleet.map((a) => a.Identifier).filter(Boolean).sort((a, b) => b.length - a.length);
const regRe = new RegExp(regs.map((r) => r.replace(/[-]/g, '\\-')).join('|'), 'g');
const template = (s) => String(s || '')
  .replace(regRe, '{REG}')
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, '{UUID}')
  .replace(/\b[A-Z][A-Z0-9]{3}\b(?=[^a-z]|$)/g, (m) => (m === '{REG}' ? m : '{ICAO}'))
  .replace(/-?\d[\d.,]*/g, '{N}');

out('\n===== FLEET: lease / ownership fields =====');
const a0 = fleet[0];
out('fleet keys:', Object.keys(a0).join(', '));
out('AircraftLease (values):', JSON.stringify(a0.AircraftLease, null, 1));
for (const a of fleet.slice(0, 14)) {
  const L = a.AircraftLease || {};
  out(`${a.Identifier}: lease ${Object.entries(L).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
out('money-ish fleet fields:', Object.entries(a0).filter(([k, v]) => MONEY.test(k) && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' | '));

out('\n===== CASH FLOW =====');
const cf = await client.get(`${C}/cash_flow`);
const E = cf.Entries || [];
out('entry keys:', Object.keys(E[0] || {}).join(', '), '| sample (no description):', JSON.stringify({ ...E[0], Description: undefined }));
const dates = E.map((e) => e.CreationDate).filter(Boolean).sort();
out(`entries=${E.length} from ${dates[0]} to ${dates.at(-1)} | current cash=${cf.CompanyCurrentCash}`);
const tpl = new Map();
for (const e of E) {
  const t = template(e.Description);
  const o = tpl.get(t) || { n: 0, sum: 0, withReg: 0, acc: new Set() };
  o.n++; o.sum += e.Amount || 0; o.acc.add(e.AccountId); if (regRe.test(e.Description || '')) o.withReg++; regRe.lastIndex = 0;
  tpl.set(t, o);
}
out('templates (count | sum | withReg | accounts):');
[...tpl.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 60).forEach(([t, o]) =>
  out(`  ${String(o.n).padStart(5)} | ${Math.round(o.sum).toString().padStart(12)} | ${o.withReg} | ${[...o.acc].map((x) => String(x).slice(0, 8)).join(',')} | ${t.slice(0, 140)}`));

out('\n===== INCOME STATEMENT =====');
const is = await client.get(`${C}/income_statement`, { startDate: '2020-01-01T00:00:00Z', endDate: new Date().toISOString() }, { optional: true });
out('shape:', shape(is));
for (const grp of ['Revenues', 'Expenses', 'Revenue', 'Expense']) if (is?.[grp]) for (const acc of asArray(is[grp])) out(`  ${grp}: ${acc.Account?.Name ?? acc.Name ?? '?'} = ${acc.Total ?? acc.Amount ?? ''} (id ${String(acc.AccountId ?? acc.Account?.Id ?? '').slice(0, 8)})`);

out('\n===== FLIGHT money fields =====');
const fl = asArray(await client.get(`/aircraft/${a0.Id}/flights`, { startIndex: 0, limit: 5 }));
out('flight keys:', Object.keys(fl[0] || {}).join(', '));
out('money-ish:', Object.entries(fl[0] || {}).filter(([k, v]) => MONEY.test(k) && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' | '));

out('\n===== JOBS completed =====');
const jobs = asArray(await client.get(`${C}/jobs/completed`, {}, { optional: true }));
out(`jobs=${jobs.length}`, 'shape:', shape(jobs.slice(0, 1)));
const j0 = jobs[0];
if (j0) {
  out('job money-ish:', Object.entries(j0).filter(([k, v]) => MONEY.test(k) && typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(' | '));
  for (const k of Object.keys(j0)) if (Array.isArray(j0[k]) && j0[k][0]) {
    out(`  ${k}[0] keys:`, Object.keys(j0[k][0]).join(', '));
    out(`  ${k}[0] aircraft-ish:`, Object.entries(j0[k][0]).filter(([kk]) => /aircraft|flight/i.test(kk)).map(([kk, v]) => `${kk}=${typeof v === 'object' ? shape(v) : v}`).join(' | '));
  }
  const jd = jobs.map((j) => j.CompletionDate || j.ExpirationDate || j.CreationDate).filter(Boolean).sort();
  out(`jobs date range ${jd[0]} → ${jd.at(-1)}`);
}

out('\n===== WORK ORDERS =====');
out('shape:', shape(await client.get(`${C}/work_orders`, {}, { optional: true })));
out('\n===== MAINTENANCE COSTS (aircraft 0) =====');
out(JSON.stringify(await client.get(`/aircraft/${a0.Id}/maintenance_costs`, {}, { optional: true })));
out('\n===== AIRCRAFT detail money fields =====');
const ad = await client.get(`/aircraft/${a0.Id}`, {}, { optional: true });
out('keys:', Object.keys(ad || {}).join(', '));
