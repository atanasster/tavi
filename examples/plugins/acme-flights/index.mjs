/**
 * A replacement for the built-in flight search (`tavi.flights`,
 * `travel.flights_search`): `acme.flights.search` answers from a fixed fare
 * sheet shipped with the plugin, so it makes no request at all (`sink: "none"`).
 * Its manifest declares `proves: ["travel"]`, so Ideas offers trip ideas while
 * it is registered, as it did for the built-in.
 */

const FARES = [
  { from: "SOF", to: "LHR", airline: "ACME Air", flight: "AC101", depart: "07:10", arrive: "09:05", hours: 3.9, stops: 0, price: 129 },
  { from: "SOF", to: "LHR", airline: "ACME Air", flight: "AC105", depart: "18:40", arrive: "20:35", hours: 3.9, stops: 0, price: 98 },
  { from: "SOF", to: "LHR", airline: "Roadrunner", flight: "RR7", depart: "11:00", arrive: "16:20", hours: 7.3, stops: 1, price: 74 },
  { from: "LHR", to: "SOF", airline: "ACME Air", flight: "AC102", depart: "10:15", arrive: "15:55", hours: 3.7, stops: 0, price: 141 },
];

const IATA = /^[A-Za-z]{3}$/;

export default {
  register({ z, registerTool }) {
    registerTool({
      name: "search",
      inputSchema: z.object({
        from: z.string().regex(IATA),
        to: z.string().regex(IATA),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        maxStops: z.number().int().min(0).max(3).optional(),
        currency: z.literal("EUR").optional(),
      }),
      handler: async ({ from, to, date, maxStops }) => {
        const itineraries = FARES.filter(
          (fare) => fare.from === from.toUpperCase() && fare.to === to.toUpperCase() && (maxStops === undefined || fare.stops <= maxStops),
        )
          .map(({ from: _from, to: _to, ...fare }) => ({ ...fare, date, currency: "EUR" }))
          .sort((left, right) => left.price - right.price);
        return { from: from.toUpperCase(), to: to.toUpperCase(), date, itineraries, source: "ACME fare sheet (fixed)" };
      },
    });
  },
};
