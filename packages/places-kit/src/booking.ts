import { hostOfUrl, siteProfileFor, type SiteProfile } from "@tavi/contracts";

import type { AvailabilityInput, AvailabilityRoute, BookingStatus, BookingStatusInput, Place } from "./contracts.js";
import { nameTokens, registrableDomain } from "./normalize.js";

/**
 * A place's booking routes:
 * from what Tavi knows of it (its website and phone) and what the agent read
 * on its pages this task (their addresses, JSON-LD ReserveAction targets and
 * slots), each with the shipped site profile that governs it. Nothing is
 * fetched: a route says what the person or the browser may do next.
 */

/** Routes one answer holds. */
const ROUTES_MAX = 6;

/** What a profile's mode allows: it holds once the operator turns the profile on under "Sites this app may browse". */
const MODE_REASONS: Readonly<Record<SiteProfile["access"]["mode"], string>> = {
  read: "with its profile on, Tavi may read this platform's pages for slots",
  "assist-only": "with its profile on, Tavi reads only a page you open there, and never books on it",
  stage: "with its profile on, Tavi may fill the booking there and stops before its final step, which you press",
  none: "with its profile on, Tavi gives the link only",
};

/** The shipped profile whose hosts name a URL's host: an exact host first, then a `*.suffix`. */
export function profileForUrl(profiles: readonly SiteProfile[], url: string): SiteProfile | undefined {
  return siteProfileFor(
    profiles.map((profile) => ({ pluginId: "places.open", profile })),
    url,
  )?.profile;
}

/** The routes to book a place, most direct first: profiled platforms with slots, then other platforms, its own site, its phone. */
export function bookingRoutes(
  place: Place,
  pages: AvailabilityInput["pages"],
  profiles: readonly SiteProfile[],
  now: string,
): AvailabilityRoute[] {
  const seen = new Map<string, AvailabilityRoute>();
  const nowMs = Date.parse(now);
  const add = (url: string, slots?: readonly string[], readAt?: string): void => {
    const host = hostOfUrl(url);
    if (host === undefined || !/^https?:/.test(url)) return;
    const profile = profileForUrl(profiles, url);
    const key = profile?.id ?? host;
    const previous = seen.get(key);
    // By time, not by text (offsets differ); a slot already past is dropped.
    const known = [...new Set([...(previous?.slots ?? []), ...(slots ?? [])])]
      .filter((slot) => Date.parse(slot) >= nowMs)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .slice(0, 20);
    // Slots count only where Tavi may read the page: an assist-only or navigate-false platform's are the person's to see.
    const keepSlots = profile !== undefined && (profile.access.mode === "read" || profile.access.mode === "stage") && known.length > 0;
    seen.set(key, {
      platform: profile?.name ?? host,
      ...(profile === undefined ? {} : { profileId: profile.id }),
      mode: profile?.access.mode ?? "deeplink",
      url: previous?.url ?? url,
      ...(keepSlots
        ? { slots: known, ...((readAt ?? previous?.slotsReadAt) === undefined ? {} : { slotsReadAt: readAt ?? previous?.slotsReadAt }) }
        : {}),
      reason:
        profile === undefined
          ? "A booking link Tavi has no profile for: open it, and book there yourself"
          : `${profile.name}: ${MODE_REASONS[profile.access.mode]}${profile.access.navigate ? "" : "; Tavi never opens it"}`,
    });
  };
  for (const page of pages) {
    // A page's slots belong to its own route: a ReserveAction target it names is only a link.
    for (const target of page.reserveUrls ?? []) add(target);
    add(page.url, page.slots, page.readAt);
  }
  if (place.website !== undefined) add(place.website);
  const order = (route: AvailabilityRoute): number =>
    route.slots !== undefined
      ? 0
      : route.mode === "stage"
        ? 1
        : route.mode === "read"
          ? 2
          : route.mode === "deeplink"
            ? 3
            : route.mode === "assist-only"
              ? 4
              : 5;
  const routes = [...seen.values()].sort((a, b) => order(a) - order(b) || a.platform.localeCompare(b.platform));
  // The phone always has its place, after at most five links.
  if (place.phone === undefined) return routes.slice(0, ROUTES_MAX);
  return [
    ...routes.slice(0, ROUTES_MAX - 1),
    { platform: "phone", mode: "phone", url: `tel:${place.phone}`, reason: `Call ${place.phone} to book` },
  ];
}

/** Whole words, read as Unicode: `\b` treats "é" as a boundary, so "confirmé" would never end a word. */
const words = (alternation: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "iu");

/**
 * Words a platform says once a booking went through, in the booking profiles'
 * languages: past forms only, so a "Confirm my booking" button, a code to
 * enter or a reference to look up never counts.
 */
const CONFIRMED = words(
  "(?:booking|reservation|appointment|table|visit) (?:is |has been )?confirmed|you(?:'|’)?re (?:all )?booked|you are (?:all )?booked|your (?:table|booking|appointment|reservation) is (?:booked|confirmed)|thanks? (?:you )?for (?:your )?(?:booking|reservation)|réservation (?:est )?confirmée|rendez-vous (?:est )?confirmé|merci pour votre réservation|(?:termin|buchung|reservierung) (?:ist )?(?:bestätigt|erfolgreich)|vielen dank für ihre (?:buchung|reservierung)|(?:cita|reserva) (?:ha sido )?confirmada|(?:agendamento|consulta|reserva) confirmad[oa]|prenotazione (?:è )?confermata|(?:wizyta|rezerwacja) (?:została )?potwierdzona|reservering (?:is )?bevestigd",
);
/** The Japanese the same, without word boundaries. */
const CONFIRMED_JA = /予約(?:が確定しました|完了|を承りました)/u;
/** A question, or a condition ("confirmed once the restaurant accepts"): no statement that it went through. */
const NOT_YET = words(
  "once|when|after|if|until|unless|pending|wenn|sobald|nachdem|lorsque|dès que|quand|cuando|una vez|siempre que|quando|assim que|non appena|jeśli|gdy|zodra",
);
const confirms = (text: string | undefined): boolean =>
  text !== undefined && !text.includes("?") && !NOT_YET.test(text) && (CONFIRMED.test(text) || CONFIRMED_JA.test(text));

/** Whether evidence names the place: every distinctive word of its name, folded. */
const namesPlace = (texts: readonly (string | undefined)[], place: string): boolean => {
  const wanted = nameTokens(place);
  const have = new Set(texts.flatMap((text) => (text === undefined ? [] : nameTokens(text))));
  return wanted.length > 0 && wanted.every((token) => have.has(token));
};

/** The registrable domains a platform speaks from: its profile's hosts. */
function platformDomains(profile: SiteProfile): Set<string> {
  return new Set(
    profile.hosts.flatMap((host) => {
      const domain = registrableDomain(host.replace(/^\*\./, ""));
      return domain === undefined ? [] : [domain];
    }),
  );
}

/** An email sender's registrable domain, from one plain address or one in angle brackets; anything else is no sender. */
function senderDomain(from: string): string | undefined {
  const address = /^[^<>]*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(from)?.[1] ?? /^\s*([^<>\s@]+@[^<>\s@]+)\s*$/.exec(from)?.[1];
  const host = address?.split("@")[1];
  return host === undefined ? undefined : registrableDomain(host);
}

/** An email older than this is not this booking's. */
const EMAIL_MAX_AGE_MS = 2 * 86_400_000;

/** A time `ms` after an ISO one, written in its own UTC offset. */
function laterInOffset(iso: string, ms: number): string {
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const shift = offset === null ? 0 : (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  const local = new Date(Date.parse(iso) + ms + shift).toISOString().slice(0, 19);
  return offset === null ? `${local}Z` : `${local}${offset[0]}`;
}

/** A hold's length when a booking does not say: two hours. */
const HOLD_MS = 2 * 3_600_000;

/**
 * The receipt check: "booked" only on the platform's own word, a page
 * on its site or an email from its domain saying so; else "staged", with the
 * person handed the confirm step. A calendar hold is proposed only for a
 * staged booking with a slot, titled as a hold, never as a booking.
 */
export function receiptCheck(input: BookingStatusInput, profiles: readonly SiteProfile[], now: string): BookingStatus {
  const profile = profileForUrl(profiles, input.staged.url);
  if (profile?.access.mode !== "stage") {
    return {
      status: "not_staged",
      say: `Tavi did not stage this booking: ${profile === undefined ? "the page is on no booking profile" : `${profile.name} does not let Tavi fill bookings`}. Book it yourself, and nothing is booked until you do`,
    };
  }
  const domains = platformDomains(profile);
  const observedHost = input.observed === undefined ? undefined : hostOfUrl(input.observed.url);
  const onPlatform = observedHost !== undefined && domains.has(registrableDomain(observedHost) ?? "");
  // The page Tavi stopped on is no receipt; one after it, on the platform's site, naming the place and saying it went through, is.
  const pageTexts = input.observed === undefined ? [] : [input.observed.title, ...input.observed.headings];
  if (
    input.observed !== undefined &&
    onPlatform &&
    input.observed.url !== input.staged.url &&
    pageTexts.some(confirms) &&
    namesPlace(pageTexts, input.place)
  ) {
    return {
      status: "booked",
      evidence: `${profile.name}'s page said so: ${(input.observed.headings.find(confirms) ?? input.observed.title ?? "").slice(0, 200)}`,
      say: `Booked: ${profile.name} confirmed it`,
    };
  }
  const recent = input.email?.receivedAt !== undefined && Date.parse(now) - Date.parse(input.email.receivedAt) <= EMAIL_MAX_AGE_MS;
  if (
    input.email !== undefined &&
    recent &&
    domains.has(senderDomain(input.email.from) ?? "") &&
    confirms(input.email.subject) &&
    namesPlace([input.email.subject], input.place)
  ) {
    return {
      status: "booked",
      evidence: `An email from ${profile.name}: ${input.email.subject.slice(0, 200)}`,
      say: `Booked: ${profile.name}'s confirmation email arrived`,
    };
  }
  // A slot already past gets no hold.
  const slot = input.staged.slot !== undefined && Date.parse(input.staged.slot) > Date.parse(now) ? input.staged.slot : undefined;
  const hold =
    slot === undefined
      ? undefined
      : {
          title: `HOLD (not booked): ${input.place.slice(0, 120)}`,
          start: slot,
          end: laterInOffset(slot, HOLD_MS),
          description:
            `Staged on ${profile.name}${input.staged.partySize === undefined ? "" : ` for ${String(input.staged.partySize)}`}; not booked until you press its final step. ${input.staged.url}`.slice(
              0,
              500,
            ),
        };
  return {
    status: "staged",
    say: "Staged: you were handed the confirm step. It is not booked until you press it",
    ...(hold === undefined ? {} : { calendarHold: hold }),
  };
}
