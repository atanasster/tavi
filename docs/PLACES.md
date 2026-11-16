# Places

`places.open` (in `packages/external/places-open`) is an external plugin this
repository ships the source of. It finds shops, services, restaurants and
clinics near an area, resolves what several sources say into one place, and
tells you where each fact came from and how fresh it is. It never books for
you.

## Install

```bash
pnpm --filter @tavi/plugin-places-open build
tavi plugins install packages/external/places-open/dist-plugin
tavi plugins approve places.open 0.1.0
tavi plugins enable places.open
```

It runs as a confined worker ([SANDBOX.md](SANDBOX.md)). Its network is only the sources below:
OpenStreetMap's services (Overpass, Photon, Nominatim), Overture Maps'
catalogue and bucket, OpenRouteService, the fuel, charging and licence
registers, and the civic open-data portals, 24 hosts in all, listed in its
manifest. It shows in Settings → **Connected apps** as **Places**, a Shared app:
place data is public, so other people's chats in your household may use it.

## Sources

| Source | What it gives | Terms Tavi keeps to |
| --- | --- | --- |
| Overpass (OpenStreetMap) | Places by their tags: hours, phone, website, wheelchair, diet | About 100 queries a day; no parallel requests; the other known instance is asked once when the first answers overloaded (a 429 or a 5xx) |
| Photon (OpenStreetMap) | Areas by name; places by name inside a box, and a kind of place by its English name when Overpass did not answer | "Be fair"; a place search always sends a box, since its location bias is weak, and a kind of place's OSM tags, so a shared word never returns another trade |
| Nominatim (OpenStreetMap) | Postcodes and districts | At most one request a second; only for what you typed, never in a run nobody attends; no autocomplete |
| Fuel: Tankerkönig (DE), prix-carburants (FR), Geoportal (ES), MIMIT (IT), E-Control (AT), FuelCheck (NSW and Tasmania), FuelWatch (WA), EIA (US), the European Commission's Weekly Oil Bulletin (EU) | Station prices for `fuel_prices`; the US only weekly state or national averages; the rest of the EU each member state's weekly national average | Tankerkönig only with your key and only when you ask; FuelCheck with your key and secret, 2,500 calls a month; EIA with your key; the Bulletin under CC BY 4.0, 40 requests a day (two a read); the rest keyless; nothing kept but the Bulletin's latest week (30 days at most) |
| EV: AFDC (US, Canada), Open Charge Map (everywhere), Bundesnetzagentur's register (DE) | Charging sites for `ev_chargers` | AFDC and Open Charge Map with your keys; the register is read once a month into the cache; each Open Charge Map record keeps its data provider's licence |
| Neighbourhood: NYC 311 and DOB NOW permits (Socrata), Open311 cities (San Francisco, Boston), data.police.uk | Complaints, permits and crime for `area_report` | Keyless (an optional Socrata app token raises NYC's limits); data.police.uk is OGL v3.0, a month at a time, its locations anonymised; nothing kept |
| Texas TDLR (data.texas.gov) | Electricians' and A/C contractors' licences for `verify_license` | Socrata's open API; an optional app token raises its limits; nothing kept |
| OpenRouteService | Road routes for `route_stops`, with your free key | 40 a minute and 2,000 a day on HeiGIT's free plan; nothing kept |
| Overture Maps | An area pack you choose: about 20,000 places for a city district, each with its source and status | Built once, when you first search there; each record under its own source's licence |

OpenStreetMap's data is ODbL. Your store is yours alone. It is never exported
or shared, since that would be public use of a derived database.

Not used, on their terms:
- OSRM's and FOSSGIS's public demo routers: their policies forbid an app's
  traffic, and Tavi refuses them as `routingUrl`;
- Yelp: its API terms ban putting its content into an AI model;
- HERE: its terms ban use with AI;
- the raw Google Places API: its terms ban creating content from it.

Google Maps comes in only through its own Grounding Lite MCP server, with your
key ([MCP.md](MCP.md#google-maps)).

## Settings

```bash
tavi plugins config places.open --set overtureArea=30.27,-97.74,10   # an area pack for central Austin, 10 km either way (at most 25)
tavi plugins config places.open --set contact=you@example.com       # sent in the User-Agent, as OSM's services ask
tavi plugins config places.open --set sources=overpass,photon,nominatim,ors,tdlr   # leave one out to turn it off
tavi plugins config places.open --set overpassInstance=https://overpass.private.coffee/api/interpreter   # the Overpass asked first
tavi plugins config places.open --set orsKey=<your key>              # road routes for route_stops (openrouteservice.org)
tavi plugins config places.open --set routingUrl=https://osrm.example.org   # your own OSRM-API router, asked first
tavi plugins config places.open --set afdcKey=<key>                # US and Canadian chargers (api.data.gov)
tavi plugins config places.open --set ocmKey=<key>                 # Open Charge Map, worldwide
tavi plugins config places.open --set tankerkoenigKey=<key>        # German fuel prices
tavi plugins config places.open --set eiaKey=<key>                 # US weekly averages
tavi plugins config places.open --set nswKey=<key> --set nswSecret=<secret>   # NSW and Tasmania
tavi plugins config places.open --set socrataAppToken=<token>      # optional: higher limits for TDLR lookups
tavi plugins config places.open --set forget=true                   # empty the store and cache once, at its next start
```

## Tools

- `places.open.search`: what you want and an area (a city, postcode or
  district, or a point and radius), with filters for a time it must be open,
  diet, wheelchair access, and no chains. It is read-only with sink `search`.
  The area leaves rounded to about a kilometre, and a search never sends your
  home address: for "near me" the agent reads your `me.home_area` memory, a
  district or postcode. A typed area's geocode is cached 30 days under a hash
  of the text, its point rounded to about 100 metres. A diet or wheelchair filter asks only OpenStreetMap, whose tags
  can answer it.
  - The agent writes the query in English whatever language you wrote in:
    kinds of place are matched in English ("pharmacy", not "аптека"), and a
    business's own name is sent as written, so "Двойка" matches OSM's
    "Двойка". Names compare across scripts: "Аптека Ерудита ЕООД" and
    "Apteka Erudita" are one place, Bulgaria's legal forms (ООД, ЕООД, ЕАД)
    left out.
  - A time to be open is read as the place's local time in a country with one
    time zone (16:00Z is 19:00 in Sofia in October); elsewhere the agent gives
    the place's own offset. A phone written without its country code is read
    in the search's country.
- `places.open.details`: one place again, with what OpenStreetMap says now.
- `places.open.reconcile`: compares what the agent read on a business's own
  page (its JSON-LD from `browser.structured`) with what Tavi found. Nothing
  from the page is kept. The browser worker may call it.
- `places.open.booking_status`: the receipt check, called before Tavi says a
  booking is made. A booking is `booked` only on the platform's own word:
  - a page observed on its own site after you pressed the final step (not
    the page Tavi stopped on), whose title or headings name the place and say
    the booking went through ("Your table is booked", "Réservation
    confirmée", "Termin bestätigt" …). A code to enter, a question, or "once
    the restaurant accepts" is not a receipt;
  - or an email from its own domain, received in the last two days, whose
    subject names the place and says so.

  Anything else is `staged`: Tavi says you were handed the confirm step.
  For a staged booking with a time, it gives a calendar hold to propose
  through the calendar's `create_event`, which asks first. The hold is titled
  "HOLD (not booked): …" and lasts two hours; a slot already past gets none.
  The agent is told never to propose a hold before staging, nor to call one a
  booking: the tool proposes one only for a booking page on a stage profile. A page on a platform Tavi may not stage on is
  `not_staged`, with no hold.
- `places.open.compare`: places side by side; sends nothing.
- `places.open.watch`: a fuel-price watch. You approve every call, and a
  run nobody attends cannot change one. Its card shows the operation, the
  watch id, the area, the country, the fuel, the threshold, the currency and
  the cadence (hourly, every
  6 hours by default, or daily).
  - A typed area is geocoded when you add the watch. After that the plugin
    checks the country's fuel sources on the cadence, with no model.
  - Each station whose fresh price is at or under your threshold becomes a
    heartbeat item: "DIESEL at …: 1.620 EUR, at or under your 1.65". Each
    is told once.
  - Sources only a person may ask cannot be watched, so Germany's
    Tankerkönig watch is refused, and so is a watch where the only source is
    an average: the US, and the EU outside Germany, France, Spain, Italy and
    Austria. A currency the country's sources never price in is
    refused. At most 20 watches are kept.
  - `update` changes the fuel, threshold, currency or cadence, and clears
    the hits found under the old terms. The area is set when the watch is
    added: add a new watch for a new area. A station that rose above the
    price and comes back under it is news again. Hits are kept 7 days for
    `digest`; a sweep every 15 minutes removes older hits and places past
    their sources' terms.
  - `forget` empties the watches with the rest of the store, as each one
    holds your area.
- `places.open.digest`: the watches, or one watch's stations under its
  price since a time (the last day by default). It reads only.
- `places.open.availability`: a stored place's booking routes. The agent
  gives the pages it read about the place this task: their addresses, the
  `ReserveAction` targets `browser.structured` found, and any slots shown.
  Each route names its platform and what its site profile allows there,
  once you turn that profile on:
  - `stage`, `read`, `assist-only` or `none`, from the profile;
  - `deeplink`, a link with no profile;
  - `phone`.

  Slots are kept only from a `read` or `stage` platform's own page, never
  carried over from a page that links to it; past slots are dropped. It
  fetches and keeps nothing, and the browser worker may call it. A booking
  always ends at your own confirm step.
- `places.open.route_stops`: fuel or charging stops along a trip, from `from`
  to `to` through up to five `via` points (each a city, postcode or district).
  Its options are:
  - a fuel, or EV connectors;
  - how far off the route a stop may be (2 miles by default);
  - the vehicle's range, which spaces the stops within it;
  - how many stops.

  It is read-only with sink `search`. Routing tries these in order:
  - your own router (`routingUrl`), which must speak OSRM's HTTP API and
    whose host must be added to the plugin's network domains;
  - OpenRouteService with your `orsKey`, giving `routeGeometry: road_network`;
  - with neither, or when the router fails, the straight line between the
    points. That gives `routeGeometry: corridor_estimate`, its distance 1.25×
    the straight one. The answer then says the stops may be off the road you
    take.

  The names you give go to OpenStreetMap's geocoders, as for a search. The
  points they name go, rounded to about a kilometre, to your router or
  OpenRouteService, and the route's line, rounded the same way, to
  OpenStreetMap. Stations come from OpenStreetMap, along that line. Each
  stop has how far along the route it is and how far off it. Where the start's
  country has no station prices, fuel stops carry its weekly average
  (`priceKind: regional_average`), and the answer says it is not their own
  price: in the US EIA's for the start's state (with your `eiaKey`), in the
  rest of the EU the Weekly Oil Bulletin's national one. Where station prices
  exist, a stop has no price (`priceKind: none`): ask `fuel_prices` near it.
- `places.open.ev_chargers`: charging sites near an area, with optional
  connectors and a least power. A site several sources list is one charger
  with all their connectors, its most power and its points. It is read-only
  with sink `search`.
  - Germany: the Bundesnetzagentur's register, a 55 MB monthly file. The
    first German lookup starts reading it, line by line, into a pack in the
    cache, and says so; the next lookup reads the pack. A month-old pack is
    read while a newer one is built.
  - The US and Canada: AFDC, with your api.data.gov key.
  - Everywhere: Open Charge Map, with your key.

  No source reports whether a charger is free now, and the answer says so.
- `places.open.area_report`: what open data says near a point, such as noise
  complaints and building permits near an address. It takes topics
  (complaints, permits, crime), a window of up to 90 days (30 by default) and
  a radius of up to 2 km (500 m by default). It is read-only with sink
  `search`. Sources by place:
  - New York City: 311 requests and DOB NOW permits;
  - Open311 cities: San Francisco and Boston, a list kept in
    `packages/external/places-open/data/open311.json`. Their servers answer
    the city's latest requests whatever point is sent, so no point is sent,
    and the section is marked as a sample of those within the radius;
  - England, Wales and Northern Ireland: data.police.uk's latest month of
    crime, its locations moved to anonymised points. With nothing in a whole
    mile (Scotland is not published), the section says there is no data.

  Each section counts reports by kind and lists the latest few by kind,
  status, date and distance, never a report's own words, address or photo.
  New York's point leaves rounded to 3 decimals (about 110 m), finer than a
  search's kilometre, since the radius is 500 m. data.police.uk's point is
  rounded to about a kilometre when the radius is 0.8 km or less, as its
  fixed mile still covers it. A section that hit a source's 1,000-row cap
  says there are at least that many. Complaints are what people reported,
  not findings, and the answer says so.
- `places.open.fuel_prices`: prices for a fuel (diesel, E5, E10, super 98,
  LPG, E85) near an area, from the country's official source. Results come
  cheapest first. Each price carries `reportedAt` and a `basis` saying what
  that time is:
  - `read`: a live service answered now (Tankerkönig, E-Control);
  - `changed`: when the station last changed the price (France, NSW);
  - `published`: when the feed was built (Spain, EIA, the Oil Bulletin);
  - `daily`: a once-a-day snapshot (Italy, WA), whose date is shown.

  A price older than `maxAgeHours` (12 by default) is left out and counted,
  unless its basis is `daily`. A typed area goes to OpenStreetMap's geocoder
  first. Each country's sources are asked only where they cover the point.
  The tool is read-only with sink `search`.
  - Germany (Tankerkönig): with your key, and only for lookups you ask for.
  - France and Spain: keyless and live. Spain's service is asked for the
    nearest two provinces' lists, so no point leaves.
  - Italy: yesterday's 08:00 prices, from MIMIT's daily files.
  - Austria: only the 5 cheapest of the 10 nearest stations carry a price.
  - New South Wales and Tasmania: with your FuelCheck key and secret; a
    token serves many lookups until it expires.
  - Western Australia: each day's price holds from 06:00.
  - The US has no official station prices. You get EIA's weekly average for
    the state your area names (nine states have one), else the nation's,
    labelled as an average.
  - The rest of the EU (Bulgaria, Poland, Romania, the Netherlands …) has
    no station source in Tavi. You get the European Commission's Weekly Oil
    Bulletin: the member state's average price with taxes for Euro-super 95
    (asked as E5 or E10), diesel or LPG, for the week it names, labelled as
    an average. For Czechia, Denmark, Hungary, Poland, Romania and Sweden the
    Commission converted it to euros, and the answer says the pumps price in
    the country's own currency. It is also given in Germany, France, Spain,
    Italy or Austria when no station's price could be read. Super 98 and E85
    have no Bulletin average. The page is read for the file's link, then the
    file, about 120 KB.
    - The week read is kept in the worker's cache (`cache/`, left out of
      backups) for 30 days at most: later asks, any fuel and member state,
      send nothing.
    - Eight days after its Monday the next week is due. The page is then
      asked again, at most every 6 hours, until it links a newer file. Once
      someone has asked, the plugin's 15-minute sweep does this itself, as a
      run nobody attends, so a new week is read before anyone asks.
    - When the Commission cannot be reached, the kept week answers. A week
      older than 15 days is stale: the reply's average carries `staleDays`,
      and the note says the Commission may have stopped publishing it.
  - The UK's Fuel Finder is not supported: its API documentation sits behind
    a GOV.UK One Login.
- `places.open.verify_license`: whether a trade is licensed in a jurisdiction
  (`US-TX`, `GB-ENG` …) and, given a name or licence number, the licensee's
  record where the register has an API. It is read-only with sink `search`.
  The answer comes from a matrix in `packages/external/places-open/data/licensing/`,
  one row per jurisdiction and profession, each with its source and review
  date.

  The answer's `regime` is one of:
  - `not_licensed`, an answer of its own, made with no request. A Texas
    mechanic, a tailor, a German bespoke tailor (Anlage B) or an English
    electrician is not licensed, and Tavi says so rather than "no licence
    found". A row's note says what is required instead, such as a
    certificate for notifiable electrical work.
  - `licensed` or `registered_business`: the trade, or the business, needs
    the regulator's licence or registration.
  - `unknown`: the row cannot say, such as a Californian handyman, whose
    job's value decides. With no row at all, `matrixRow` is `none`.

  Its `access` says how a licensee is checked:
  - `api` (Texas TDLR: electricians, A/C contractors) looks the subject up.
    A licence found shows its type, number and city, and its expiry when
    the register gives one, never the register's phones or addresses. None
    found is not proof of no licence.
  - `web` gives the regulator's own search to use in the browser. This
    covers California's CSLB and BAR (through DCA's search), Florida's DBPR,
    Gas Safe, England's competent person register and councils, and
    Germany's Handwerkskammern.

  Rows cover Texas, California, Florida, New York, Michigan, Great Britain
  (its GB-wide rows answer for Scotland and Northern Ireland too; England's
  and Wales's own rows come first) and Germany. France's file is empty until
  its rules are sourced.
- `places.open.sources`: each source's terms, budget, health and the last 20
  requests, each area as rounded as it was sent.

Every place carries:
- each field's sources and when they last checked it;
- a confidence;
- flags:

| Flag | Means |
| --- | --- |
| `single_source` | Only one source lists it |
| `phone_conflict` | Sources give different numbers |
| `hours_conflict` | Sources' hours disagree |
| `stale_hours` | No check in two years |
| `reported_closed` | A source says it closed |
| `residential_address` | A PO box for a storefront |
| `shared_phone` | One number behind several listings in a lead-generation trade (locksmiths, garage doors, towing) |

"Open now" is said only when two sources agree on the hours and one checked
them within 180 days. Names, descriptions and pages are third-party data, so
they never count as instructions.

## Sites this app may browse

When the open sources run out, the agent may use the browser on a platform's
own pages, under a site profile in `packages/external/places-open/sites/`. Each
profile is reviewed and dated, and is off until you turn it on in Connected
apps → Places → "Sites this app may browse". The browser's rules hold on
every profiled host: your own session, page budgets, robots.txt, and a
refusal before the final step of any form. What each mode allows:

| Mode | Sites | What Tavi does |
| --- | --- | --- |
| assist-only, navigate false | Doctolib (FR, DE, IT), Resy, Treatwell, GasBuddy | Never opens them: it reads only a page you brought up, for the chat. Their terms ban agents or automated extraction |
| assist-only | Tabelog, Naver Place, Yandex Maps | Opens and reads for the chat; never extracts to findings or keeps anything |
| read | Kakao Map place pages, 2GIS | Reads place pages for hours and reviews, a few pages a task |
| stage | Doctoralia (ES, MX, BR), ZnanyLekarz, jameda, TheFork, Planity, OpenTable, Zocdoc, Fresha | Fills a booking, then stops before its final control ("Complete reservation", "Termin bestätigen" …), which you press. Payment pages are refused everywhere, and a clinic's medical intake (history, symptoms, health declaration, consent to treatment) is a protected field only you fill |
| none | NHS GP services | A link only: the NHS App is the way to book. Turned on, it stops Tavi on every www.nhs.uk page, so leave it off to let Tavi read NHS pages |

`apps/cli/test/routines/places-site.real.test.ts` checks these rules with the
shipped profiles in a real Chromium, against a local places site. None is read by a sweep or a
heartbeat. A stage profile lists the fields a booking there needs (name,
email, phone, party size, date, time, notes, a clinic's visit reason); the
browser's guards enforce its final step and its daily count, not that list. Where a platform's terms page
refused scripts (Doctoralia, ZnanyLekarz, jameda, TheFork, Zocdoc), the
profile says so, and its mode rests on an earlier reading of the terms rather
than a fresh one, and no profile's final-step labels were checked on the live sites
here. The Yandex profile covers the whole of yandex.ru, .com, .com.tr, .by
and .kz, not only their maps. The never-navigate profiles cover each
platform's subdomains too (Resy's booking widgets, for instance).

## places.care: health providers

`places.care` (in `packages/external/places-care`) is a second plugin, kept
apart because it is about health. It shows in Connected apps as **Places:
health**, a Personal app: the household rule offers it only in its
operator's own one-to-one chats, and its results are personal data.

```bash
pnpm --filter @tavi/plugin-places-care build
tavi plugins install packages/external/places-care/dist-plugin
```

- `places.care.providers`: US providers of a specialty near a ZIP code (or
  a city and state), from the NPPES NPI Registry. It filters on where they
  practise, never a mailing address, and adds Medicare's specialty,
  telehealth and assignment from CMS's Doctors and Clinicians file. It is
  read-only with sink `search`.
- `places.care.registry_check`: one provider's NPI record, by number or name:
  active or not, taxonomies with the state licence numbers they submitted,
  and when it was last updated. The state board's own search is the record.
- `places.care.in_network`: whether providers are listed in a plan's network
  in the payer's public Plan-Net directory (CMS-9115-F requires it to answer
  without authentication). It is `external` with sink `network` and
  `minRisk: high`, so Tavi asks every call. Its card shows the payer, the
  plan and the NPIs.
  - Only NPIs and the directory's own ids are sent, with no contact in the
    User-Agent. The plan's name stays here and is matched against each
    provider's networks by its distinctive words, a compound written as one
    word or two ("GOLDPLUS", "Gold Plus") either way. A dual-eligible (DSNP),
    dental or vision network matches only a plan that names it. A network
    whose name names a US state ("Florida", "FL") matches only when that is
    the plan's state or `state`, the two-letter state of the ZIP code
    searched.
  - Each provider comes back `listed` (a network's name carries the plan's
    own words), `possible` (a weaker match by name: on plan-type words alone,
    for a plan named only by its type such as "Humana Medicare PPO", or a
    network naming a state when no `state` was given; the row's note says
    so), `other_networks`, `not_listed`, or `unknown` when the directory did
    not answer or named no network. Both `listed` and `possible` are matches
    by name, never the directory confirming the plan. Up to four pages of a
    provider's roles are read, from the payer's own host only.
  - The plan must be the name on the card; anything shaped like a member id
    is refused.
  - Payers are kept in `packages/external/places-care/data/payers.json`. Humana
    answers by NPI. Cigna's, Aetna's, Anthem's, Kaiser's and Blue Cross Blue
    Shield's published directories do not, so the answer gives their own
    directory page to check in the browser.
  - NHS Service Search and France's Annuaire Santé are not wired: both need a
    key, and their API documentation could not be read when this was built.

Neither registry says which insurance a provider takes, and the answers say
so. `care.db` keeps only budgets, source health and the request log, by host.

## What it keeps

`places.db` lives in the worker's home and is backed up. It keeps a place only
as long as every source in it allows. OpenStreetMap's and Overture's data is
kept until you forget it. A Google place id would be the only thing kept from
Google, and nothing from a page the agent read is kept. The Overture area pack
and Germany's charging register pack are in the worker's `home/cache/`, left
out of backups, and are built again if lost. Routes and licence lookups are never
kept, nor are fuel prices, except a watch's hits (7 days) and the Oil
Bulletin's latest week of national averages (in `home/cache/`, 30 days at most). A place's hours are
kept, never whether it was open when a search asked. A source whose daily
budget is spent says so, with `exhausted` and the time it resets (`nextAt`).
A source that fails five times in a row (a timeout counts) is paused for a
day, except the public OpenStreetMap services (Overpass, Photon, Nominatim),
which are busy at times and are paused for an hour (each source's
`failurePauseHours`); one that answers in a shape Tavi can't read is paused for
a day (domain-kit's source health). While a source is paused, its report reads `skipped: paused until …` with `pausedUntil` and a
`note` naming the source, the time and that results may be thin, for the
answer to repeat.

## Architecture

`places.open` and `places.care` share domain primitives (`@tavi/domain-kit`) and the places resolution/source engine (`@tavi/places-kit`):

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Domain Kit (`@tavi/domain-kit`)** | `packages/domain-kit/src/{worker,sqlite,budget,source-health,minhash,terms-test,xml,schema}.ts` | Shared confined-worker runtime helpers, SQLite store wrapper, per-source request budgets, circuit-breaker health tracking, and terms-review assertions. |
| **Places Kit (`@tavi/places-kit`)** | `packages/places-kit/src/{contracts,resolve,normalize,hours,geo,route,booking,licensing,relayed,xlsx,worker}.ts`, `packages/places-kit/src/sources/*`, `packages/places-kit/src/store/*` | Multi-source entity resolution (Overpass, Photon, Nominatim, Overture area packs), cross-script name matching, opening-hours parser, corridor routing (`route_stops`), fuel/EV/311/crime adapters, booking-receipt verification (`booking_status`), and `places.db` store. |
| **Places Open Plugin (`@tavi/plugin-places-open`)** | `packages/external/places-open/src/{index,engine,sites,licensing,open311}.ts`, `packages/external/places-open/sites/*`, `packages/external/places-open/data/*` | Confined external plugin providing `places.open.*` tools, fuel-watch heartbeat signals, trade-licensing matrices, and booking/directory site profiles. |
| **Places Care Plugin (`@tavi/plugin-places-care`)** | `packages/external/places-care/src/{index,engine,payers}.ts`, `packages/external/places-care/data/payers.json` | Separate Personal-category confined plugin providing `places.care.{providers,registry_check,in_network}` over NPPES, CMS Doctors & Clinicians, and CMS-9115-F Plan-Net directories. |

See [PLUGINS.md#architecture](PLUGINS.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for how confined external plugins run.
