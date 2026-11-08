// Minimal OnAir API client (https://server1.onair.company/swagger/index.html)
// Auth: header "oa-apikey". Responses are wrapped as { Content, Error }.

const DEFAULT_BASE = 'https://server1.onair.company/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OnAirClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE, minIntervalMs = 250, log = console.log }) {
    if (!apiKey) throw new Error('ONAIR_API_KEY eksik');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this._last = 0;
    this.calls = 0;
  }

  async get(path, query = {}, { retries = 4, optional = false } = {}) {
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
          headers: {
            'oa-apikey': this.apiKey,
            Accept: 'application/json',
            'User-Agent': 'onair-dashboard (github actions)',
          },
          signal: AbortSignal.timeout(60_000),
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

/** Download everything the dashboard needs. Returns a "raw" snapshot object. */
export async function fetchSnapshot({ client, companyId, vaMode = false, flightDays = 30, maxFlightPages = 60, log = console.log }) {
  const C = `/companies/${companyId}`;
  const raw = { fetchedAt: new Date().toISOString(), companyId, mode: vaMode ? 'va' : 'company' };

  if (vaMode) {
    log('→ virtual airline');
    try {
      raw.va = await client.get(`/virtual_airlines/${companyId}`);
    } catch (e) {
      throw new Error(`Virtual Airline bilgisi alınamadı → ${e.message}\n` +
        'Kontrol et: ONAIR_VA_ID, VA\'nın Id\'si mi ve ONAIR_API_KEY bu VA\'nın API key\'i mi? (OnAir client → Virtual Airline → Settings)');
    }
    log(`  yapı: ${shape(raw.va)}`);
    // VA'lar OnAir'de bir şirket kaydına sahip; isim/kod alanları VA nesnesinde de bulunur
    raw.company = { Name: raw.va?.Name, AirlineCode: raw.va?.AirlineCode, Level: raw.va?.Level, Reputation: raw.va?.Reputation };
    log(`  VA: ${raw.va?.Name ?? '?'} (${raw.va?.AirlineCode ?? ''})`);
    raw.company = { ...raw.company, ...((await client.get(C, {}, { optional: true })) || {}) };
    log('→ members');
    raw.members = asArray(await client.get(`/virtual_airlines/${companyId}/members`, {}, { optional: true }));
    log(`  ${raw.members.length} üye`);
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

  log('→ fleet');
  const fleetRaw = await client.get(`${C}/fleet`);
  log(`  yapı: ${shape(fleetRaw)}`);
  raw.fleet = asArray(fleetRaw);
  log(`  ${raw.fleet.length} uçak`);
  if (!raw.fleet.length) {
    log('  ! Filo boş. Dashboard yapısı:');
    log('    ' + shape(await client.get(`${C}/dashboard`, {}, { optional: true })));
  }

  const leaseStarts = raw.fleet.map((a) => Date.parse((a.AircraftLease?.StartDate || '') + 'Z')).filter(Number.isFinite);
  const cutoff = Math.min(Date.now() - flightDays * 86400_000, ...leaseStarts);
  log(`→ flights (sayfalı, ${new Date(cutoff).toISOString().slice(0, 10)} sonrası)`);
  const flights = [];
  const seen = new Set();
  const limit = 50;
  for (let page = 0; page < maxFlightPages; page++) {
    const resp = await client.get(`${C}/flights`, { startIndex: page * limit, limit });
    if (page === 0) log(`  yapı: ${shape(resp)}`);
    const batch = asArray(resp);
    let added = 0;
    for (const f of batch) { if (!seen.has(f.Id)) { seen.add(f.Id); flights.push(f); added++; } }
    const oldest = Math.min(...batch.map((f) => Date.parse(f.StartTime || f.EngineOnTime || 0) || Infinity));
    if (batch.length < limit || added === 0 || oldest < cutoff) break;
  }
  raw.flights = flights;
  log(`  ${flights.length} uçuş`);

  // Some flights (esp. AI / regular-route) may be missing from company feed; top up per aircraft.
  log('→ aircraft flights (uçak başına)');
  for (const ac of raw.fleet) {
    for (let page = 0; page < 40; page++) {
      const list = asArray(await client.get(`/aircraft/${ac.Id}/flights`, { startIndex: page * limit, limit }, { optional: true }));
      let added = 0;
      for (const f of list) {
        if (!seen.has(f.Id)) { seen.add(f.Id); flights.push({ ...f, AircraftId: f.AircraftId || ac.Id }); added++; }
      }
      const oldest = Math.min(...list.map((f) => Date.parse((f.StartTime || '') + 'Z') || Infinity));
      if (list.length < limit || oldest < cutoff || (added === 0 && page > 0)) break;
    }
  }
  log(`  toplam ${flights.length} uçuş`);

  log('→ cash_flow');
  raw.cashFlow = await client.get(`${C}/cash_flow`, {}, { optional: true });
  const ents = raw.cashFlow?.Entries || [];
  log(`  ${ents.length} satır, ${ents.map((e) => e.CreationDate).sort()[0] ?? '—'} → bugün`);

  log('→ income_statement (tüm zamanlar, hesap adları için)');
  raw.incomeStatementAll = await client.get(`${C}/income_statement`, {
    startDate: '2020-01-01T00:00:00Z', endDate: new Date().toISOString(),
  }, { optional: true });

  // aircraft that appear in the ledger but are no longer in the fleet (returned leases)
  const fleetIds = new Set(raw.fleet.map((a) => a.Id));
  const former = [...new Set(ents.map((e) => e.AircraftId).filter((id) => id && !fleetIds.has(id)))];
  raw.formerAircraft = {};
  if (former.length) log(`→ eski uçaklar (${former.length})`);
  for (const id of former) raw.formerAircraft[id] = await client.get(`/aircraft/${id}`, {}, { optional: true });

  log('→ regular_routes');
  raw.regularRoutes = await client.get('/regular_routes', {}, { optional: true });
  log(`  yapı: ${shape(raw.regularRoutes)}`);
  const r0 = asArray(raw.regularRoutes)[0];
  if (r0) for (const k of Object.keys(r0)) if (Array.isArray(r0[k]) && r0[k].length) log(`  ${k}[0]: ${shape(r0[k][0])}`);

  // Resolve airports referenced only by ICAO (routes) so they can be drawn on the map.
  raw.airports = {};
  const icaos = collectBareIcaos(raw.regularRoutes);
  if (icaos.size) log(`→ airports (${icaos.size})`);
  for (const icao of icaos) {
    raw.airports[icao] = await client.get(`/airports/${icao}`, {}, { optional: true });
  }

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
