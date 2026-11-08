// Deterministic fake snapshot shaped like real OnAir responses (for local preview & tests).
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((rnd() * 16) | (c === 'y' ? 8 : 0)).toString(16));
const iso = (t) => new Date(t).toISOString().replace('Z', '');

const AIRPORTS = [
  ['LTFM', 'Istanbul Airport', 'Istanbul', 'TR', 41.2753, 28.7519],
  ['LTAI', 'Antalya', 'Antalya', 'TR', 36.8987, 30.8005],
  ['LTBJ', 'Izmir Adnan Menderes', 'Izmir', 'TR', 38.2924, 27.157],
  ['LTAC', 'Ankara Esenboga', 'Ankara', 'TR', 40.1281, 32.9951],
  ['EDDF', 'Frankfurt', 'Frankfurt', 'DE', 50.0333, 8.5706],
  ['EGLL', 'London Heathrow', 'London', 'GB', 51.4706, -0.4619],
  ['LFPG', 'Paris CDG', 'Paris', 'FR', 49.0097, 2.5479],
  ['OMDB', 'Dubai Intl', 'Dubai', 'AE', 25.2528, 55.3644],
].map(([ICAO, Name, City, CountryCode, Latitude, Longitude]) => ({ Id: uuid(), ICAO, Name, City, CountryCode, Latitude, Longitude, Size: 5 }));

const TYPES = [
  { DisplayName: 'Airbus A320neo', TypeName: 'A20N', seats: 180, rev: 9800, fuel: 2900, crew: 900, maint: 1300, own: 52000 },
  { DisplayName: 'Boeing 737-800', TypeName: 'B738', seats: 189, rev: 9400, fuel: 3100, crew: 900, maint: 1400, own: 47000 },
  { DisplayName: 'ATR 72-600', TypeName: 'AT76', seats: 70, rev: 3900, fuel: 900, crew: 600, maint: 600, own: 16000 },
  { DisplayName: 'Cessna 208 Caravan', TypeName: 'C208', seats: 12, rev: 1300, fuel: 260, crew: 220, maint: 180, own: 3200 },
];

export function mockSnapshot(now = Date.now()) {
  seed = 42;
  const companyId = uuid();
  const fleet = [];
  const flights = [];
  const economics = {};
  const regs = ['TC-OAA', 'TC-OAB', 'TC-OAC', 'TC-OAD', 'TC-OAE', 'TC-OAF', 'TC-OAG', 'TC-OAH', 'TC-OAI', 'TC-OAJ'];
  regs.forEach((reg, i) => {
    const t = TYPES[i % TYPES.length];
    const home = AIRPORTS[i % AIRPORTS.length];
    const id = uuid();
    // activity profile: some busy, some idle for days
    const intensity = [1, 0.9, 0.7, 0.5, 0, 0.8, 0.2, 0, 1, 0.6][i];
    const idleTail = [0, 2, 6, 30, 200, 1, 40, 900, 0, 12][i]; // hours since last flight
    fleet.push({
      Id: id, Identifier: reg, Nickname: null, AircraftTypeId: uuid(), WorldId: uuid(),
      AircraftType: { DisplayName: t.DisplayName, TypeName: t.TypeName, seats: t.seats },
      CurrentAirport: home, CurrentAirportId: home.Id,
      AircraftStatus: i === 0 ? 3 : i === 7 ? 1 : 0, LastStatusChange: iso(now - idleTail * 3600e3),
      Latitude: home.Latitude, Longitude: home.Longitude, Heading: 90,
      airframeHours: 1000 + i * 731, airframeCondition: 0.7 + rnd() * 0.29, HoursBefore100HInspection: 100 * rnd(),
      MustDoMaintenance: i === 7, CurrentCompanyId: companyId, RentCompanyId: i === 9 ? companyId : null,
    });
    economics[id] = {
      AircraftType: fleet.at(-1).AircraftType,
      HourlyProfit: t.rev - t.fuel - t.crew - t.maint, CostHourlyFuel: t.fuel, CostHourlyCrew: t.crew, CostHourlyTotalMaintenance: t.maint,
      CostHourlyRentTotal: t.own / 25, CostWeeklyOwning: t.own, CostWeeklyLease: t.own * 1.2,
      AverageWeeklyFlightHours: 35, ProfitHourlyOwning: t.rev - t.fuel - t.crew - t.maint - t.own / 35,
      ProfitHourlyLease: t.rev - t.fuel - t.crew - t.maint - (t.own * 1.2) / 35,
    };
    let cursor = now - idleTail * 3600e3 - (i === 0 ? -0.5 * 3600e3 : 0);
    let k = 0;
    while (cursor > now - 30 * 864e5 && intensity > 0 && k < 200) {
      const dur = (0.8 + rnd() * 2.5) * 3600e3;
      const start = cursor - dur;
      const dep = AIRPORTS[(i + k + 1) % AIRPORTS.length], arr = AIRPORTS[(i + k) % AIRPORTS.length];
      const ongoing = i === 0 && k === 0;
      flights.push({ Id: uuid(), AircraftId: id, StartTime: iso(start - 900e3), EngineOnTime: iso(start), EngineOffTime: ongoing ? null : iso(cursor),
        AirborneTime: iso(start + 600e3), LandedTime: ongoing ? null : iso(cursor - 300e3), EndTime: ongoing ? null : iso(cursor), DepartureAirport: dep, ArrivalActualAirport: ongoing ? null : arr, ArrivalIntendedAirport: arr, Registered: !ongoing });
      cursor = start - (0.6 + rnd() * 3) * 3600e3 / intensity;
      k++;
    }
  });
  const route = (name, fn, stops, acIdx) => ({
    Id: uuid(), Name: name, FlightNumber: fn, Status: 1, DepartureAirport: stops[0], ArrivalAirport: stops.at(-1),
    Legs: stops.slice(0, -1).map((s, j) => ({ DepartureICAO: s.ICAO, ArrivalICAO: stops[j + 1].ICAO })),
    AircraftId: fleet[acIdx].Id, Aircraft: fleet[acIdx], WeeklyFrequency: 7, TicketPrice: 120,
  });
  const regularRoutes = [
    route('Istanbul – Antalya', 'OA101', [AIRPORTS[0], AIRPORTS[1]], 0),
    route('Istanbul – Frankfurt', 'OA201', [AIRPORTS[0], AIRPORTS[4]], 1),
    route('Izmir – London', 'OA305', [AIRPORTS[2], AIRPORTS[5]], 5),
    route('Ankara – Dubai', 'OA410', [AIRPORTS[3], AIRPORTS[7]], 8),
    route('Antalya – Paris', 'OA512', [AIRPORTS[1], AIRPORTS[6]], 2),
  ];
  const cashFlow = { CompanyCurrentCash: 12_450_000, Entries: flights.filter((_, j) => j % 4 === 0).map((f) => {
    const ac = fleet.find((a) => a.Id === f.AircraftId);
    return { Id: uuid(), CreationDate: f.EndTime || f.StartTime, Amount: Math.round((rnd() - 0.25) * 40000), Description: `Job pay - ${ac.Identifier} ${f.DepartureAirport.ICAO}` };
  }) };
  return { fetchedAt: new Date(now).toISOString(), companyId, company: { Name: 'Demo Airways', AirlineCode: 'OAX', Level: 12, Reputation: 0.87 },
    fleet, flights, economics, cashFlow, regularRoutes, airports: {}, apiCalls: 0 };
}
