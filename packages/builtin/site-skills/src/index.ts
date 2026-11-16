import { SITE_NOTE_ABI, SiteNoteSchema, siteSkillOfNote, type SiteNote, type SiteSkill } from "@tavi/contracts";

/**
 * Site skills: what is known of a site an
 * agent often browses — how its URLs open a search directly, what to wait for,
 * a schema for `browser.extract` to read its results with, and how it treats
 * an automated browser. The first time a session reaches one of a skill's
 * hosts, the observation carries the skill (`site`), so the agent need not
 * learn the site again by trying.
 *
 * Only what holds is written here: a URL form this build has seen work (Google
 * Flights' `?q=`), one the site documents (Google Maps' directions URLs), or one
 * its own search page uses (Booking.com's search parameters — not documented, so
 * the note says to fall back to its form). A note says when a site blocks
 * automated browsers, so the agent goes elsewhere rather than retrying.
 *
 * They are site notes (`tavi.sitenotes/1`), the data a plugin's or the
 * operator's notes are: hosts and path globs, never a regular expression.
 * Shipped and reviewed with the build, they are on while this plugin is.
 */

/** The built-in plugin these skills are: `tavi plugins disable tavi.siteskills` leaves them unregistered. */
export const SITE_SKILLS_PLUGIN_ID = "tavi.siteskills";

const FLIGHT_RESULT = {
  type: "object",
  properties: {
    airlines: { type: "string" },
    departTime: { type: "string" },
    arriveTime: { type: "string" },
    durationHours: { type: "number" },
    stops: { type: "integer" },
    layovers: { type: "string" },
    price: { type: "number" },
    currency: { type: "string" },
  },
  required: ["airlines", "departTime", "arriveTime", "price"],
} as const;

/** The built-in notes as data, each checked as a plugin's would be. */
export const SITE_NOTES: readonly SiteNote[] = [
  {
    abi: SITE_NOTE_ABI,
    id: "google-flights",
    name: "Google Flights",
    hosts: ["google.com"],
    paths: ["/travel/flights/**"],
    notes:
      "Open a search directly with the q URL in plain words (Flights from SOF to TPA on 2026-11-24 returning 2027-02-09, or ending 'one way' instead of the return) rather than filling the form or building a tfs value. " +
      "Results render a few seconds after the page loads: read waits for them. Each result shows departure and arrival times, airlines, total duration, stops and price; on a return search the first list is the departing flights, and choosing one shows the returning ones with the round-trip price. " +
      "An error panel with a Reload button is worth one reload. Where travel.flights_search is offered, prefer it for the search itself and this site to confirm a fare.",
    searchUrl:
      "https://www.google.com/travel/flights?q=Flights%20from%20{from}%20to%20{to}%20on%20{departDate}%20returning%20{returnDate}&curr={currency}&hl=en",
    resultSchema: FLIGHT_RESULT,
  },
  {
    abi: SITE_NOTE_ABI,
    id: "kayak",
    name: "Kayak",
    hosts: ["kayak.com", "kayak.co.uk", "kayak.de", "kayak.fr", "kayak.es", "kayak.it"],
    notes:
      "Kayak often sends automated browsers to its 'What is a bot?' page (help/bots). When it does, do not retry: use travel.flights_search where it is offered, or Google Flights. Its search path is /flights/SOF-TPA/2026-11-24/2027-02-09?sort=price_a with airport codes; without the last date for one way.",
    searchUrl: "https://www.kayak.com/flights/{from}-{to}/{departDate}/{returnDate}?sort=price_a",
    resultSchema: FLIGHT_RESULT,
  },
  {
    abi: SITE_NOTE_ABI,
    id: "skyscanner",
    name: "Skyscanner",
    hosts: ["skyscanner.net", "skyscanner.com", "skyscanner.de", "skyscanner.co.uk"],
    notes:
      "Skyscanner puts a press-and-hold human check (PerimeterX) in front of automated browsers. Never try to pass it: use travel.flights_search where it is offered, or another site.",
    handoffNote: "If the person wants this site, hand them the page with browser.request_handoff.",
    resultSchema: FLIGHT_RESULT,
  },
  {
    abi: SITE_NOTE_ABI,
    id: "booking",
    name: "Booking.com",
    hosts: ["booking.com"],
    notes:
      "Open a search directly with the search results URL (ss = the place, checkin and checkout as YYYY-MM-DD, group_adults, no_rooms) rather than the date picker; if the results show other dates, the site ignored them: use its form. " +
      "A sign-in or genius pop-up may cover the results: close it. The page reports how many properties it found; each card shows the name, review score, location, and the price for the whole stay, not per night.",
    searchUrl:
      "https://www.booking.com/searchresults.html?ss={place}&checkin={checkin}&checkout={checkout}&group_adults={adults}&no_rooms=1",
    resultSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: "number" },
        area: { type: "string" },
        priceTotal: { type: "number" },
        currency: { type: "string" },
        nights: { type: "integer" },
        link: { type: "string" },
      },
      required: ["name", "priceTotal"],
    },
  },
  {
    abi: SITE_NOTE_ABI,
    id: "google-maps",
    name: "Google Maps",
    hosts: ["google.com"],
    paths: ["/maps/**"],
    notes:
      "Open directions directly with the documented directions URL (api=1, origin, destination, travelmode: driving, walking, bicycling or transit) rather than typing into the search box. " +
      "The route options list each route's time and distance; the map itself is a canvas, so read the list, not the map.",
    searchUrl: "https://www.google.com/maps/dir/?api=1&origin={origin}&destination={destination}&travelmode={mode}",
    resultSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        durationMinutes: { type: "number" },
        distanceKm: { type: "number" },
        via: { type: "string" },
      },
      required: ["durationMinutes"],
    },
  },
].map((note) => SiteNoteSchema.parse(note));

export const SITE_SKILLS: readonly SiteSkill[] = SITE_NOTES.map((note) => siteSkillOfNote(note));
