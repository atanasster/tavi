# Personal-agent use cases: scorecard

The use cases the idea catalogue is built from (`src/catalogue.ts`), each scored
against the build of 19 Oct 2026:

- **A**: runnable now, end to end. A use case that rests on a connector counts
  as A only once a real-account or live run of it is recorded.
- **B**: runnable, with the named gap.
- **C**: not runnable yet.
- **X**: to be redesigned before building (legal, terms-of-service or safety
  reasons); the row says how.

`test/catalogue.test.ts` holds the catalogue to this table: one template for
every use case scored A or B, and none for X. A range (`9.1–9.5`) scores every
case in it.

| Use case | Score | Blocking gap |
| --- | --- | --- |
| 1.1 Landed-cost arbitrage | B | Marketplace ToS ban automated access; Temu and Alibaba bot defences. Run in the person's session with takeover; no stealth. |
| 1.2 Counterfeit check | B | No reverse image search tool |
| 2.1 Specialist + licensing | A | `places.open` search (live run near 78701) and `verify_license` (Texas: not licensed); ratings, ASE and BBB via the web |
| 2.2 In-network dentists | B | `places.care.in_network` over Plan-Net (live run, Humana); not every payer searches by NPI; booking intake staged only on a local site, Zocdoc run in the person's session not recorded; voice dropped |
| 3.1 ATS headhunter | A | `jobs.finder` search, match and watches (live runs); pay stated only in text is not checked against the floor |
| 3.2 ATS form pre-fill | B | `fill_plan` and the browser's final-step refusal shown on a fixture ATS only; a real Greenhouse staging run not recorded; login via takeover |
| 4.1 Trend velocity | A | `trends.radar` velocity over free sources (live sweep, recorded-spike eval); X removed as paid, Reddit's keyed adapter not run live |
| 4.2 Comment clustering | A | `trends.radar.cluster` on the fixture; a real comment page not recorded |
| 5.1 Prospect discovery | B | Privacy law (GDPR Art. 14) |
| 5.2 SMTP verification | X | Redesigned to MX/SPF checks only |
| 6.1 Fare watcher | A | `travel.flights_search` (Kiwi MCP) instead of scraping Google Flights |
| 6.2 Hotels | B | OTA terms ban automated rate scraping (deadline event via the Calendar preset, or a Tavi reminder) |
| 6.3 Car vs rail | B | Rail fares via browser |
| 6.4 Fuel corridor | B | `places.open` fuel prices and route stops; the US has no station-price feed (EIA state average only), no router without a key; not run on US-287 |
| 6.5 Paris itinerary | B | No crowd data API; diet tags and the TheFork stage profile not run live (Overpass down, no session) |
| 6.6 Visa & packing | A | — |
| 7.1 Sketch critique | A | Image via `artifacts.view_image` |
| 7.2 Garden planner | A | IoT optional |
| 7.3 Fridge recipe | A | — |
| 7.4 Mix diagnosis | A | — |
| 7.5 EXIF organiser | A | Folder attached under `--fs-root` |
| 7.6 Cut-list | A | Oracle fixed |
| 7.7 Canon auditor | A | `fs.*` over the manuscript in the working folder |
| 8.1 Morning brief | B | Calendar preset and Gmail mailbox tools not yet run against a real Google account (A once both are) |
| 8.2 Timezone slots | B | Calendar preset not yet run against a real Google account (A once it is); the correct answer is infeasibility |
| 8.3 Inbox triage | B | No label or modify tool (search, read and drafts exist); mailbox tools not yet run against a real account |
| 8.4 Downloads cleanup | A | Folders attached under `--fs-root` |
| 8.5 Cancellation staging | B | Login via takeover |
| 8.6 Appliance manuals | A | Tavi reminder replaces the calendar task |
| 9.1–9.5 Learning (5) | A | — |
| 10.1 Squat form | B | `video.pose` built, but no pose model shipped or run; template unvalidated; recorded squats not run |
| 10.2 Meal plan | A | — |
| 10.3 Sleep analysis | A | Claims corrected |
| 10.4 Thought record | A | — |
| 10.5 Supplement schedule | A | Repeat reminders |
| 11.1 Rental watchdog | B | No sub-hour triggers; heartbeat page-watch checks at most once per hour (60 min) on allowed hosts |
| 11.2 Off-peak load shift | A | Home Assistant MCP preset; real run recorded |
| 11.3 Waste classifier | A | — |
| 11.4 Neighbourhood data | A | `places.open.area_report` (live NYC run), or open-data APIs via `http.request` |
| 12.1 School packet | B | No personal-record vault; the 10-page end-to-end run is not recorded |
| 12.2 Camp registration | X | Queue bypass removed; minute precision only |
| 12.3 Carpool | B | A Discord room with recent context and a poll; no real Discord application run, calendars need the Calendar preset's run; WhatsApp groups still unreachable |
| 13.1 Boarding compliance | A | — |
| 13.2 Diet transition | A | — |
| 13.3 Lost pet | B | No image-similarity tool |
| 14.1 DTC diagnosis | B | Codes typed in; OBD optional |
| 14.2 Bike wear | B | Strava's MCP is open only to platforms it trusts, so mileage comes from a manual log; video via `video.frames` and `video.view`, the shifting fixtures not run |
| 14.3 Recall monitor | B | NHTSA gives make/model/year campaigns, not per-VIN open status; scheduled weekly, not monthly |
| 15.1 Capsule wardrobe | A | — |
| 15.2 Morning outfit | B | Calendar preset not yet run against a real Google account (A once it is) |
| 15.3 Mending | A | — |
| 16.1 D&D lore | A | — |
| 16.2 Rules adjudicator | A | — |
| 16.3 Co-op scheduling | B | Discord polls and events built; no real Discord application run, and calendars need the Calendar preset's run |
| 17.1 Cursive transcription | A | — |
| 17.2 Census tracing | B | FamilySearch login via takeover |
| 17.3 GEDCOM audit | A | — |
| 18.1 Zettelkasten | B | Memory has embeddings, but vault notes are not embedded (similarity computed in the sandbox) |
| 18.2 Progressive summarisation | A | — |
| 18.3 Bookmark reclamation | A | Wayback API via `http.request` |
| 19.1 Taste graph | A | — |
| 19.2 Tour radar | A | — |
| 19.3 Keep-in-touch | A | — |
