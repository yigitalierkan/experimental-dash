// Minimal OnAir API client (https://server1.onair.company/swagger/index.html)
// Auth: header "oa-apikey". Responses are wrapped as { Content, Error }.

const DEFAULT_BASE = 'https://server1.onair.company/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OnAirClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE, minIntervalMs = 1200, log = console.log }) {
    if (!apiKey) throw new Error('ONAIR_API_KEY eksik');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this._last = 0;
    this.calls = 0;
  }

  async get(path, query = {}, { retries = 5, optional = false } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const wait = this._last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this._last = Date.now();
      this.calls++;
      let res;
      try {
        res = await fetch(url, {
          headers: typeof window === 'undefined'
            ? { 'oa-apikey': this.apiKey, Accept: 'application/json', 'User-Agent': 'onair-dashboard (github actions)' }
            : { 'oa-apikey': this.apiKey, Accept: 'application/json' }, // browsers manage User-Agent themselves
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new Error(`GET ${url.pathname} ağ hatası: ${e.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after')) || 2 ** attempt;
        this.log(`  ${res.status} ${url.pathname} → ${ra}s sonra tekrar`);
        await sleep(ra * 1000);
        continue;
      }
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        const msg = `GET ${url.pathname}${url.search} → HTTP ${res.status}: ${String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`;
        if (optional) { this.log('  (opsiyonel) ' + msg); return null; }
        throw new Error(msg);
      }
      // OnAir sometimes answers 200 with only { Error: "..." } (no Content)
      if (body && typeof body === 'object' && !Array.isArray(body) && body.Error && !('Content' in body)) {
        const msg = `${url.pathname}: ${body.Error}`;
        if (optional) { this.log(`  (opsiyonel) ${msg}`); return null; }
        throw new Error(msg);
      }
      // unwrap { Content } — some endpoints (economic_details) nest it twice
      let out = body;
      while (out && typeof out === 'object' && !Array.isArray(out) && 'Content' in out) {
        if (out.Error && out.Content == null) {
          if (optional) { this.log(`  (opsiyonel) ${url.pathname}: ${out.Error}`); return null; }
          throw new Error(`${url.pathname}: ${out.Error}`);
        }
        out = out.Content;
      }
      return out;
    }
  }
}

/** Describe a value's structure (keys/types/lengths only — never values) for logs. */
export function shape(v, depth = 0) {
  if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < 2 ? ` of ${shape(v[0], depth + 1)}` : '');
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (depth >= 2) return `{${ks.length} keys}`;
    return '{' + ks.slice(0, 25).map((k) => `${k}:${Array.isArray(v[k]) || (v[k] && typeof v[k] === 'object') ? shape(v[k], depth + 1) : typeof v[k]}`).join(', ') + (ks.length > 25 ? ', …' : '') + '}';
  }
  return typeof v;
}

/** Accept either a bare array or an object wrapping one (Items/Flights/Aircraft/...). */
export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['Items', 'items', 'Data', 'data', 'Results', 'Flights', 'Aircraft', 'Fleet', 'Routes', 'Entries']) if (Array.isArray(v[k])) return v[k];
    const arr = Object.values(v).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

/**
 * Download what the dashboard needs, rate-limit friendly:
 *  - essential first (VA/company, fleet, cash_flow, routes), flights last;
 *  - `prev` (previous snapshot) is used as a cache: airports, account names, former aircraft and
 *    already-known flights are reused, so a normal run only fetches the newest flight page per aircraft.
 */
export async function fetchSnapshot({ client, companyId, vaMode = false, flightDays = 30, budgetMs = 420_000, prev = null, log = console.log }) {
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const C = `/companies/${companyId}`;
  const raw = { fetchedAt: new Date().toISOString(), companyId, mode: vaMode ? 'va' : 'company' };
  if (prev) log(`Önbellek: ${prev.fetchedAt} tarihli snapshot (${prev.flights?.length ?? 0} uçuş)`);

  // 1) identity
  if (vaMode) {
    log('→ virtual airline');
    try {
      raw.va = await client.get(`/virtual_airlines/${companyId}`);
    } catch (e) {
      throw new Error(`Virtual Airline bilgisi alınamadı → ${e.message}\n` +
        'Kontrol et: ONAIR_VA_ID, VA\'nın Id\'si mi ve ONAIR_API_KEY bu VA\'nın API key\'i mi? (OnAir client → Virtual Airline → Settings)');
    }
    raw.company = { Name: raw.va?.Name, AirlineCode: raw.va?.AirlineCode, Level: raw.va?.Level, Reputation: raw.va?.Reputation };
    log(`  VA: ${raw.va?.Name ?? '?'} (${raw.va?.AirlineCode ?? ''})`);
  } else {
    log('→ company');
    try {
      raw.company = await client.get(C);
    } catch (e) {
      throw new Error(`Şirket bilgisi alınamadı → ${e.message}\n` +
        'Kontrol et: ONAIR_COMPANY_ID doğru şirket UUID\'si mi ve ONAIR_API_KEY bu şirkete mi ait? ' +
        'Şirketi Virtual Airline olarak işletiyorsanız ONAIR_VA_ID secret\'ını kullanın.');
    }
    log(`  şirket: ${raw.company?.Name ?? '?'} (${raw.company?.AirlineCode ?? ''})`);
  }

  // 2) fleet + ledger (required)
  log('→ fleet');
  raw.fleet = asArray(await client.get(`${C}/fleet`));
  log(`  ${raw.fleet.length} uçak`);

  log('→ cash_flow');
  raw.cashFlow = await client.get(`${C}/cash_flow`);
  const ents = raw.cashFlow?.Entries || [];
  log(`  ${ents.length} satır, ${ents.map((e) => e.CreationDate).sort()[0] ?? '—'} → bugün`);

  // account names: reuse cached unless the ledger uses an AccountId we have not seen
  const knownAcc = new Set();
  for (const grp of [prev?.incomeStatementAll?.REVAccounts, prev?.incomeStatementAll?.EXPAccounts]) for (const a of grp || []) for (const e of a.Entries || []) knownAcc.add(e.AccountId);
  const needAcc = ents.some((e) => e.AccountId && !knownAcc.has(e.AccountId));
  if (needAcc || !prev?.incomeStatementAll) {
    log('→ income_statement (hesap adları)');
    raw.incomeStatementAll = await client.get(`${C}/income_statement`, { startDate: '2020-01-01T00:00:00Z', endDate: new Date().toISOString() }, { optional: true })
      ?? prev?.incomeStatementAll ?? null;
  } else raw.incomeStatementAll = prev.incomeStatementAll;

  // 3) routes (+ airports not cached yet)
  log('→ regular_routes');
  raw.regularRoutes = (await client.get('/regular_routes', {}, { optional: true })) ?? prev?.regularRoutes ?? [];
  log(`  ${asArray(raw.regularRoutes).length} rota`);
  raw.airports = { ...(prev?.airports || {}) };
  const missingIcaos = [...collectBareIcaos(raw.regularRoutes)].filter((i) => !raw.airports[i]);
  if (missingIcaos.length) log(`→ airports (${missingIcaos.length} yeni)`);
  for (const icao of missingIcaos) { if (left() < 60_000) break; raw.airports[icao] = await client.get(`/airports/${icao}`, {}, { optional: true }); }

  // 4) former aircraft (returned leases) — cached by id
  const fleetIds = new Set(raw.fleet.map((a) => a.Id));
  raw.formerAircraft = { ...(prev?.formerAircraft || {}) };
  const former = [...new Set(ents.map((e) => e.AircraftId).filter((id) => id && !fleetIds.has(id) && !(id in raw.formerAircraft)))];
  if (former.length) log(`→ eski uçaklar (${former.length} yeni)`);
  for (const id of former) { if (left() < 60_000) break; raw.formerAircraft[id] = await client.get(`/aircraft/${id}`, {}, { optional: true }); }

  // 5) flights — incremental: newest page per aircraft, deeper pages only when the cache has a gap
  const leaseStarts = raw.fleet.map((a) => Date.parse((a.AircraftLease?.StartDate || '') + 'Z')).filter(Number.isFinite);
  const cutoff = Math.min(Date.now() - flightDays * 86400_000, ...leaseStarts);
  const byId = new Map((prev?.flights || []).map((f) => [f.Id, f]));
  const limit = 50;
  log(`→ flights (${new Date(cutoff).toISOString().slice(0, 10)} sonrası, önbellekte ${byId.size})`);
  let skipped = 0;
  // pass 1: newest page for every aircraft (keeps "last flight / idle" correct even under rate limits)
  const deeper = [];
  for (const ac of raw.fleet) {
    if (left() < 45_000) { skipped++; continue; }
    const list = asArray(await client.get(`/aircraft/${ac.Id}/flights`, { startIndex: 0, limit }, { optional: true }));
    let known = 0;
    for (const f of list) { if (byId.get(f.Id)?.EngineOffTime) known++; byId.set(f.Id, { ...f, AircraftId: f.AircraftId || ac.Id }); }
    const oldest = Math.min(...list.map((f) => Date.parse((f.StartTime || '') + 'Z') || Infinity));
    if (list.length === limit && oldest >= cutoff && known === 0) deeper.push(ac);
  }
  // pass 2: older pages only where the cache has a gap
  for (const ac of deeper) {
    for (let page = 1; page < 40; page++) {
      if (left() < 45_000) { skipped++; break; }
      const list = asArray(await client.get(`/aircraft/${ac.Id}/flights`, { startIndex: page * limit, limit }, { optional: true }));
      let known = 0;
      for (const f of list) { if (byId.get(f.Id)?.EngineOffTime) known++; byId.set(f.Id, { ...f, AircraftId: f.AircraftId || ac.Id }); }
      const oldest = Math.min(...list.map((f) => Date.parse((f.StartTime || '') + 'Z') || Infinity));
      if (list.length < limit || oldest < cutoff || known > 0) break;
    }
  }
  if (skipped) log(`  ! zaman bütçesi: ${skipped} uçakta eski uçuş sayfaları sonraki çalıştırmaya kaldı`);
  raw.flights = [...byId.values()].filter((f) => (Date.parse((f.StartTime || '') + 'Z') || 0) >= cutoff - 7 * 86400_000);
  log(`  ${raw.flights.length} uçuş (${Math.round((Date.now() - t0) / 1000)}s, ${client.calls} istek)`);

  raw.apiCalls = client.calls;
  return raw;
}

/** ICAO codes that appear as plain strings (e.g. "DepartureICAO": "LTFM") without coordinates nearby. */
export function collectBareIcaos(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((n) => collectBareIcaos(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  const hasCoords = typeof node.Latitude === 'number' && typeof node.Longitude === 'number';
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && /icao$/i.test(k) && /^[A-Z0-9]{3,4}$/.test(v) && !(k === 'ICAO' && hasCoords)) out.add(v);
    else if (v && typeof v === 'object') collectBareIcaos(v, out);
  }
  return out;
}

/** Keep only what the dashboard needs so the snapshot can be stored and reused as a fallback. */
export function slimSnapshot(raw) {
  const ap = (a) => (a ? { ICAO: a.ICAO, Name: a.Name, City: a.City, CountryCode: a.CountryCode, Latitude: a.Latitude, Longitude: a.Longitude } : null);
  const strip = (o, drop) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !drop.includes(k)));
  return {
    ...raw,
    company: strip(raw.company, ['CompanySkillPoints', 'DiscordWebhooks']),
    va: undefined,
    members: (raw.members || []).length,
    fleet: (raw.fleet || []).map((a) => ({
      ...strip(a, ['RentCompany', 'Failures', 'Engines']),
      AircraftType: a.AircraftType ? { DisplayName: a.AircraftType.DisplayName, TypeName: a.AircraftType.TypeName } : null,
      CurrentAirport: ap(a.CurrentAirport),
      AircraftLease: a.AircraftLease ? strip(a.AircraftLease, ['Company']) : null,
    })),
    flights: (raw.flights || []).map((f) => ({
      Id: f.Id, AircraftId: f.AircraftId, StartTime: f.StartTime, EndTime: f.EndTime, EngineOnTime: f.EngineOnTime, EngineOffTime: f.EngineOffTime,
      AirborneTime: f.AirborneTime, LandedTime: f.LandedTime, Registered: f.Registered,
      DepartureAirport: ap(f.DepartureAirport), ArrivalActualAirport: ap(f.ArrivalActualAirport), ArrivalIntendedAirport: ap(f.ArrivalIntendedAirport),
    })),
    incomeStatementAll: raw.incomeStatementAll ? {
      REVAccounts: (raw.incomeStatementAll.REVAccounts || []).map((a) => ({ Name: a.Name, ShortName: a.ShortName, Entries: (a.Entries || []).slice(0, 1).map((e) => ({ AccountId: e.AccountId, Account: e.Account })) })),
      EXPAccounts: (raw.incomeStatementAll.EXPAccounts || []).map((a) => ({ Name: a.Name, ShortName: a.ShortName, Entries: (a.Entries || []).slice(0, 1).map((e) => ({ AccountId: e.AccountId, Account: e.Account })) })),
    } : null,
    formerAircraft: Object.fromEntries(Object.entries(raw.formerAircraft || {}).map(([k, a]) => [k, a ? { Identifier: a.Identifier, AircraftType: { DisplayName: a.AircraftType?.DisplayName } } : null])),
    airports: Object.fromEntries(Object.entries(raw.airports || {}).map(([k, a]) => [k, ap(a)])),
  };
}
