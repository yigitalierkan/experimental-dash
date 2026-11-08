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
      if (body && typeof body === 'object' && 'Content' in body) {
        if (body.Error && body.Content == null) {
          if (optional) { this.log(`  (opsiyonel) ${url.pathname}: ${body.Error}`); return null; }
          throw new Error(`${url.pathname}: ${body.Error}`);
        }
        return body.Content;
      }
      return body;
    }
  }
}

/** Download everything the dashboard needs. Returns a "raw" snapshot object. */
export async function fetchSnapshot({ client, companyId, flightDays = 30, maxFlightPages = 60, log = console.log }) {
  const C = `/companies/${companyId}`;
  const raw = { fetchedAt: new Date().toISOString(), companyId };

  log('→ company');
  raw.company = await client.get(C, {}, { optional: true });

  log('→ fleet');
  raw.fleet = (await client.get(`${C}/fleet`)) || [];
  log(`  ${raw.fleet.length} uçak`);

  log('→ flights (sayfalı)');
  const cutoff = Date.now() - flightDays * 86400_000;
  const flights = [];
  const seen = new Set();
  const limit = 50;
  for (let page = 0; page < maxFlightPages; page++) {
    const batch = (await client.get(`${C}/flights`, { startIndex: page * limit, limit })) || [];
    let added = 0;
    for (const f of batch) { if (!seen.has(f.Id)) { seen.add(f.Id); flights.push(f); added++; } }
    const oldest = Math.min(...batch.map((f) => Date.parse(f.StartTime || f.EngineOnTime || 0) || Infinity));
    if (batch.length < limit || added === 0 || oldest < cutoff) break;
  }
  raw.flights = flights;
  log(`  ${flights.length} uçuş`);

  // Some flights (esp. AI / regular-route) may be missing from company feed; top up per aircraft.
  log('→ aircraft flights (uçak başına son 20)');
  for (const ac of raw.fleet) {
    const list = await client.get(`/aircraft/${ac.Id}/flights`, { startIndex: 0, limit: 20 }, { optional: true });
    for (const f of list || []) {
      if (!seen.has(f.Id)) { seen.add(f.Id); flights.push({ ...f, AircraftId: f.AircraftId || ac.Id }); }
    }
  }
  log(`  toplam ${flights.length} uçuş`);

  log('→ economic_details (uçak başına)');
  raw.economics = {};
  for (const ac of raw.fleet) {
    raw.economics[ac.Id] = await client.get(`/aircraft/${ac.Id}/economic_details`, {}, { optional: true });
  }

  log('→ cash_flow');
  raw.cashFlow = await client.get(`${C}/cash_flow`, {}, { optional: true });

  log('→ income_statement (30g)');
  raw.incomeStatement = await client.get(`${C}/income_statement`, {
    startDate: new Date(cutoff).toISOString(),
    endDate: new Date().toISOString(),
  }, { optional: true });

  log('→ regular_routes');
  raw.regularRoutes = await client.get('/regular_routes', {}, { optional: true });

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
