# Jobs (`jobs.finder`)

`jobs.finder` is an external plugin that searches job postings, matches them
against your profile in code, and keeps your application pipeline. It never
applies for you and never sends anything; on an application form you turn on,
the browser fills what you allow and stops before the last step, which you
submit.

This guide covers searching employers' boards, job APIs,
government sources and the boards' own MCP servers; matching; tracking;
watches that sweep without a model, with heartbeat alerts and digests; the
browser fallback, with postings kept from your browser and your job-alert
emails; and staging applications up to their last step, which you submit.

## Install

Build the plugin, then install, approve and enable it like any external plugin
([PLUGINS.md](PLUGINS.md)):

```bash
pnpm --filter @tavi/plugin-jobs build
```

```bash
tavi plugins install packages/external/jobs/dist-plugin
```

```bash
tavi plugins approve jobs.finder 0.1.0
```

```bash
tavi plugins enable jobs.finder
```

It runs only as a confined worker: its approval shows the hosts it may reach,
the settings it holds as themselves (`rawSecrets`: Adzuna's two and Reed's,
because those sources take their key in the query or as Basic auth), and the
heartbeat signal source it adds (`watches`). It refuses to start beside the
owner.

It appears in Connected apps as **Jobs** (category Search), a Personal app:
only you, the operator, are offered its tools, and never in a chat whose memory
is that chat's own. Its results are your personal data as well as untrusted
third-party text.

## Settings

Every setting is optional. With none set, it reads the boards you name,
Himalayas, JobTech (Sweden), Le Forem (Wallonia), Dice and Snagajob. The keys
of the national sources are under *Advanced* on the app's page.

| Setting | What it does |
| --- | --- |
| `adzunaAppId`, `adzunaAppKey` | Your Adzuna developer keys (developer.adzuna.com). Adzuna covers 19 countries; its terms name personal research as a permitted use. |
| `himalayasKey` | A free Himalayas key, which raises its limits for remote jobs. |
| `usajobsKey`, `usajobsEmail` | Your USAJOBS key (developer.usajobs.gov) and the email you registered it with, which its API takes as the User-Agent: US federal jobs. |
| `navToken` | Your token for NAV's vacancy feed: Norway's ads. |
| `reedKey` | Your Reed key (reed.co.uk/developers): UK jobs. |
| `contact` | Optional: an email or URL sent in every request's User-Agent, `Tavi-jobs/<version> (+contact)`, so a source can reach you. Without it the User-Agent is `Tavi-jobs/<version>`. |
| `sources` | The source ids to use, comma-separated. Default: every documented source. |
| `countries` | Countries to search when a query names none, comma-separated ISO codes (`US,DE`). |
| `forget` | Empties the plugin's store once, at its next start; later starts keep what is saved since. Set it back to `false` and on again to empty it again. |

Set the keys on the app's page in Connected apps, or from the CLI as for any
plugin credential.

## Sources

| Source | Reaches | Needs |
| --- | --- | --- |
| Greenhouse, Lever (US and `eu:` hosts), Ashby, SmartRecruiters, Recruitee, Personio (`.de` and `com:` hosts), Breezy, Workable | An employer's own board, named in the search: Greenhouse `acme`, Lever `eu:acme` | Nothing |
| Workday | An employer's career site, named as in its address: `nvidia.wd5/NVIDIAExternalCareerSite`. Read as search engines read it: its robots.txt first (a site that disallows it is skipped), its sitemap at most once a day, then up to 10 new job pages a search, one every 2 s, each for its JobPosting data. Never Workday's `cxs` API | Nothing |
| Adzuna | 19 countries, one request per country | Your Adzuna keys |
| Himalayas | Remote jobs, with location and time-zone restrictions | Nothing (a key raises limits) |
| USAJOBS | US federal jobs | Your key and email |
| JobTech | Sweden's public employment service's ads (CC0) | Nothing |
| NAV | Norway's ads, read forward from where the last search ended; an ad NAV marks inactive is hidden at once | Your token |
| Le Forem | Wallonia's ads | Nothing |
| Reed | UK jobs | Your key |
| Dice | US tech jobs, through Dice's own MCP server. Each posting's attribution carries the company page and the line Dice requires: that it was found with AI-powered search. Its details are never fetched in bulk | Nothing |
| Snagajob | Hourly US jobs near a place the search names, through Snagajob's own MCP server, with the pay it states | Nothing |

An MCP source is one exchange with the board's server (`initialize`, then the
tool call), counted as one request against its budget. ZipRecruiter's server
is not used: it answered every request after `initialize` with `429`, so no
exchange could complete.

Each source has a record of its terms (licence, how long its postings may be
kept, attribution, rate limits), checked in the release tests: a record whose
terms were last reviewed more than 180 days ago fails them. Each request goes
through the source's budget (per second and per day, kept across the worker's
idle stops) and its health: five failures in a row, or a `429`, pause it.
`jobs.finder.sources` shows all of it, with the last 20 requests (host,
status, size, and the query's keywords, never your profile), and your
watches with their last sweep. A search in which more than half a source's
answers have changed shape pauses it for a day; for a per-board source, only
when most of the boards it read changed (one employer's board changing is that
employer's).

A weekly drift canary checks each source against the live service, outside CI:

```bash
TAVI_REAL_TESTS=1 TAVI_LIVE_JOBS=1 pnpm --filter @tavi/plugin-jobs exec vitest run test/drift.live.test.ts
```

It searches each keyless source on the public boards its recordings came
from (GET only) and fails when an answer no longer has the shape Tavi reads.
A keyed source runs when its key is set as `JOBS_KEY_<NAME>` (for example
`JOBS_KEY_ADZUNAAPPID`). The MCP sources are checked against recordings only.

Excluded on purpose: BA Jobsuche, MyCareersFuture's API, France Travail,
Workday's `cxs` endpoint, Indeed's MCP server, and any reseller of scraped
LinkedIn or Indeed data.

## Tools

| Tool | Does | Asks |
| --- | --- | --- |
| `search` | Reads the boards a query names and the APIs set up, keeps what answers it, and replies with up to 20 postings and excerpts. The postings are kept with the task as findings. | No on the first call. Once the chat holds both untrusted text and personal data (a `jobs.finder` result, your `jobs.profile.*` memory), a further search asks once (`private-search`), and a schedule refuses it. |
| `get` | One posting by id, or a Greenhouse, SmartRecruiters or NAV posting by its page's URL. | As `search`. |
| `match` | Checks stored postings, or a watch's hits, against your profile, in code. | Never: it sends nothing. |
| `pipeline` | Your applications by state, with counts. | Never. |
| `track` | Moves a posting through saved, staged, applied, interviewing, offer, rejected, withdrawn, archived, with a note. | Once the chat read untrusted text (`tainted-persist`). |
| `sources` | Sources, terms, budgets, health, recent requests, your watches, and the skills dictionary's version and credits. | Never. |
| `watch` | Creates, changes, pauses, resumes or removes a watch. | Always: you decide every call, and its card shows the action, the watch, its name, query, criteria, cadence, minimum score and digest. A run nobody attends refuses it. |
| `digest` | A watch's hits first seen after a time, with their scores. It reads only. | Never. |
| `fill_plan` | Plans an application form's answers from your `jobs.profile.facts` and what you said in the chat, leaving protected questions and the CV upload to you and the rest unmapped. Blocked for a posting flagged as a scam. | Never: it sends nothing. |
| `tailor_check` | Checks a cover letter or CV text before it is used: 40 or more words copied from the posting, hidden characters, skills you do not list, and any answer to an AI-use attestation; it says so when the posting's text is no longer kept to compare. | Never. |
| `ingest` | Keeps postings the agent gathered: a page's structured data, an extracted record, a job-alert email, or a career page's links (its ATS board, for `search` and `watch`). The browser worker may call it. | Always: you decide every call, shown the items. A run nobody attends refuses it. |

The agent is told to search before it reads your profile from memory where it
can: a search made after both are in the chat asks first.

## Your profile

Your profile lives in reviewed memory, not in the plugin. The plugin never
reads memory; the agent reads these records with `memory.get` and passes them
to `match`. Ask the agent to read your CV (`pdf.read`) and propose them, then
review each one:

| Topic key | Kind | Holds |
| --- | --- | --- |
| `jobs.profile.targets` | preference | Titles, seniority, places (with a radius), remote (`only`, `prefer`, `open`, `no`), the regions you can work remotely from, a salary floor, employment types |
| `jobs.profile.skills` | fact | Skills with years, each with the CV line it came from; past 8 KiB, `jobs.profile.skills.2` |
| `jobs.profile.exclusions` | preference | Companies and words to leave out |
| `jobs.profile.authorisation` | fact, **sensitive** | The countries where you need visa sponsorship; never a status unless you state one |
| `jobs.profile.facts` | fact | Contact links, education and work-history lines a form may ask for |

## Watches, alerts and digests

A watch is a search Tavi runs for you on a cadence (every 24 hours unless you
say, at least hourly) without a model. Ask the agent to watch for something;
it reads your profile and proposes the watch, and you approve its card. The
watch keeps a snapshot of your profile as its *criteria*, because sweeps run
without memory: change your profile and the agent proposes an update.

- **Sweeps** run in the plugin's worker when your heartbeat checks: each due
  watch's query is searched, the postings are matched against its criteria,
  and new fits at its minimum score (0.3 unless set) become *hits*, one per
  job. A source whose terms allow only searches you make is not swept.
- **Alerts.** The plugin's heartbeat signal source (`watches`) tells it each new hit
  (`New match: <title> at <company> (0.86)`) and any source that is paused.
  The heartbeat's own rules decide whether and where you hear of it; its titles
  are untrusted text.
- **Digests.** A watch made with `digest {at, timezone, deliverTo}` answers with
  the schedule to create: a daily prompt that calls `digest`, `match` and
  `pipeline`, which it may run unattended because none of them sends anything.
  Making the schedule is its own approval: in a chat the agent makes it with
  `schedules.create`, and stops or changes it later with `schedules.pause`,
  `schedules.cancel` or `schedules.update` (see
  [AUTOMATION.md](AUTOMATION.md#schedules)); `tavi schedules` does the same
  from the terminal.

## The browser fallback

Where no source covers a board, the agent can read it in your browser, within
the board's **site profile**. The plugin ships one per board whose terms the
research read, each off until you turn it on (the app's page in Connected
apps, *Sites this app may browse*, or `tavi apps sites jobs <site> on`):

| Profile | What Tavi may do |
| --- | --- |
| `linkedin-jobs`, `indeed`, `arbeitsagentur` (the BA's Jobbörse), `francetravail` | Never browse it. Tavi reads only a page you opened yourself in the live view, for the chat, and you may save that one posting. Their terms ban bots (LinkedIn, the BA) or automated applying (Indeed); France Travail withdrew its API after AI misuse. |
| `mycareersfuture` | Read for the chat only: it opens and reads pages, types only a search, and keeps nothing but the one posting you save yourself. Its terms forbid storing its content. |

Boards whose site terms have not been reviewed (Glassdoor, Naukri, StepStone,
SEEK, XING, Arbeitnow's and Himalayas' web pages, and the boards of markets
with no open source) have no profile yet.

The rules hold in code, for every plugin's profiles: pages per task and per
day at a courtesy interval; a captcha, robot check or rate limit ends the site
for the task and hands it to you; a schedule or heartbeat reads only a
watchable site, on a path its robots.txt allows; and a site read for the chat
only keeps no finding. The agent reads a page's structured data first
(`browser.structured`, its JSON-LD JobPosting) and extracts only where that
finds nothing.

**Saving postings.** The agent keeps what it found with `ingest`, which you
approve each time. A page of a site read for the chat only is kept only when
you save the one posting you opened (`personSaved`).

**Job-alert emails.** In a chat, the agent can read your LinkedIn and Indeed
job-alert emails (with the mailbox access you gave its app) and keep their
postings with `ingest`. Each posting's address is its link in the email: Tavi
never opens it. Only those two senders' alerts are read; another email is
ignored. A schedule cannot keep them: it can summarise new alerts for you to
save.

## Staging an application

Tavi fills an application form for you and stops before its last step: you
review the real form and submit it yourself. It never submits, never creates
an ATS account, and never fills a protected question.

1. The agent opens the posting's application page in the browser (a sign-in
   or account step is yours: it hands the page over).
2. On each page it observes the form and asks `fill_plan` for each field's
   value, with its source: your facts, or what you told it in the chat. A field
   nothing answers is left unmapped, and the agent asks you rather than guess.
3. It types the planned values, one approved step at a time; the CV upload
   asks every time.
4. It goes on with Next or Continue. At the last step — the ATS profile's
   final control, by its label, its address, or its control under its review
   heading (Workday's one footer button on its Review step) — the browser
   refuses the press, never asks, and the agent hands the page to you, saying
   what it filled and what is left. You complete the rest, review and submit.
5. When you say you applied, `track` records it.

**Protected questions** — equal-opportunity and demographic questions,
disability and veteran status, criminal history, attestations (that you
completed the application yourself, its use of AI, terms you accept),
signatures and consent to a background check — are refused on every site, in
eight languages, by the field's own name and labels whatever the observation
called it; so is a field the page hides (a honeypot). See [BROWSER.md](BROWSER.md#what-the-browser-refuses).

**ATS profiles** (turn each on in Connected apps, *Sites this app may browse*):
Greenhouse, Lever, Ashby, Workable, Personio, Recruitee, Teamtailor, Workday,
SmartRecruiters and SAP SuccessFactors, each with its final control (SmartRecruiters' is unverified); SuccessFactors' final control is its "Apply", so every
"Apply" on its hosts is yours. At most 10 applications reach their last step a
day on each (`stage.perDay`). iCIMS and Taleo have no profile: their hosts are
each employer's own.

"Apply" commits only on a control that submits its form: "Apply for this job"
links, "Apply filters" and "Check all that apply" do not. A press whose label
became a commit after the page was observed is refused unless you approved a
commit; acting by sight never commits.

**Tailoring.** The agent drafts a cover letter with you, checks it with
`tailor_check`, and saves it with `fs.write` (its own approval). A Gmail draft
has no attachments, so it names the file.

## Matching

Matching is code, so nothing a posting says can argue it onto your shortlist.

1. **Hard filters**, each with its reason. A filter excludes only what it is
   sure of; an unknown is `maybe`, never `fits`, except pay and a workplace
   whose every reading suits you (below):
   - an excluded company or word;
   - workplace, where one way of taking the job that suits you is enough: a
     remote option within your regions (offices and "Remote (US)" offer one),
     or an office within your radius. A remote posting that names no region
     is `maybe`. One that does not say whether it is remote passes when it is
     near one of your places and you would take an office (a remote job says
     it is one), and is `maybe` otherwise;
   - your salary floor, held only against pay the posting states: a source's
     own pay field, or a range its text gives as pay with its period beside it
     ("Pay range: $38.87 - $54.42 per hour"). It is annualised at 2,080 hours,
     260 days, 52 weeks or 12 months plus extra months, in the same currency,
     or converted at the day's ECB rates. Pay that is predicted, a lone figure
     or a guessed period in the text, absent, or in a currency with no rate
     passes, flagged `salary-unknown`;
   - employment type (a term the title or text states, such as "(Contract)",
     "12 month FTC", "Ausbildung" or "a fixed-term contract", counts over the
     hours a source gives), a closed posting, and no sponsorship where you
     need it.
2. **Score**: skills 45%, title 30%, seniority 15%, recency 10%. Skills are
   covered both ways: the share of the posting's skills you have (required
   count double, over at least six) and the share of yours it asks for. A
   title that holds one of yours as a phrase ("Software Engineer, Storage")
   scores in full. A posting that asks for three or more skills, none of
   yours, scores at 60%. The weights are tuned on the fixture set below.
3. **Gaps**: the required skills you lack, most often asked for first.

Skills come from an alias dictionary (`packages/jobs-kit/assets/skills.json`,
shipped beside the plugin's bundle as `assets/skills.json`): Tavi's seed list,
then about 1,500 ESCO v1.2.1 skill concepts and O\*NET 31.0 software names
that real postings name, in English, German, French, Spanish, Dutch, Swedish,
Italian, Portuguese and Norwegian. A one-word name with a capital ("Kubernetes",
"Informatik") is matched only as written. A skill under a requirements heading
("Requirements", "Anforderungen", "Profil recherché"…) is required.
`node packages/jobs-kit/scripts/build-skills.mjs --esco <dir> --onet <Software
Skills.txt> --corpus <postings.jsonl>…` rebuilds it from the ESCO API's skill
pages, O\*NET's database and postings gathered through the adapters, and writes
the notices both ask for:

- This service uses the ESCO classification of the European Commission
  (https://esco.ec.europa.eu); Tavi's is a modified subset.
- This site incorporates information from O\*NET 31.0 Database by the U.S.
  Department of Labor, Employment and Training Administration (USDOL/ETA),
  used under the CC BY 4.0 license. O\*NET® is a trademark of USDOL/ETA. Tavi
  has modified all or some of this information. USDOL/ETA has not approved,
  endorsed, or tested these modifications.

`jobs.finder.sources` shows them with the dictionary's version.

`pnpm --filter @tavi/jobs-kit eval` scores the matcher on the fixture sets
(`packages/test-support/fixtures/jobs/README.md`): 300 real postings labelled for
three personas, where each persona's hard-constraint precision is 1.0, no
posting that fails a constraint is shown as a fit, and the top fits'
precision (at ten, or at the number of labelled fits when fewer) is at least
0.8; 40 marked pairs for dedup (precision 1.0, recall 0.84 on 2026-10-17); and
50 Skill-XL ads, whose ESCO skills the dictionary finds at about 3% recall
(most are implied by a sentence, not named).

## Postings are untrusted

A posting's text is third-party data. Text the page hides from a reader
(`display:none`, `aria-hidden`, a colour equal to its background, …) is
dropped before it is stored and the posting is flagged `hidden-text`. Words
addressed to a model are flagged `injection-suspect` and kept as data. Other
flags: `scam:payment`, `scam:check`, `scam:id`, `scam:messaging`,
`scam:free-mail`, `scam:pay-outlier` (hourly, daily or weekly pay that comes to
over 300,000 a year), `ghost:age` (posted over 60 days ago), `ghost:reposted`
(posted again under a new id over 30 days after Tavi first saw it),
`ghost:evergreen` (seen for over 90 days), `salary-missing-required` (no pay
stated where a pay-transparency law may require it: a dated table of US states
and Canadian provinces, without the laws' employer-size thresholds) and
`ai-policy` (the employer's rule on AI in applications, quoted). Flags never
move a posting across a filter.

Nothing in the plugin sends: a posting that says "email your CV to …" can only
reach a draft, a send or a browser action you approve, and in a chat that read
it each of those asks.

## The store

`jobs.db` sits in the worker's home (`<data>/plugins/jobs.finder/home/`), so
`tavi backup` copies your pipeline and watches. One job seen several times is
kept once: the same address, the same requisition, the same company, title and
place, or the same description (MinHash, 80% alike) from the same
company. What it keeps follows each source's terms:

- a posting outside your pipeline is deleted 60 days after it was last seen
  (sooner if its source says so), and its text is blanked after 14;
- Adzuna's text is blanked 4 hours after it was fetched; its title, company,
  link and identifiers stay;
- a posting in your pipeline is kept;
- a watch's hit goes with its posting;
- a posting kept with `ingest` is stored as `agent:<host>`, under the same
  rules.

Deleted content is overwritten, not left in the file. `forget` empties it.

## Architecture

`jobs.finder` is split across shared domain primitives (`@tavi/domain-kit`), the matching/source engine (`@tavi/jobs-kit`), and the confined external plugin (`@tavi/plugin-jobs`):

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Domain Kit (`@tavi/domain-kit`)** | `packages/domain-kit/src/{worker,sqlite,budget,source-health,minhash,terms-test,xml,schema}.ts` | Shared confined-worker runtime helpers, SQLite store wrapper, per-source request budgets, circuit-breaker health tracking, MinHash near-duplicate detection, and 180-day terms-review test assertions. |
| **Jobs Kit (`@tavi/jobs-kit`)** | `packages/jobs-kit/src/{contracts,search,match,dedup,salary,ecb,skills,flags,fill-plan,tailor-check,ingest,alerts,jsonld,mcp-client,robots}.ts`, `packages/jobs-kit/src/sources/*`, `packages/jobs-kit/src/store/*` | Source adapters (ATS boards, public APIs, Workday sitemaps, Dice/Snagajob MCP), ESCO/O\*NET skill dictionary (`packages/jobs-kit/assets/skills.json`), hard-constraint + weighted matcher, scam/ghost/hidden-text flags, form `fill_plan`, `tailor_check`, and `jobs.db` store. |
| **External Plugin (`@tavi/plugin-jobs`)** | `packages/external/jobs/src/{index,engine,sites}.ts`, `packages/external/jobs/tavi-plugin.json` | Registers the `jobs.finder` tools, `watches` heartbeat signal source, and ATS/job-board browser site profiles inside a confined plugin worker. |

See [PLUGINS.md#architecture](PLUGINS.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for how confined external plugins run.
