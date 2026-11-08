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

/** Decide how the company holds an aircraft → which capital cost applies. */
export function holdingMode(ac, companyId, override = 'auto') {
  if (override && override !== 'auto') return override;
  if (ac.RentCompanyId && ac.RentCompanyId === companyId) return 'rent';
  return 'own';
}

/**
 * Hourly economics per aircraft from /aircraft/{id}/economic_details.
 * Model (documented in README):
 *   operatingProfit/h = HourlyProfit (revenue − fuel − crew − maintenance)
 *   revenue/h         = HourlyProfit + fuel + crew + maintenance
 *   variable cost/h   = fuel + crew + maintenance (+ rent/h when rented)
 *   fixed cost/week   = CostWeeklyOwning | CostWeeklyLease | 0 (rent)
 */
export function economicsModel(e, mode) {
  if (!e) return null;
  const fuel = num(e.CostHourlyFuel);
  const crew = num(e.CostHourlyCrew);
  const maint = num(e.CostHourlyTotalMaintenance);
  const revenuePerHour = num(e.HourlyProfit) + fuel + crew + maint;
  const rentPerHour = mode === 'rent' ? num(e.CostHourlyRentTotal) : 0;
  const fixedPerWeek = mode === 'own' ? num(e.CostWeeklyOwning) : mode === 'lease' ? num(e.CostWeeklyLease) : 0;
  return {
    revenuePerHour: round(revenuePerHour),
    fuelPerHour: round(fuel),
    crewPerHour: round(crew),
    maintenancePerHour: round(maint),
    rentPerHour: round(rentPerHour),
    variableCostPerHour: round(fuel + crew + maint + rentPerHour),
    fixedCostPerWeek: round(fixedPerWeek),
    onairWeeklyHours: round(num(e.AverageWeeklyFlightHours), 1),
    onairProfitPerHour: round(mode === 'own' ? num(e.ProfitHourlyOwning) : mode === 'lease' ? num(e.ProfitHourlyLease) : num(e.HourlyProfit) - num(e.CostHourlyRentTotal)),
  };
}

/** Projection for `weeks` at `weeklyHours`. Same formula used by the front-end. */
export function project(model, weeklyHours, weeks) {
  if (!model) return null;
  const h = weeklyHours * weeks;
  const revenue = model.revenuePerHour * h;
  const cost = model.variableCostPerHour * h + model.fixedCostPerWeek * weeks;
  return { hours: round(h, 1), revenue: round(revenue, 0), cost: round(cost, 0), profit: round(revenue - cost, 0) };
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

/** Sum cash-flow lines whose description mentions the registration. */
export function cashFlowByAircraft(cashFlow, fleet, now, days = 30) {
  const entries = (cashFlow && (cashFlow.Entries || cashFlow.entries)) || (Array.isArray(cashFlow) ? cashFlow : []);
  const from = now - days * DAY;
  const out = {};
  const regs = fleet
    .filter((a) => a.Identifier && a.Identifier.length >= 3)
    .map((a) => ({ id: a.Id, re: new RegExp(`(^|[^A-Z0-9])${a.Identifier.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^A-Z0-9]|$)`, 'i') }));
  for (const e of entries) {
    const t = parseUtc(e.CreationDate);
    if (t == null || t < from) continue;
    const desc = String(e.Description || '');
    const hit = regs.find((r) => r.re.test(desc));
    if (!hit) continue;
    const o = (out[hit.id] ||= { income: 0, expense: 0, lines: 0 });
    const amt = num(e.Amount);
    if (amt >= 0) o.income += amt; else o.expense += -amt;
    o.lines++;
  }
  for (const o of Object.values(out)) { o.income = round(o.income, 0); o.expense = round(o.expense, 0); o.net = round(o.income - o.expense, 0); }
  return { days, byAircraft: out, matchedEntries: Object.values(out).reduce((s, o) => s + o.lines, 0), totalEntries: entries.length };
}

export function buildDashboard(raw, { now = Date.now(), holding = 'auto', idleHours = 24 } = {}) {
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
  const cash = cashFlowByAircraft(raw.cashFlow, raw.fleet || [], now, 30);

  const aircraft = (raw.fleet || []).map((ac) => {
    const ws = (byAc.get(ac.Id) || []).sort((a, b) => b.start - a.start);
    const last = ws[0] || null;
    const lastActivity = last ? (last.end ?? now) : null; // ongoing flight counts as now
    const status = AIRCRAFT_STATUS[ac.AircraftStatus] ?? String(ac.AircraftStatus ?? '?');
    const inFlight = ac.AircraftStatus === 3 || (last && !last.done && now - last.start < 18 * HOUR);
    const mode = holdingMode(ac, companyId, holding);
    const model = economicsModel(raw.economics?.[ac.Id], mode);
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
      holding: mode,
      airframeHours: round(num(ac.airframeHours), 1),
      condition: round(num(ac.airframeCondition) * 100, 1),
      hoursBefore100h: round(ac.HoursBefore100HInspection, 1),
      mustDoMaintenance: !!ac.MustDoMaintenance,
      lastFlightStart: last ? new Date(last.start).toISOString() : null,
      lastFlightEnd: last?.end ? new Date(last.end).toISOString() : null,
      hoursSinceLastFlight: hoursSince != null ? round(hoursSince, 1) : null,
      idle24h: !inFlight && (hoursSince == null || hoursSince >= idleHours),
      turnover: { d7: u7, d30: u30 },
      economics: model,
      projection30d: project(model, u7.blockHours, 30 / 7),
      cashFlow30d: cash.byAircraft[ac.Id] || null,
    };
  });

  const totals = aircraft.reduce((t, a) => {
    const p = a.projection30d;
    if (p) { t.revenue += p.revenue; t.cost += p.cost; t.profit += p.profit; }
    t.hours7 += a.turnover.d7.blockHours; t.flights7 += a.turnover.d7.flights;
    return t;
  }, { revenue: 0, cost: 0, profit: 0, hours7: 0, flights7: 0 });

  return {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: raw.fetchedAt,
    company: raw.company ? { name: raw.company.Name, code: raw.company.AirlineCode, level: raw.company.Level, reputation: raw.company.Reputation } : null,
    cash: raw.cashFlow ? { current: raw.cashFlow.CompanyCurrentCash ?? null } : null,
    settings: { holding, idleHours },
    totals: { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v, 1)])), aircraft: aircraft.length, idle24h: aircraft.filter((a) => a.idle24h).length },
    cashMatch: { matched: cash.matchedEntries, total: cash.totalEntries },
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
        flightsPerDay7d: d?.turnover.d7.flightsPerDay ?? null, profit30d: d?.projection30d?.profit ?? null };
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
