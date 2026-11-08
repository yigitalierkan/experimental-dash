#!/usr/bin/env node
// Structure discovery for per-aircraft P&L (aggregates only).
import { OnAirClient, shape, asArray } from './lib/onair-client.mjs';

const env = process.env;
const id = (env.ONAIR_VA_ID || env.ONAIR_COMPANY_ID || '').trim();
const client = new OnAirClient({ apiKey: env.ONAIR_API_KEY?.trim() });
const C = `/companies/${id}`;
const out = (...a) => console.log(...a);

const fleet = asArray(await client.get(`${C}/fleet`));
const fleetIds = new Set(fleet.map((a) => a.Id));
const regs = fleet.map((a) => a.Identifier).filter(Boolean).sort((a, b) => b.length - a.length);
const regRe = new RegExp(regs.map((r) => r.replace(/[-]/g, '\\-')).join('|'), 'g');
const template = (s) => String(s || '')
  .replace(regRe, '{REG}')
  .replace(/Hotel for .* at/, 'Hotel for {NAME} at')
  .replace(/\(from .*\)/, '(from…)')
  .replace(/\b[A-Z][A-Z0-9]{3}\b/g, '{ICAO}')
  .replace(/-?\d[\d.,]*/g, '{N}')
  .replace(/for \{REG\} .*$/, 'for {REG} {TYPE}');

const is = await client.get(`${C}/income_statement`, { startDate: '2020-01-01T00:00:00Z', endDate: new Date().toISOString() }, { optional: true });
out('\n===== ACCOUNTS (income statement since 2020) =====');
out('REV[0]:', JSON.stringify(is?.REVAccounts?.[0])?.slice(0, 400));
const accName = {};
for (const [grp, list] of [['REV', is?.REVAccounts], ['EXP', is?.EXPAccounts]]) for (const a of list || []) {
  const aid = a.AccountId ?? a.Account?.Id ?? a.Id; const nm = a.Account?.Name ?? a.Name ?? a.AccountName;
  accName[aid] = `${grp}:${nm}`;
  out(`  ${grp} ${String(aid).slice(0, 8)} ${nm} = ${Math.round(a.Amount ?? a.Total ?? 0)}`);
}
out(`REV=${Math.round(is?.REVAmount)} EXP=${Math.round(is?.EXPAmount)} NET=${Math.round(is?.NetIncomeAmount)}`);

const cf = await client.get(`${C}/cash_flow`);
const E = cf.Entries || [];
out('\n===== CASH FLOW: AircraftId coverage by account =====');
const byAcc = new Map();
for (const e of E) {
  const o = byAcc.get(e.AccountId) || { n: 0, sum: 0, withAc: 0, fleetAc: 0, sumWithAc: 0 };
  o.n++; o.sum += e.Amount; if (e.AircraftId) { o.withAc++; o.sumWithAc += e.Amount; } if (fleetIds.has(e.AircraftId)) o.fleetAc++;
  byAcc.set(e.AccountId, o);
}
for (const [k, o] of [...byAcc].sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum)))
  out(`  ${String(k).slice(0, 8)} ${(accName[k] || '?').padEnd(40)} n=${o.n} sum=${Math.round(o.sum)} withAircraftId=${o.withAc} (inFleet ${o.fleetAc}) sumWithAc=${Math.round(o.sumWithAc)}`);

out('\n===== templates WITHOUT AircraftId (by |sum|) =====');
const tpl = new Map();
for (const e of E) {
  const t = (e.AircraftId ? 'AC ' : 'NO ') + template(e.Description);
  const o = tpl.get(t) || { n: 0, sum: 0, acc: e.AccountId };
  o.n++; o.sum += e.Amount; tpl.set(t, o);
}
const all = [...tpl.entries()];
for (const [t, o] of all.filter(([t]) => t.startsWith('NO ')).sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum)).slice(0, 30))
  out(`  ${String(o.n).padStart(5)} | ${Math.round(o.sum).toString().padStart(12)} | ${(accName[o.acc] || String(o.acc).slice(0, 8)).padEnd(28)} | ${t.slice(3, 130)}`);
out('\n===== templates WITH AircraftId (by |sum|) =====');
for (const [t, o] of all.filter(([t]) => t.startsWith('AC ')).sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum)).slice(0, 30))
  out(`  ${String(o.n).padStart(5)} | ${Math.round(o.sum).toString().padStart(12)} | ${(accName[o.acc] || String(o.acc).slice(0, 8)).padEnd(28)} | ${t.slice(3, 130)}`);

out('\n===== JOBS → aircraft linkage =====');
const jobs = asArray(await client.get(`${C}/jobs/completed`, {}, { optional: true }));
const j0 = jobs[0];
out('job keys:', Object.keys(j0 || {}).join(', '));
out('with CompletionFlightId:', jobs.filter((j) => j.CompletionFlightId).length, '| with RegularRouteFlightId:', jobs.filter((j) => j.RegularRouteFlightId).length, '| sum RealPay:', Math.round(jobs.reduce((s, j) => s + (j.RealPay || 0), 0)));
const jc = jobs.find((j) => j.Cargos?.length)?.Cargos?.[0]; const jch = jobs.find((j) => j.Charters?.length)?.Charters?.[0];
if (jc) out('Cargo keys:', Object.keys(jc).join(', '));
if (jch) out('Charter keys:', Object.keys(jch).join(', '));
const sampleFlightId = jobs.find((j) => j.CompletionFlightId)?.CompletionFlightId;
if (sampleFlightId) { const f = await client.get(`/flights/${sampleFlightId}`, {}, { optional: true }); out('CompletionFlight →', f ? `AircraftId in fleet: ${fleetIds.has(f.AircraftId)}` : 'not found'); }
// does cash 'Payment for ...' match job RealPay?
const payEntries = E.filter((e) => e.Amount > 0);
const payAmounts = new Map(payEntries.map((e) => [Math.round(e.Amount * 100), e]));
out('jobs whose RealPay equals a cash entry amount:', jobs.filter((j) => payAmounts.has(Math.round((j.RealPay || 0) * 100))).length, '/', jobs.length);

out('\n===== REGULAR ROUTES flights =====');
const rr = asArray(await client.get('/regular_routes', {}, { optional: true }));
out('routes:', rr.length, 'flight numbers:', rr.map((r) => r.FlightNumber).join(','));
out('Flights[0]:', JSON.stringify(rr[0]?.Flights?.[0]));

out('\n===== WORK ORDER actions =====');
const wo = asArray(await client.get(`${C}/work_orders`, {}, { optional: true }));
out('Actions[0] keys:', Object.keys(wo[0]?.Actions?.[0] || {}).join(', '));
