// Pure functions: raw OnAir snapshot → dashboard data. No network here.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const AIRCRAFT_STATUS = { 0: 'Idle', 1: 'Maintenance', 2: 'ApronWork', 3: 'InFlight', 4: 'Warp', 5: 'Ferry' };

/** OnAir returns UTC timestamps without a zone suffix ("2024-05-01T10:00:00.123"). */
export function parseUtc(s) {
  if (!s || typeof s !== 'string' || s.startsWith('0001-')) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Block window of a flight: engine on → engine off, with fallbacks. */
export function flightWindow(f) {
  const start = parseUtc(f.EngineOnTime) ?? parseUtc(f.AirborneTime) ?? parseUtc(f.StartTime);
  const end = parseUtc(f.EngineOffTime) ?? parseUtc(f.LandedTime) ?? parseUtc(f.EndTime);
  if (start == null) return null;
  const done = end != null && end >= start;
  return { start, end: done ? end : null, hours: done ? (end - start) / HOUR : 0, done };
}

function airportLite(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    icao: a.ICAO ?? null,
    name: a.Name ?? a.DisplayName ?? null,
    city: a.City ?? null,
    country: a.CountryCode ?? null,
    lat: typeof a.Latitude === 'number' ? a.Latitude : null,
    lon: typeof a.Longitude === 'number' ? a.Longitude : null,
  };
}

/** Utilisation / turnover metrics for one aircraft over a trailing window. */
export function utilisation(flights, now, days) {
  const from = now - days * DAY;
  const inWin = flights.filter((w) => w.start >= from && w.start <= now);
  const hours = inWin.reduce((s, w) => s + Math.min(w.hours, (now - w.start) / HOUR), 0);
  // turnaround = ground time between consecutive completed flights (only gaps < 48h count as turns)
  const done = inWin.filter((w) => w.done).sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < done.length; i++) {
    const g = (done[i].start - done[i - 1].end) / HOUR;
    if (g >= 0 && g < 48) gaps.push(g);
  }
  return {
    flights: inWin.length,
    blockHours: round(hours, 1),
    flightsPerDay: round(inWin.length / days, 2),
    hoursPerDay: round(hours / days, 2),
    utilisationPct: round((hours / (days * 24)) * 100, 1),
    avgTurnaroundHours: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null,
  };
}

export function buildDashboard(raw, { now = Date.now(), idleHours = 24, ledger = null } = {}) {
  const companyId = raw.companyId;
  const byAc = new Map();
  const flightsOut = [];
  for (const f of raw.flights || []) {
    const id = f.AircraftId || f.Aircraft?.Id;
    const w = flightWindow(f);
    if (!id || !w) continue;
    if (!byAc.has(id)) byAc.set(id, []);
    byAc.get(id).push(w);
    flightsOut.push({ aircraftId: id, start: new Date(w.start).toISOString(), end: w.end ? new Date(w.end).toISOString() : null, hours: round(w.hours, 2),
      from: f.DepartureAirport?.ICAO ?? null, to: (f.ArrivalActualAirport || f.ArrivalIntendedAirport)?.ICAO ?? null });
  }
  const pnlById = new Map((ledger?.aircraft || []).map((l) => [l.id, l]));

  const aircraft = (raw.fleet || []).map((ac) => {
    const ws = (byAc.get(ac.Id) || []).sort((a, b) => b.start - a.start);
    const last = ws[0] || null;
    const lastActivity = last ? (last.end ?? now) : null; // ongoing flight counts as now
    const status = AIRCRAFT_STATUS[ac.AircraftStatus] ?? String(ac.AircraftStatus ?? '?');
    const inFlight = ac.AircraftStatus === 3 || (last && !last.done && now - last.start < 18 * HOUR);
    const u7 = utilisation(ws, now, 7);
    const u30 = utilisation(ws, now, 30);
    const hoursSince = lastActivity != null ? (now - lastActivity) / HOUR : null;
    return {
      id: ac.Id,
      registration: ac.Identifier || ac.Id.slice(0, 8),
      nickname: ac.Nickname || null,
      type: ac.AircraftType?.DisplayName || ac.AircraftType?.TypeName || '—',
      status,
      location: airportLite(ac.CurrentAirport),
      position: typeof ac.Latitude === 'number' ? { lat: ac.Latitude, lon: ac.Longitude, heading: ac.Heading ?? null } : null,
      airframeHours: round(num(ac.airframeHours), 1),
      condition: round(num(ac.airframeCondition) * 100, 1),
      hoursBefore100h: round(ac.HoursBefore100HInspection, 1),
      mustDoMaintenance: !!ac.MustDoMaintenance,
      lastFlightStart: last ? new Date(last.start).toISOString() : null,
      lastFlightEnd: last?.end ? new Date(last.end).toISOString() : null,
      hoursSinceLastFlight: hoursSince != null ? round(hoursSince, 1) : null,
      idle24h: !inFlight && (hoursSince == null || hoursSince >= idleHours),
      turnover: { d7: u7, d30: u30 },
      pnl: pnlById.has(ac.Id) ? (({ revenue, fixed, variable, overhead }) => ({ revenue, fixed, variable, overhead, net: revenue + fixed + variable + overhead }))(pnlById.get(ac.Id)) : null,
    };
  });

  const totals = aircraft.reduce((t, a) => {
    t.hours7 += a.turnover.d7.blockHours; t.flights7 += a.turnover.d7.flights;
    return t;
  }, { hours7: 0, flights7: 0 });

  return {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: raw.fetchedAt,
    company: raw.company ? { name: raw.company.Name, code: raw.company.AirlineCode, level: raw.company.Level, reputation: raw.company.Reputation } : null,
    cash: raw.cashFlow ? { current: raw.cashFlow.CompanyCurrentCash ?? null } : null,
    settings: { idleHours },
    totals: { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v, 1)])), aircraft: aircraft.length, idle24h: aircraft.filter((a) => a.idle24h).length },
    ledger,
    aircraft,
    flights: flightsOut.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 2000),
  };
}

// ---------------------------------------------------------------- routes
// /regular_routes has no schema in swagger, so we normalise defensively.

const isAirport = (o) => o && typeof o === 'object' && typeof o.ICAO === 'string' && (typeof o.Latitude === 'number' || 'Name' in o);
const isAircraft = (o) => o && typeof o === 'object' && typeof o.Identifier === 'string' && ('AircraftTypeId' in o || 'AircraftType' in o);

function firstStr(o, keys) { for (const k of keys) if (typeof o?.[k] === 'string' && o[k]) return o[k]; return null; }

/** Walk a route object collecting airports (in document order) and aircraft. */
function scanRoute(node, ctx, depth = 0, key = '') {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) { node.forEach((n) => scanRoute(n, ctx, depth + 1, key)); return; }
  if (typeof node !== 'object') return;
  if (isAirport(node)) { ctx.airports.push({ key, ap: node }); return; }
  // aircraft objects carry their own CurrentAirport/RentAirport — don't treat those as route stops
  if (isAircraft(node)) { ctx.aircraft.set(node.Id, node); return; }
  for (const [k, v] of Object.entries(node)) {
    if (/^(current|rent|home)/i.test(k) && /airport/i.test(k)) continue;
    if (typeof v === 'string') {
      if (/icao$/i.test(k) && /^[A-Z0-9]{3,4}$/.test(v)) ctx.airports.push({ key: k, icao: v });
      else if (/^aircraftid$/i.test(k)) ctx.aircraftIds.add(v);
    } else if (v && typeof v === 'object') scanRoute(v, ctx, depth + 1, k);
  }
}

function routeList(content) {
  if (Array.isArray(content)) return content;
  if (content && typeof content === 'object') {
    for (const k of ['Routes', 'RegularRoutes', 'Items', 'Data', 'routes']) if (Array.isArray(content[k])) return content[k];
    const arr = Object.values(content).find(Array.isArray);
    if (arr) return arr;
  }
  return [];
}

export function buildRoutes(raw, dashboard) {
  const fleetById = new Map((raw.fleet || []).map((a) => [a.Id, a]));
  const dashById = new Map((dashboard?.aircraft || []).map((a) => [a.id, a]));
  const airportCache = { ...(raw.airports || {}) };
  for (const a of raw.fleet || []) if (a.CurrentAirport?.ICAO) airportCache[a.CurrentAirport.ICAO] ||= a.CurrentAirport;

  const routes = routeList(raw.regularRoutes).map((r, i) => {
    if (r && typeof r.DepartureICAO === 'string' && typeof r.ArrivalICAO === 'string') {
      return knownRoute(r, i, { airportCache, fleetById, dashById });
    }
    const ctx = { airports: [], aircraft: new Map(), aircraftIds: new Set() };
    scanRoute(r, ctx);
    // ordered unique stops; prefer departure-ish keys first, arrival-ish last
    const rank = (k) => (/dep|origin|from|start/i.test(k) ? 0 : /arr|dest|to$|end/i.test(k) ? 2 : 1);
    const stops = [];
    const seen = new Set();
    ctx.airports
      .map((x, idx) => ({ ...x, idx, r: rank(x.key) }))
      .sort((a, b) => (ctx.airports.length <= 3 ? a.r - b.r || a.idx - b.idx : a.idx - b.idx))
      .forEach((x) => {
        const ap = x.ap || airportCache[x.icao];
        const icao = x.ap?.ICAO || x.icao;
        if (!icao || seen.has(icao)) return;
        seen.add(icao);
        if (ap && !airportCache[icao]) airportCache[icao] = ap;
        stops.push(airportLite(ap) || { icao, lat: null, lon: null });
      });
    for (const id of ctx.aircraftIds) if (fleetById.has(id)) ctx.aircraft.set(id, fleetById.get(id));
    const aircraft = [...ctx.aircraft.values()].map((a) => {
      const d = dashById.get(a.Id);
      return { id: a.Id, registration: a.Identifier, type: a.AircraftType?.DisplayName || d?.type || null, status: d?.status ?? AIRCRAFT_STATUS[a.AircraftStatus] ?? null,
        flightsPerDay7d: d?.turnover.d7.flightsPerDay ?? null, net: d?.pnl?.net ?? null };
    });
    const distanceNm = stops.length > 1 ? stops.slice(1).reduce((s, b, j) => s + gcNm(stops[j], b), 0) : null;
    return {
      id: r.Id || r.id || `route-${i}`,
      name: firstStr(r, ['Name', 'DisplayName', 'FlightNumber', 'Code', 'Number', 'RouteName']) || stops.map((s) => s.icao).join('–') || `Rota ${i + 1}`,
      flightNumber: firstStr(r, ['FlightNumber', 'FlightCode', 'Code', 'Number']),
      status: r.StatusName ?? r.Status ?? r.RouteStatus ?? null,
      stops,
      distanceNm: distanceNm != null && Number.isFinite(distanceNm) ? Math.round(distanceNm) : null,
      aircraft,
      extra: pickScalars(r),
    };
  });
  return { generatedAt: dashboard?.generatedAt, count: routes.length, routes };
}

const DAY_NAMES = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
/** OnAir UTC time-of-day: hours (e.g. 13.5) or minutes since midnight (e.g. 810). */
export function fmtTimeOfDay(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return typeof v === 'string' ? v : null;
  const mins = v > 24 ? Math.round(v) : Math.round(v * 60);
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}Z`;
}
function fmtDays(days) {
  if (!Array.isArray(days)) return null;
  return days.map((d) => (typeof d === 'number' && d >= 0 && d <= 6 ? DAY_NAMES[d] : typeof d === 'object' ? (d?.Name ?? d?.Day ?? JSON.stringify(d)) : String(d))).join(', ');
}

/** /regular_routes shape observed live: DepartureICAO, ArrivalICAO, AlternateICAO, AircraftId, AircraftIdentifier, Days, Crew, Flights … */
function knownRoute(r, i, { airportCache, fleetById, dashById }) {
  const stop = (icao) => (icao ? airportLite(airportCache[icao]) || { icao, lat: null, lon: null } : null);
  const stops = [stop(r.DepartureICAO), stop(r.ArrivalICAO)].filter(Boolean);
  const alternate = r.AlternateICAO ? stop(r.AlternateICAO) : null;
  const ac = (r.AircraftId && fleetById.get(r.AircraftId)) || [...fleetById.values()].find((a) => a.Identifier && a.Identifier === r.AircraftIdentifier);
  const d = ac ? dashById.get(ac.Id) : null;
  const aircraft = ac || r.AircraftIdentifier ? [{
    id: ac?.Id ?? r.AircraftId ?? null,
    registration: ac?.Identifier ?? r.AircraftIdentifier,
    type: ac?.AircraftType?.DisplayName ?? d?.type ?? null,
    status: d?.status ?? (ac ? AIRCRAFT_STATUS[ac.AircraftStatus] : null) ?? null,
    flightsPerDay7d: d?.turnover.d7.flightsPerDay ?? null,
    net: d?.pnl?.net ?? null,
  }] : [];
  const dist = stops.length === 2 ? gcNm(stops[0], stops[1]) : NaN;
  const days = fmtDays(r.Days);
  const fn = r.FlightNumber != null ? String(r.FlightNumber) : null;
  return {
    id: r.Id || `route-${i}`,
    name: `${r.DepartureICAO} → ${r.ArrivalICAO}`,
    set: r.RouteSetName || null,
    flightNumber: fn,
    status: r.Active === false ? 'Pasif' : 'Aktif',
    active: r.Active !== false,
    stops,
    alternate,
    distanceNm: Number.isFinite(dist) ? Math.round(dist) : null,
    aircraft,
    schedule: { days, daysPerWeek: Array.isArray(r.Days) ? r.Days.length : null, dep: fmtTimeOfDay(r.DepartureTimeUTC), arr: fmtTimeOfDay(r.ArrivalTimeUTC) },
    crew: Array.isArray(r.Crew) ? r.Crew.length : null,
    scheduledFlights: Array.isArray(r.Flights) ? r.Flights.length : null,
    flyInSim: r.FlyInSim ?? null,
    extra: {
      'Rota seti': r.RouteSetName || '—',
      'Günler': days || '—',
      'Kalkış (UTC)': fmtTimeOfDay(r.DepartureTimeUTC) ?? '—',
      'Varış (UTC)': fmtTimeOfDay(r.ArrivalTimeUTC) ?? '—',
      'Yedek meydan': r.AlternateICAO || '—',
      'Ekip': Array.isArray(r.Crew) ? `${r.Crew.length} kişi` : '—',
      'Planlı uçuş': Array.isArray(r.Flights) ? r.Flights.length : '—',
      'Simde uçulur': r.FlyInSim ? 'Evet' : 'Hayır',
    },
  };
}

/** Keep a few readable scalar fields from the route for the detail panel. */
function pickScalars(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (/id$/i.test(k) || k === 'Id') continue;
    if (['string', 'number', 'boolean'].includes(typeof v) && String(v).length < 80) out[k] = v;
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}

export function gcNm(a, b) {
  if (a?.lat == null || b?.lat == null) return NaN;
  const R = 3440.065, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
