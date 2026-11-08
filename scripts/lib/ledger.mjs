// Actual per-aircraft P&L since the aircraft joined the fleet, built from the cash-flow ledger.
import { parseUtc } from './metrics.mjs';

const DAY = 86400_000;
const r0 = (v) => Math.round(v);

/** Category → group. fixed: time-based; variable: usage-based; overhead: company costs allocated to aircraft. */
export const CATEGORIES = {
  pax:          { group: 'revenue',  label: 'Yolcu geliri' },
  cargo:        { group: 'revenue',  label: 'Kargo geliri' },
  otherRevenue: { group: 'revenue',  label: 'Diğer gelir' },
  lease:        { group: 'fixed',    label: 'Leasing ödemesi' },
  leaseRefund:  { group: 'fixed',    label: 'Leasing iadesi' },
  parking:      { group: 'fixed',    label: 'Park ücreti' },
  fleetMgmt:    { group: 'overhead', label: 'Filo yönetimi payı' },
  fuel:         { group: 'variable', label: 'Yakıt' },
  landing:      { group: 'variable', label: 'İniş ücreti' },
  slot:         { group: 'variable', label: 'Slot ücreti' },
  maintenance:  { group: 'variable', label: 'Bakım / atölye' },
  penalty:      { group: 'variable', label: 'Ceza (uçağa ait)' },
  otherDirect:  { group: 'variable', label: 'Diğer (uçağa ait)' },
  staff:        { group: 'overhead', label: 'Personel / pilot payı' },
  crewHotel:    { group: 'overhead', label: 'Ekip oteli payı' },
  penaltyOH:    { group: 'overhead', label: 'Ceza payı' },
  slotOH:       { group: 'overhead', label: 'Eşleşmeyen slot payı' },
  otherOH:      { group: 'overhead', label: 'Diğer genel gider payı' },
};

/** AccountId → account name, from income_statement { REVAccounts:[{Name, Entries:[{AccountId}]}], EXPAccounts }. */
export function accountNames(incomeStatement) {
  const map = {};
  for (const [grp, list] of [['REV', incomeStatement?.REVAccounts], ['EXP', incomeStatement?.EXPAccounts]]) {
    for (const acc of list || []) for (const e of acc.Entries || []) {
      const id = e.AccountId ?? e.Account?.Id;
      if (id) map[id] = { name: e.Account?.Name ?? acc.Name, short: e.Account?.ShortName ?? acc.ShortName, grp };
    }
  }
  return map;
}

/** Classify one cash-flow line. Returns { cat } or { cat:'excluded' }. */
export function classify(e, acc) {
  const d = String(e.Description || '');
  const n = acc?.name || '';
  const short = acc?.short || '';
  const hasAc = !!e.AircraftId;
  if (/^Owner'?s equity|upgrade|weekly ownership|local dealer|Money transfer to|Dividend/i.test(d) && !/lease/i.test(d)) return 'excluded';
  if (/Refund of the .* lease/i.test(d)) return 'leaseRefund';
  if (/leased at|lease fee|lease payment|Aircraft Renting/i.test(d) || /Renting/i.test(n)) return 'lease';
  if (e.Amount > 0) {
    if (/Passenger/i.test(n) || short === 'REVPax') return 'pax';
    if (/Cargo/i.test(n)) return 'cargo';
    if (/Payment for (PAX|Route)/i.test(d)) return 'pax';
    if (/Payment for Cargo/i.test(d)) return 'cargo';
    return hasAc ? 'otherRevenue' : 'excluded';
  }
  if (/^Landing fee/i.test(d)) return 'landing';
  if (/^Parking fee/i.test(d)) return 'parking';
  if (/Airport slots fee for Flight #/i.test(d)) return 'slot';
  if (/Fleet Management/i.test(d)) return 'fleetMgmt';
  if (/Fuel/i.test(n) || /Fuel bought/i.test(d)) return hasAc ? 'fuel' : 'excluded';
  if (/Maintenance/i.test(n) || /workshop|repair|inspection|checkup/i.test(d)) return hasAc ? 'maintenance' : 'otherOH';
  if (/Penalt/i.test(n) || /Penalty|abandoned/i.test(d)) return hasAc ? 'penalty' : 'penaltyOH';
  if (/Staff/i.test(n) || /Salary|Pilots pay/i.test(d)) return 'staff';
  if (/^Hotel for/i.test(d)) return 'crewHotel';
  if (/FBO expenses|FBO Services|FBO Fuel|Industries|Airport Ownership/i.test(n)) return 'excluded';
  return hasAc ? 'otherDirect' : 'otherOH';
}

/**
 * @param raw snapshot: fleet, flights, cashFlow, incomeStatementAll, regularRoutes, formerAircraft
 * @returns per-aircraft ledger + company summary
 */
export function buildLedger(raw, { now = Date.now() } = {}) {
  const fleet = raw.fleet || [];
  const accs = accountNames(raw.incomeStatementAll || raw.incomeStatement);
  const entries = (raw.cashFlow?.Entries || []).map((e) => ({ ...e, t: parseUtc(e.CreationDate) })).filter((e) => e.t != null).sort((a, b) => a.t - b.t);

  // aircraft registry: current fleet + any aircraft seen in the ledger (returned leases)
  const info = new Map();
  for (const a of fleet) info.set(a.Id, { id: a.Id, registration: a.Identifier, type: a.AircraftType?.DisplayName ?? null, inFleet: true, lease: a.AircraftLease || null });
  const fleetRegs = new Set(fleet.map((a) => a.Identifier));
  for (const [id, a] of Object.entries(raw.formerAircraft || {})) if (!info.has(id)) {
    const reg = a?.Identifier ?? null;
    // a returned aircraft may carry a registration that has since been reused by a fleet aircraft
    info.set(id, { id, registration: reg && fleetRegs.has(reg) ? `${reg} (eski)` : reg, type: a?.AircraftType?.DisplayName ?? null, inFleet: false, lease: null });
  }
  const regToId = new Map([...info.values()].filter((a) => a.registration).map((a) => [a.registration.toUpperCase(), a.id]));
  for (const a of fleet) if (a.Identifier) regToId.set(a.Identifier.toUpperCase(), a.Id); // current holder wins

  // flight number → aircraft (via regular routes)
  const fnToAc = new Map();
  for (const r of Array.isArray(raw.regularRoutes) ? raw.regularRoutes : []) {
    if (r.FlightNumber != null && r.AircraftId) fnToAc.set(String(r.FlightNumber), r.AircraftId);
  }

  // block hours per aircraft (for overhead allocation) + first flight
  const hours = new Map(); const flightsN = new Map(); const firstFlight = new Map();
  for (const f of raw.flights || []) {
    const s = parseUtc(f.EngineOnTime) ?? parseUtc(f.StartTime); const e = parseUtc(f.EngineOffTime) ?? parseUtc(f.EndTime);
    if (s == null || !f.AircraftId) continue;
    if (e != null && e > s) hours.set(f.AircraftId, (hours.get(f.AircraftId) || 0) + (e - s) / 3600e3);
    flightsN.set(f.AircraftId, (flightsN.get(f.AircraftId) || 0) + 1);
    firstFlight.set(f.AircraftId, Math.min(firstFlight.get(f.AircraftId) ?? Infinity, s));
  }

  const books = new Map();
  const book = (id) => {
    if (!books.has(id)) {
      const a = info.get(id) || { id, registration: null, type: null, inFleet: false, lease: null };
      info.set(id, a);
      books.set(id, { ...a, cats: {}, firstEntry: null, lastEntry: null, tx: [], daily: new Map() });
    }
    return books.get(id);
  };
  const post = (id, cat, amount, e, note) => {
    const b = book(id);
    b.cats[cat] = (b.cats[cat] || 0) + amount;
    if (CATEGORIES[cat].group !== 'overhead') {
      b.firstEntry = b.firstEntry == null ? e.t : Math.min(b.firstEntry, e.t);
      b.lastEntry = Math.max(b.lastEntry ?? 0, e.t);
      b.tx.push({ t: e.t, amount, cat, desc: note ?? String(e.Description || '').split('\n')[0].slice(0, 140) });
    }
    const day = new Date(e.t).toISOString().slice(0, 10);
    const dd = b.daily.get(day) || { rev: 0, fixed: 0, variable: 0, overhead: 0 };
    const g = CATEGORIES[cat].group;
    dd[g === 'revenue' ? 'rev' : g] += amount;
    b.daily.set(day, dd);
  };

  for (const a of fleet) book(a.Id); // every fleet aircraft gets a book, even without own lines
  const startOf = (b) => parseUtc(b.lease?.StartDate) ?? b.firstEntry ?? firstFlight.get(b.id) ?? null;
  const overheadPool = [];
  const excluded = { n: 0, sum: 0, byDesc: {} };
  const catTotals = {};
  for (const e of entries) {
    const acc = accs[e.AccountId];
    let cat = classify(e, acc);
    let acId = e.AircraftId || null;
    if (!acId && (cat === 'leaseRefund' || cat === 'lease')) {
      const m = String(e.Description).toUpperCase().match(/\(([A-Z0-9-]{3,10})\)|FOR AIRCRAFT .*\(([A-Z0-9-]+)\)|THE ([A-Z0-9-]{3,10}) LEASE/);
      const reg = m && (m[1] || m[2] || m[3]);
      if (reg && regToId.has(reg)) acId = regToId.get(reg);
    }
    if (!acId && (cat === 'lease' || cat === 'leaseRefund')) {
      // lease line for an aircraft we can't resolve (e.g. returned) → keep it on its own book
      const reg = String(e.Description).match(/the ([A-Z0-9-]{3,10}) lease/i)?.[1] || String(e.Description).match(/\(([A-Z0-9-]{3,10})\)/)?.[1];
      if (reg) { acId = `reg:${reg.toUpperCase()}`; if (!info.has(acId)) info.set(acId, { id: acId, registration: reg.toUpperCase(), type: null, inFleet: false, lease: null }); }
    }
    if (cat === 'slot') {
      const fn = String(e.Description).match(/Flight #(\d+)/)?.[1];
      acId = fn && fnToAc.get(fn);
      if (!acId) cat = 'slotOH';
    }
    if (cat === 'excluded') { excluded.n++; excluded.sum += e.Amount; const k = String(e.Description).split(/[:(\n]/)[0].trim().slice(0, 50); excluded.byDesc[k] = (excluded.byDesc[k] || 0) + e.Amount; continue; }
    catTotals[cat] = (catTotals[cat] || 0) + e.Amount;
    if (CATEGORIES[cat].group === 'overhead' || !acId) {
      overheadPool.push({ e, cat: CATEGORIES[cat].group === 'overhead' ? cat : 'otherOH' });
      continue;
    }
    post(acId, cat, e.Amount, e);
  }

  // allocate overhead: fleet management equally among aircraft active that day; the rest by block-hour share
  const active = (t) => [...books.values()].filter((b) => { const st = startOf(b); return st != null && st <= t && (b.inFleet || (b.lastEntry ?? 0) >= t - 7 * DAY); });
  const totalHours = [...hours].filter(([id]) => books.has(id)).reduce((s, [, h]) => s + h, 0);
  for (const { e, cat } of overheadPool) {
    if (cat === 'fleetMgmt') {
      const act = active(e.t);
      for (const b of act) post(b.id, cat, e.Amount / act.length, e);
      continue;
    }
    if (totalHours > 0) for (const [id, h] of hours) if (books.has(id) && h) post(id, cat, (e.Amount * h) / totalHours, e);
  }

  const aircraft = [...books.values()].map((b) => {
    const sum = (g) => Object.entries(b.cats).filter(([c]) => CATEGORIES[c].group === g).reduce((s, [, v]) => s + v, 0);
    const L = b.lease;
    const leaseStart = parseUtc(L?.StartDate) ?? b.firstEntry ?? firstFlight.get(b.id) ?? null;
    const leaseEnd = parseUtc(L?.EndDate);
    const since = leaseStart ?? b.firstEntry;
    const days = since ? Math.max((Math.min(now, b.inFleet ? now : (b.lastEntry ?? now)) - since) / DAY, 1 / 24) : null;
    const weeksElapsed = L && leaseStart ? Math.max(0, (Math.min(now, leaseEnd ?? now) - leaseStart) / (7 * DAY)) : null;
    const leasePaid = -((b.cats.lease || 0) + (b.cats.leaseRefund || 0));
    const leaseAccrued = L?.WeeklyPayment && weeksElapsed != null ? L.WeeklyPayment * weeksElapsed : leasePaid;
    const revenue = sum('revenue'), fixed = sum('fixed'), variable = sum('variable'), overhead = sum('overhead');
    const h = hours.get(b.id) || 0;
    // cumulative daily series (cash basis)
    let cr = 0, cf = 0, cv = 0, co = 0;
    const timeline = [...b.daily.entries()].sort(([a], [c]) => (a < c ? -1 : 1)).map(([day, d]) => {
      cr += d.rev; cf += d.fixed; cv += d.variable; co += d.overhead;
      return [day, r0(cr), r0(cf), r0(cv), r0(co)];
    });
    return {
      id: b.id,
      registration: b.registration || `#${b.id.slice(0, 6)}`,
      type: b.type,
      inFleet: b.inFleet,
      since: since ? new Date(since).toISOString() : null,
      days: days != null ? Math.round(days * 10) / 10 : null,
      lease: L ? { weekly: L.WeeklyPayment, start: L.StartDate, end: L.EndDate, next: L.NextWeeklyPaymentDate, weeksElapsed: Math.round((weeksElapsed ?? 0) * 10) / 10,
        totalWeeks: leaseEnd && leaseStart ? Math.round((leaseEnd - leaseStart) / (7 * DAY)) : null } : null,
      flights: flightsN.get(b.id) || 0,
      blockHours: Math.round(h * 10) / 10,
      cats: Object.fromEntries(Object.entries(b.cats).map(([k, v]) => [k, r0(v)])),
      revenue: r0(revenue), fixed: r0(fixed), variable: r0(variable), overhead: r0(overhead),
      leasePaid: r0(leasePaid), leaseAccrued: r0(leaseAccrued),
      timeline,
      tx: b.tx.sort((a, c) => c.t - a.t).slice(0, 40).map((x) => ({ ...x, t: new Date(x.t).toISOString(), amount: Math.round(x.amount * 100) / 100 })),
    };
  }).sort((a, b) => (b.revenue + b.fixed + b.variable) - (a.revenue + a.fixed + a.variable));

  const ledgerFrom = entries[0]?.t, ledgerTo = entries.at(-1)?.t;
  return {
    from: ledgerFrom ? new Date(ledgerFrom).toISOString() : null,
    to: ledgerTo ? new Date(ledgerTo).toISOString() : null,
    entries: entries.length,
    categories: CATEGORIES,
    catTotals: Object.fromEntries(Object.entries(catTotals).map(([k, v]) => [k, r0(v)])),
    excluded: { n: excluded.n, sum: r0(excluded.sum), top: Object.entries(excluded.byDesc).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).map(([k, v]) => [k, r0(v)]) },
    aircraft,
  };
}
