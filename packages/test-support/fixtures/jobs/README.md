# Recorded source responses

Recorded 2026-10-16 with GET only, from public, keyless endpoints:

| Folder | Request |
| --- | --- |
| `greenhouse/board.json` | `boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true` (3 of its jobs) |
| `greenhouse/job-pay.json` | `boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?pay_transparency=true` |
| `lever/postings.json` | `api.lever.co/v0/postings/leverdemo?mode=json` (2 postings) |
| `ashby/board.json` | `api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true` (2 jobs) |
| `smartrecruiters/list.json` | `api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=3&q=engineer` |
| `smartrecruiters/posting.json` | the first of those, by id |
| `recruitee/offers.json` | `bunq.recruitee.com/api/offers/` (2 offers) |
| `personio/positions.xml` | `personio.jobs.personio.de/xml?language=en` |
| `himalayas/search.json` | `himalayas.app/jobs/api/search?q=backend%20engineer&country=US` (2 jobs) |

Long descriptions are cut at a paragraph's end. Personal names are replaced
("a recruiter", "the hiring manager", "A Recruiter"), email addresses become
`recruiter@example.com`, LinkedIn profiles `linkedin.com/in/example`, and an
avatar URL a placeholder.

More, recorded the same day the same way:

| Folder | Request |
| --- | --- |
| `jobtech/search.json` | `jobsearch.api.jobtechdev.se/search?q=backend&limit=2` |
| `nav/feed.json` | `pam-stilling-feed.nav.no/api/v1/feed` with the public token and `If-Modified-Since: Thu, 15 Oct 2026` (3 active items and 1 inactive one) |
| `nav/entry.json` | one active item's `/api/v1/feedentry/<uuid>` |
| `forem/records.json` | `www.odwb.be/api/explore/v2.1/catalog/datasets/offres-d-emploi-forem/records?limit=2` |
| `breezy/positions.json` | `breezy.breezy.hr/json` (Breezy's own demo board) |
| `workable/account.json` | `apply.workable.com/api/v1/widget/accounts/huggingface?details=true` (2 jobs) |
| `ecb/eurofxref-daily.xml` | `www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` |

Phone numbers become `+00 000 00 000`, and NAV's and JobTech's contact lists
are emptied.

`adzuna/search.json`, `usajobs/search.json` and `reed/search.json` are not
recorded: each needs the person's key. They are written from each API's
documented response (developer.adzuna.com/docs/search,
developer.usajobs.gov/api-reference/get-api-search, reed.co.uk/developers),
with invented postings.

## The evaluation sets

Gathered on 2026-10-17 through jobs-kit's own adapters, GET only, from public
keyless boards: Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee,
Personio, Workable, Breezy, Himalayas, JobTech and Le Forem (59 boards and
queries; 9,869 distinct postings). Berlin's care employers on Personio
(Krankenhaus Waldfriede, ASB Berlin, MEOCLINIC) cover the nurse persona.
Emails become `recruiter@example.com`, phone numbers `+00 000 00 000`,
recruiters' names "A Recruiter" and LinkedIn profiles `linkedin.com/in/example`.

**`labels.json`**: 300 of those postings, stratified (111 engineering, 90
marketing, 65 health, 34 others). Each is labelled for the three personas of
`personas.json` with `fits`, `maybe` or `no` and why, by five reviewers given
only this rubric and the postings, never the matching code:

- `no`: a hard constraint clearly fails as the posting states it (a place,
  remote region, stated pay, employment type, excluded word); never the role.
- `maybe`: nothing clearly fails, but something a constraint needs is not
  given, or the role is not one the persona wants.
- `fits`: every constraint clearly met (unstated pay is fine) and a role the
  persona would apply for.

The reviewers were model agents, not people: the labels are a reading of the
postings against the rubric, and two postings whose own fields contradict
their text (r031, r266) are listed in `eval.test.ts` as such.

A second pass by five other agents, who saw the rubric and the postings but
not the first labels, agreed on 292, 298 and 299 of 300 (backend, nurse,
marketing; Cohen's kappa 0.94, 0.97, 0.99). A third agent ruled on the 11
differences from the posting and both readings, and its rulings stand: 7
changed a label. Its rules, now the rubric's reading:
- a posting that names a city and never says whether it is remote is
  unknown (`maybe`) for a remote-only persona, and `no` only when its text
  says on site, in the office or hybrid;
- a remote posting's region is read from its text as well as its fields;
- a place is what the posting states, not what a reader knows a name means
  ("Sozialstation Waldfriede" names no city);
- seniority and a full-stack or front-end lean count toward the role, never
  as a constraint.
The descriptions keep only the paragraphs the matcher read when they were
trimmed (2026-10-21): a paragraph was dropped when every persona's outcome,
score and reasons stayed exactly the same without it, so the evaluation's
results were unchanged, and most company, benefits and legal boilerplate went
with it (39 descriptions are now empty). The labels were made from the full
postings, which `sourceRef` and `url` name.
`labels-synthetic.json` keeps the hand-written postings, one constraint each.

**`dedup-pairs.json`**: 40 pairs of those postings, 25 the same job (a
Himalayas listing and its employer's own board; one requisition posted twice
on its board) and 15 not (another requisition or level at one company; one
title at two companies; two companies sharing a name). Marked by comparing
their texts, which are kept whole: the dedup check compares them.

**`skill-xl-sample.json`**: the first 50 ads of the test split of
[TechWolf/Skill-XL](https://huggingface.co/datasets/TechWolf/Skill-XL)
(CC BY 4.0), each ad's sentences in order and the ESCO skills its annotators
gave them, grouped by ad and otherwise unchanged.

**MCP sources and the Workday reader**, kept beside the boards above:

| Folder | Holds |
| --- | --- |
| `dice/search.json` | Dice's MCP server: its `initialize` reply and one search `call`'s result |
| `snagajob/search.json`, `snagajob/detail.json` | Snagajob's MCP server: `initialize` and a search call, and `initialize` and a posting's detail call |
| `workday/robots.txt`, `workday/siteMap.xml`, `workday/job.html` | An employer's Workday career site (NVIDIA's): the robots file naming the sitemap, the sitemap, and one job page whose `application/ld+json` the reader parses |
| `alerts/indeed.html`, `alerts/linkedin.html` | Synthetic, not recorded: job-alert emails shaped like Indeed's and LinkedIn's (each says so in its first line) |
