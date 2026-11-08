import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUtc, flightWindow, utilisation, buildDashboard, buildRoutes } from '../scripts/lib/metrics.mjs';
import { buildLedger, classify } from '../scripts/lib/ledger.mjs';
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

test('end-to-end on mock snapshot', () => {
  const raw = mockSnapshot();
  const d = buildDashboard(raw, { ledger: buildLedger(raw) });
  assert.equal(d.aircraft.length, 10);
  assert.ok(d.aircraft.some((a) => a.idle24h));
  assert.ok(!d.aircraft.find((a) => a.status === 'InFlight').idle24h);
  const r = buildRoutes(raw, d);
  assert.equal(r.count, 6);
  assert.ok(d.aircraft.every((a) => a.pnl));
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

test('ledger: classification of live descriptions', () => {
  const A = (name) => ({ name });
  assert.equal(classify({ Amount: 500, Description: 'Payment for Route #412' }, A('Passenger Services')), 'pax');
  assert.equal(classify({ Amount: 500, Description: 'Payment for Cargo (GOODS).' }, A('Cargo Services')), 'cargo');
  assert.equal(classify({ Amount: -5, Description: 'Aircraft CRJ550 (N1F) leased at LBSF (4 weeks advance payments) by X', AircraftId: 'a' }, A('Aircraft Renting')), 'lease');
  assert.equal(classify({ Amount: -5, Description: 'Weekly lease fee for aircraft CRJ550 (LZ-DSK)', AircraftId: 'a' }, A('Aircraft Renting')), 'lease');
  assert.equal(classify({ Amount: 5, Description: 'Refund of the LZ-X lease (ticket #3)' }, A('Money transfer')), 'leaseRefund');
  assert.equal(classify({ Amount: -5, Description: 'JET Fuel bought at Sofia FBO (LBSF), 10 gal @2/gal for LZ-TVJ A320', AircraftId: 'a' }, A('Fuel')), 'fuel');
  assert.equal(classify({ Amount: -5, Description: 'Fuel bought at local dealer : 0LL : 10 gal, Jet : 5 gal at TRISTAN SOFIA LBSF' }, A('Other')), 'excluded');
  assert.equal(classify({ Amount: -5, Description: 'Landing fee at EPWA for LZ-TVJ A320', AircraftId: 'a' }, A('Landing & Parking')), 'landing');
  assert.equal(classify({ Amount: -5, Description: 'Parking fee at EPWA for LZ-TVJ A320 (from 1 to 2)', AircraftId: 'a' }, A('Landing & Parking')), 'parking');
  assert.equal(classify({ Amount: -5, Description: 'Airport slots fee for Flight #412 from LBSF to EPWA, departure: Monday 06:00' }, A('Finance Charges')), 'slot');
  assert.equal(classify({ Amount: -5, Description: 'Weekly Fleet Management costs (14 aircraft)' }, A('Finance Charges')), 'fleetMgmt');
  assert.equal(classify({ Amount: -5, Description: 'Aircraft LZ-TVJ in workshop at TRISTAN SOFIA LBSF', AircraftId: 'a' }, A('Maintenance')), 'maintenance');
  assert.equal(classify({ Amount: -5, Description: 'Hotel for Jane at EPWA' }, A('Other Expenses')), 'crewHotel');
  assert.equal(classify({ Amount: -5, Description: 'Salary from 1 to 2 for Jane' }, A('Staff')), 'staff');
  assert.equal(classify({ Amount: 5, Description: "Owner's equity" }, A('Other')), 'excluded');
  assert.equal(classify({ Amount: -5, Description: 'TRISTAN SOFIA LBSF weekly ownership' }, A('FBO expenses')), 'excluded');
});

test('ledger: per-aircraft totals, slot mapping, overhead allocation, lease accrual', () => {
  const now = Date.UTC(2026, 10, 8);
  const day = (d) => new Date(now - d * 864e5).toISOString();
  const fleet = [
    { Id: 'a', Identifier: 'LZ-AAA', AircraftLease: { WeeklyPayment: 700, StartDate: day(14), EndDate: day(-14) } },
    { Id: 'b', Identifier: 'LZ-BBB', AircraftLease: { WeeklyPayment: 70, StartDate: day(7), EndDate: day(-21) } },
  ];
  const flights = [
    { AircraftId: 'a', EngineOnTime: day(3), EngineOffTime: new Date(now - 3 * 864e5 + 3 * 3600e3).toISOString() },
    { AircraftId: 'b', EngineOnTime: day(2), EngineOffTime: new Date(now - 2 * 864e5 + 1 * 3600e3).toISOString() },
  ];
  const E = [
    { AccountId: 'R', Amount: 1000, Description: 'Payment for Route #1', AircraftId: 'a', CreationDate: day(3) },
    { AccountId: 'L', Amount: -1400, Description: 'Aircraft X (N1) leased at Y (2 weeks advance payments) by Z', AircraftId: 'a', CreationDate: day(14) },
    { AccountId: 'F', Amount: -100, Description: 'Airport slots fee for Flight #1 from A to B, departure: Monday 06:00', CreationDate: day(3) },
    { AccountId: 'S', Amount: -400, Description: 'Salary from x to y for P', CreationDate: day(1) },
    { AccountId: 'F', Amount: -50, Description: 'Weekly Fleet Management costs (2 aircraft)', CreationDate: day(1) },
  ];
  const acc = (Name, id) => ({ Name, Entries: [{ AccountId: id, Account: { Id: id, Name } }] });
  const raw = { fleet, flights, regularRoutes: [{ FlightNumber: 1, AircraftId: 'a' }],
    cashFlow: { Entries: E }, incomeStatementAll: { REVAccounts: [acc('Passenger Services', 'R')], EXPAccounts: [acc('Aircraft Renting', 'L'), acc('Finance Charges', 'F'), acc('Staff', 'S')] } };
  const L = buildLedger(raw, { now });
  const A = L.aircraft.find((x) => x.id === 'a');
  assert.equal(A.revenue, 1000);
  assert.equal(A.cats.slot, -100);           // mapped via route flight number
  assert.equal(A.cats.lease, -1400);
  assert.equal(A.cats.staff, -300);          // 3h of 4h total block hours
  assert.equal(A.leaseAccrued, 1400);        // 2 weeks × 700
  assert.equal(A.flights, 1);
  // b had no ledger lines of its own before overhead → it still receives its staff share
  const B = L.aircraft.find((x) => x.id === 'b');
  assert.equal(B.cats.staff, -100);
});
