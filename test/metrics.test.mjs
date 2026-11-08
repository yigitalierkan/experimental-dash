import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUtc, flightWindow, utilisation, economicsModel, project, buildDashboard, buildRoutes, cashFlowByAircraft } from '../scripts/lib/metrics.mjs';
import { mockSnapshot } from '../scripts/lib/mock.mjs';

const H = 3600e3;

test('parseUtc treats zone-less OnAir timestamps as UTC', () => {
  assert.equal(parseUtc('2024-01-01T00:00:00'), Date.UTC(2024, 0, 1));
  assert.equal(parseUtc('0001-01-01T00:00:00'), null);
  assert.equal(parseUtc(null), null);
});

test('flightWindow uses engine on/off and handles ongoing flights', () => {
  const w = flightWindow({ EngineOnTime: '2024-01-01T10:00:00', EngineOffTime: '2024-01-01T12:30:00' });
  assert.equal(w.hours, 2.5);
  const o = flightWindow({ EngineOnTime: '2024-01-01T10:00:00' });
  assert.equal(o.done, false);
});

test('utilisation: flights/day, util %, turnaround', () => {
  const now = Date.UTC(2024, 0, 8);
  const ws = [0, 1, 2].map((i) => ({ start: now - (10 - i * 3) * H, end: now - (10 - i * 3 - 2) * H, hours: 2, done: true }));
  const u = utilisation(ws, now, 7);
  assert.equal(u.flights, 3);
  assert.equal(u.blockHours, 6);
  assert.equal(u.flightsPerDay, 0.43);
  assert.equal(u.avgTurnaroundHours, 1);
  assert.equal(u.utilisationPct, Math.round((6 / 168) * 1000) / 10);
});

test('economics model + projection includes fixed weekly cost', () => {
  const m = economicsModel({ HourlyProfit: 1000, CostHourlyFuel: 300, CostHourlyCrew: 100, CostHourlyTotalMaintenance: 100, CostWeeklyOwning: 7000 }, 'own');
  assert.equal(m.revenuePerHour, 1500);
  assert.equal(m.variableCostPerHour, 500);
  const p = project(m, 10, 1);
  assert.deepEqual(p, { hours: 10, revenue: 15000, cost: 12000, profit: 3000 });
  assert.equal(project(m, 0, 1).profit, -7000); // idle aircraft loses its fixed cost
});

test('cash flow matches registrations on word boundaries only', () => {
  const now = Date.now();
  const fleet = [{ Id: 'a', Identifier: 'TC-ABC' }, { Id: 'b', Identifier: 'TC-AB' }];
  const cf = { Entries: [
    { CreationDate: new Date(now - H).toISOString(), Amount: 100, Description: 'Job TC-ABC done' },
    { CreationDate: new Date(now - H).toISOString(), Amount: -40, Description: 'Fuel TC-AB' },
  ] };
  const r = cashFlowByAircraft(cf, fleet, now);
  assert.equal(r.byAircraft.a.net, 100);
  assert.equal(r.byAircraft.b.net, -40);
});

test('end-to-end on mock snapshot', () => {
  const raw = mockSnapshot();
  const d = buildDashboard(raw);
  assert.equal(d.aircraft.length, 10);
  assert.ok(d.aircraft.some((a) => a.idle24h));
  assert.ok(!d.aircraft.find((a) => a.status === 'InFlight').idle24h);
  const r = buildRoutes(raw, d);
  assert.equal(r.count, 6);
  for (const route of r.routes) {
    assert.ok(route.stops.length >= 2, route.name);
    assert.ok(route.stops.every((s) => s.lat != null));
    assert.equal(route.aircraft.length, 1);
  }
});

test('routes: ICAO-only routes resolve via airport cache', () => {
  const raw = { fleet: [], regularRoutes: [{ Id: 'r', Name: 'X', DepartureAirportICAO: 'AAAA', ArrivalAirportICAO: 'BBBB' }],
    airports: { AAAA: { ICAO: 'AAAA', Latitude: 1, Longitude: 2 }, BBBB: { ICAO: 'BBBB', Latitude: 3, Longitude: 4 } } };
  const r = buildRoutes(raw, { aircraft: [] });
  assert.deepEqual(r.routes[0].stops.map((s) => s.icao), ['AAAA', 'BBBB']);
  assert.ok(r.routes[0].distanceNm > 0);
});

test('routes: airports nested in an assigned aircraft are not stops', () => {
  const ap = (ICAO, Latitude, Longitude) => ({ ICAO, Name: ICAO, Latitude, Longitude });
  const ac = { Id: 'x', Identifier: 'TC-X', AircraftTypeId: 't', CurrentAirport: ap('CCCC', 5, 5) };
  const r = buildRoutes({ fleet: [ac], regularRoutes: [{ Id: 'r', DepartureAirport: ap('AAAA', 1, 1), ArrivalAirport: ap('BBBB', 2, 2), Aircraft: ac }] }, { aircraft: [] });
  assert.deepEqual(r.routes[0].stops.map((s) => s.icao), ['AAAA', 'BBBB']);
  assert.equal(r.routes[0].aircraft[0].registration, 'TC-X');
});

test('routes: live regular_routes shape', () => {
  const ap = (ICAO, Latitude, Longitude) => ({ ICAO, Name: ICAO, Latitude, Longitude });
  const ac = { Id: 'a1', Identifier: 'TC-TRS', AircraftTypeId: 't', AircraftType: { DisplayName: 'A320' }, AircraftStatus: 0 };
  const raw = { fleet: [ac], airports: { LTFM: ap('LTFM', 41.27, 28.75), EDDF: ap('EDDF', 50.03, 8.57), LTBA: ap('LTBA', 40.97, 28.81) },
    regularRoutes: [{ Id: 'r1', FlightNumber: 101, Active: true, RouteSetName: 'IST-FRA', DepartureICAO: 'LTFM', ArrivalICAO: 'EDDF', AlternateICAO: 'LTBA',
      Days: [1, 3, 5], DepartureTimeUTC: 9.5, ArrivalTimeUTC: 12, FlyInSim: false, AircraftId: 'a1', AircraftIdentifier: 'TC-TRS', Crew: [{}, {}], Flights: [{}, {}, {}] }] };
  const r = buildRoutes(raw, { aircraft: [] }).routes[0];
  assert.deepEqual(r.stops.map((s) => s.icao), ['LTFM', 'EDDF']);
  assert.equal(r.alternate.icao, 'LTBA');
  assert.equal(r.flightNumber, '101');
  assert.equal(r.aircraft[0].registration, 'TC-TRS');
  assert.equal(r.schedule.dep, '09:30Z');
  assert.equal(r.schedule.days, 'Pzt, Çar, Cum');
  assert.ok(r.distanceNm > 300);
});
