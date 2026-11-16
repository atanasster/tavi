import { SiteProfileSchema } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { bookingRoutes, profileForUrl, receiptCheck, type BookingStatusInput, type Place } from "../src/index.js";

const profile = (id: string, hosts: string[], mode: "read" | "assist-only" | "stage" | "none", navigate = true) =>
  SiteProfileSchema.parse({
    abi: "tavi.sites/1",
    id,
    name: id,
    countries: ["*"],
    hosts,
    kind: "booking",
    access: { mode, navigate, reason: "fixture", termsUrl: "https://example.com/terms", reviewedAt: "2026-10-17" },
    ...(mode === "stage" ? { stage: { fillable: ["name"], finalStep: { labels: ["Confirm booking"] } } } : {}),
    notes: "",
  });
const profiles = [
  profile("thefork", ["www.thefork.fr", "www.thefork.com"], "stage"),
  profile("resy", ["resy.com", "*.resy.com"], "assist-only", false),
  profile("tabelog", ["tabelog.com"], "assist-only"),
  profile("nhs-gp", ["www.nhs.uk"], "none"),
];
const NOW = "2026-10-17T12:00:00.000Z";
const place: Place = {
  placeId: "pl_0123456789abcdef",
  name: "Fixture Bistro",
  categories: ["restaurant"],
  location: { lat: 48.87, lon: 2.33 },
  phone: "+33123456789",
  website: "https://fixture-bistro.example/",
  status: "open",
  confidence: 0.8,
  ids: { osm: "node/1" },
  provenance: {},
  flags: [],
  attribution: [],
};

describe("a place's booking routes", () => {
  it("names each route's profile and what it allows, slots only where Tavi may read them, the phone last", () => {
    const routes = bookingRoutes(
      place,
      [
        // The restaurant's own page names TheFork as where to book: a link, its own slots not TheFork's.
        {
          url: "https://fixture-bistro.example/menu",
          reserveUrls: ["https://www.thefork.fr/restaurant/fixture-bistro-r1"],
          slots: ["2026-10-18T22:00:00+02:00"],
        },
        // TheFork's page itself: its slots, in time order across offsets, a past one dropped.
        {
          url: "https://www.thefork.fr/restaurant/fixture-bistro-r1",
          slots: ["2026-10-18T20:00:00+02:00", "2026-10-18T18:30:00+01:00", "2026-10-16T19:00:00+02:00"],
          readAt: "2026-10-17T12:00:00Z",
        },
        { url: "https://widgets.resy.com/fixture", slots: ["2026-10-18T21:00:00+02:00"] },
      ],
      profiles,
      NOW,
    );
    expect(routes).toEqual([
      {
        platform: "thefork",
        profileId: "thefork",
        mode: "stage",
        url: "https://www.thefork.fr/restaurant/fixture-bistro-r1",
        slots: ["2026-10-18T18:30:00+01:00", "2026-10-18T20:00:00+02:00"],
        slotsReadAt: "2026-10-17T12:00:00Z",
        reason: expect.stringMatching(/with its profile on, .*stops before its final step/),
      },
      {
        platform: "fixture-bistro.example",
        mode: "deeplink",
        url: "https://fixture-bistro.example/menu",
        reason: expect.stringMatching(/no profile for/),
      },
      // Resy's slots are not kept: its page is the person's, and Tavi never opens it.
      {
        platform: "resy",
        profileId: "resy",
        mode: "assist-only",
        url: "https://widgets.resy.com/fixture",
        reason: expect.stringMatching(/never opens it/),
      },
      { platform: "phone", mode: "phone", url: "tel:+33123456789", reason: "Call +33123456789 to book" },
    ]);
  });

  it("holds at most six routes, keeping the phone, and finds an exact host before a wildcard", () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({ url: `https://site${String(index)}.example/book` }));
    const routes = bookingRoutes(place, pages, profiles, NOW);
    expect(routes).toHaveLength(6);
    expect(routes.at(-1)?.mode).toBe("phone");
    expect(profileForUrl(profiles, "https://resy.com/cities/ny")?.id).toBe("resy");
    expect(profileForUrl(profiles, "not a url")).toBeUndefined();
    expect(bookingRoutes({ ...place, phone: undefined, website: undefined }, [], profiles, NOW)).toEqual([]);
  });
});

describe("the receipt check and the calendar hold", () => {
  const staged = {
    place: "Fixture Bistro",
    staged: { url: "https://www.thefork.fr/restaurant/fixture-bistro-r1/booking", slot: "2026-10-18T20:00:00+02:00", partySize: 2 },
  };
  const page = (headings: string[], url = "https://www.thefork.com/booking/done") => ({
    ...staged,
    observed: { url, title: "TheFork", headings },
  });
  const email = (from: string, subject: string, receivedAt = "2026-10-17T11:00:00Z") => ({
    ...staged,
    email: { from, subject, receivedAt },
  });

  it("with nothing observed after it, a staged booking is staged, its hold titled as one, in its own offset", () => {
    expect(receiptCheck(staged, profiles, NOW)).toEqual({
      status: "staged",
      say: "Staged: you were handed the confirm step. It is not booked until you press it",
      calendarHold: {
        title: "HOLD (not booked): Fixture Bistro",
        start: "2026-10-18T20:00:00+02:00",
        end: "2026-10-18T22:00:00+02:00",
        description: expect.stringMatching(/^Staged on thefork for 2; not booked until you press its final step/),
      },
    });
    // No slot, or one already past, no hold.
    expect(receiptCheck({ place: "Fixture Bistro", staged: { url: staged.staged.url } }, profiles, NOW)).not.toHaveProperty("calendarHold");
    expect(receiptCheck({ ...staged, staged: { ...staged.staged, slot: "2026-10-16T20:00:00+02:00" } }, profiles, NOW)).not.toHaveProperty(
      "calendarHold",
    );
  });

  it("is booked only on the platform's own word naming the place: a page on its site after the stage, or a recent email from its domain", () => {
    expect(receiptCheck(page(["Your table is booked", "Fixture Bistro, Saturday 20:00"]), profiles, NOW)).toMatchObject({
      status: "booked",
      say: "Booked: thefork confirmed it",
    });
    expect(receiptCheck(page(["Rendez-vous confirmé chez Fixture Bistro"]), profiles, NOW).status).toBe("booked");
    expect(receiptCheck(page(["You’re booked at Fixture Bistro"]), profiles, NOW).status).toBe("booked");
    expect(receiptCheck(email("TheFork <no-reply@thefork.fr>", "Réservation confirmée chez Fixture Bistro"), profiles, NOW)).toMatchObject({
      status: "booked",
    });
    expect(receiptCheck(page(["予約が確定しました Fixture Bistro"]), profiles, NOW).status).toBe("booked");
  });

  it("is not fooled by another site, a sender's display name, an old or other place's email, the stage page, a code to enter or a condition", () => {
    const stays: BookingStatusInput[] = [
      page(["Booking confirmed at Fixture Bistro"], "https://thefork.fr.evil.example/done"),
      page(["Your table is booked"]),
      page(["Reservation confirmed at Other Diner"]),
      page(["Booking confirmed at Fixture Bistro"], staged.staged.url),
      page(["Enter the confirmation code for Fixture Bistro"]),
      page(["Your booking is confirmed once Fixture Bistro accepts"]),
      page(["Table confirmed at Fixture Bistro?"]),
      page(["Confirm my booking at Fixture Bistro"]),
      email("x@thefork.fr@evil.example", "Reservation confirmed at Fixture Bistro"),
      email("TheFork no-reply@thefork.fr <a@evil.example", "Reservation confirmed at Fixture Bistro"),
      email("TheFork <no-reply@thefork.fr>", "Reservation confirmed at Fixture Bistro", "2026-10-01T11:00:00Z"),
      { ...staged, email: { from: "TheFork <no-reply@thefork.fr>", subject: "Reservation confirmed at Fixture Bistro" } },
    ];
    for (const input of stays) expect(receiptCheck(input, profiles, NOW).status, JSON.stringify(input)).toBe("staged");
  });

  it("proposes no hold for a page Tavi may not stage on", () => {
    expect(
      receiptCheck(
        { place: "Fixture Bistro", staged: { url: "https://widgets.resy.com/fixture", slot: "2026-10-18T20:00:00+02:00" } },
        profiles,
        NOW,
      ),
    ).toEqual({ status: "not_staged", say: expect.stringMatching(/resy does not let Tavi fill bookings/) });
    expect(
      receiptCheck(
        { place: "Fixture Bistro", staged: { url: "https://fixture-bistro.example/book", slot: "2026-10-18T20:00:00+02:00" } },
        profiles,
        NOW,
      ).status,
    ).toBe("not_staged");
  });
});
