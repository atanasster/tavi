# Privacy and network use

Tavi is local-first. Your chats, memory, credentials, files and settings live
in your data directory on your machine. It talks to a remote host only for
the features listed below, and only when you use them.

- **No telemetry.** Tavi has no analytics, crash reporting, usage pings or
  update checks. The usage measures `tavi doctor` reports (model calls,
  tokens, the onboarding checklist's progress) are read from your own
  database and never leave it.
- **No account.** Tavi has no service of its own to sign in to.

## What reaches the network, and when

| What | Hosts | When |
| --- | --- | --- |
| Model calls | the model connections you add (OpenAI, Anthropic, Google, OpenRouter, any OpenAI-compatible endpoint, or a local Ollama or LM Studio) | each model call a chat, run, routine or background job makes |
| Model routing | `api.typesafe.ai` (the Jev router) | only if you turn routing on; it is off by default |
| Sign-in | `openrouter.ai` and, with the ChatGPT sign-in preview, `auth.openai.com` (`tavi onboard`); `accounts.google.com`, `oauth2.googleapis.com` and `openidconnect.googleapis.com` (a Google account, signed in with your own Google client: who signed in, and only the access you turned on); each MCP server's own sign-in host | when you sign in |
| Web search and fetch | the search providers you configure (Brave, Tavily, Serper and others), and any page the agent fetches or opens in the browser | when the agent searches, fetches or browses |
| Model catalog | `rhumbdata.com` ([Rhumb](https://rhumbdata.com)) | only with a Rhumb key: `tavi models suggest` and `tavi models sync` when you run them, and `tavi serve` at start and daily; provider names only, never a prompt, a credential or a model id you use; asking for a replacement adds the kind of use (with tools, cheap, embeddings or video), which tells Rhumb that some model you use on that provider for it is going |
| Flight search | `mcp.kiwi.com` (Kiwi.com's public MCP server); `www.google.com` (Google Flights' search page) or, with a SerpApi key, `serpapi.com` | when the agent searches for flights: the trip only (places, dates, travellers, cabin, currency); Google Flights unless `travel.googleFlights` is off; built in, no setup |
| Channels | `api.telegram.org`, `discord.com`, `api.mailgun.net` or `api.eu.mailgun.net`, `gmail.googleapis.com`, and `www.googleapis.com` (a Google account's calendar, once turned on) | for the channels you connect, while `tavi serve` runs |
| Connected apps and MCP | the MCP servers and apps you add; `registry.modelcontextprotocol.io`, `registry.npmjs.org` and `pypi.org` when you search for or install a server | when you add or use them |
| Daily brief collectors | Google Analytics, Search Console and BigQuery (`*.googleapis.com`), `oauth2.googleapis.com`, `api.stripe.com`, the news feeds and search provider (`api.tavily.com`) you configure | only for the collectors you configure ([REPORTS.md](REPORTS.md)) |
| Plugin sources | jobs boards (Greenhouse, Lever, Ashby, SmartRecruiters and others), places data (OpenStreetMap services, Overture, public registries), trends sources (Hacker News, GDELT, Wikimedia, Bluesky, news feeds), routing (openrouteservice) | only for a plugin you enable, when one of its tools runs or its heartbeat checks |

What a plugin is given beyond its own calls is reviewed and switched by you, never assumed:

- **A channel plugin** gets mailbox tools only when its reviewed descriptor declares them and each account is turned on, signs in with the OAuth client your Google (or another provider's) apps share only after `tavi channels share-client <provider> <plugin>` binds that client to its approved version and only at that provider's own addresses (the client's secret goes to its token address), and never labels its accounts *Public*.
- **A memory provider plugin** reads your conversation (recall queries, the idle review's span, the epoch flush's span) only with `tavi memory egress conversation on`, and never for a chat on a local model connection; otherwise the built-in provider serves.
- **An onboarding flow plugin** sees each setup step's words (provider and model names, account labels) only when its manifest asks for `status-detail` and you approve it; otherwise it sees each step's state alone.
- **An ideas provider plugin** that reads your memory, tasks or brief has its ideas' first steps prepared (an unattended, read-only run whose searches carry the idea's words) only after `tavi ideas prepare on`, which a switch to another provider turns off again.

How requests identify themselves: `web_fetch` sends a `User-Agent` naming
Tavi; the browser presents itself as the desktop Chrome it is; the jobs and
trends plugins, and unattended reads of a site, read `robots.txt` first.

## Model calls and local connections

What a model call carries is what that conversation holds: your messages, the
tool results in it and the memory recalled for it. For the provider's prompt
cache it may also carry an id that ties a chat's calls together and says nothing
else: a SHA-256 digest of the chat's task id (of the heartbeat provider's id for
a heartbeat check, whose ticks share their prompt), sent to OpenRouter as its
`session_id` and to OpenAI as its `prompt_cache_key`. No other endpoint is sent
either.

A chat on a local connection (Ollama, LM Studio, or another endpoint on your
machine) keeps its text, and what it produced, off remote models. A chat is
local when it used a local connection, or runs on one: its own model, or the
default it starts on. For such a chat:

- **Replies, summaries, titles, compaction, memory capture and the injection
  check** stay on local models.
- **Its model.** A chat that starts on a local default keeps that local chain
  from its first turn, so changing the default to a remote model later does
  not move it. A chat that ran locally and whose default has since become
  remote is refused rather than moved.
- **Fallback.** Its main-role chain keeps only its local fallbacks. When no
  local model in it is available, the turn fails and says so; it never moves to
  a remote model on its own.
- **Routing.** The Jev router, or any routing provider, is never asked about
  it: not for its model, its memory, its skills or its tools. It is never moved
  to a remote `fast` model.
- **The browser.** Page extraction and acting by sight use only the local
  models among the bound roles (`extraction`, `fast`, `main`, their fallbacks)
  and the default. When only remote ones are bound, the tool refuses, naming
  the role to bind a local model to (`extraction` for reading pages, `main`,
  with a model that reads images, for acting by sight).
- **Work it starts.** A side chat of it runs on its local model (choosing a
  remote one for the side chat is refused), and a reminder set in it fires on
  its local model, or is refused when none is left.
- **Past-chat search.** `sessions.search` from a chat on a remote model finds
  nothing a local chat said.
- **Memory.** Every note it proposes or keeps is stamped as a local chat's
  (a tidy-up of such a note is too). A chat whose model is remote never sees
  one: not by recall, search, preference, listing, id, history or a related
  record. The embedding backfill sends one only to a local embedding
  connection, even after you accepted a remote one's disclosure. The weekly
  tidy-up reads one only on a local model drafting through the built-in
  provider. An external memory provider never receives one, nor a local chat's
  recall query.
- **Ideas and the heartbeat.** On a remote `fast` model they read neither
  these notes nor local chats' summaries. On a local one, an idea's prepared
  step and the chat its *Try it* starts run on a local model.

What still takes an explicit choice:

- Choosing a remote model for a local chat yourself (`/model`, or the chat's
  model picker) sends its conversation there from its next turn, as you asked.
  The chat keeps its local stamp for memory: what it writes afterwards is still
  stamped local, and from then on its own recall leaves out local chats' notes,
  as any chat on a remote model does.
- A remote embedding connection, once you accept its disclosure (`tavi memory
  config retrieval hybrid --yes=<connection>`), receives the notes of chats on
  remote models and their queries; never a local chat's.
- Notes you write yourself outside a chat (`tavi memory remember`, *Remember*
  in Command Center) carry no chat, so they are not stamped.
- Scheduled prompts (`tavi schedules`) belong to no chat: they run on the
  default you configured.

To keep everything on your machine, bind every model role (`main`, `fast`,
`extraction`, `compaction`, `embedding`) to local connections. `tavi models roles`
shows the bindings.

## What stays on your machine

The database, chat archives and files, credentials (encrypted at rest from
the start in a new data directory, under a key in the OS keychain or else in
`credentials.key`; in a directory from before, after `tavi credentials
encrypt`), approvals, memory and the browser
profiles (`<data>/browser-profiles/`) are in your data directory. `tavi backup`
copies the database and files; credentials only with `--include-credentials`,
and never the credentials key or the browser profiles. A key kept in the OS
keychain stays on this machine; `tavi credentials key --to-file` moves it into
`credentials.key` for a backup you will restore elsewhere. `tavi reset` deletes it
all, including a key kept in the OS keychain (the item
`tavi-credential-key`); a keychain that refuses is named in the output, for
deleting by hand.

Forgotten means gone from the database file, not only from its tables. The
database runs SQLite's `secure_delete`, so forgetting a memory, forgetting or
rewinding a chat, or deleting a chat's checkpoints overwrites the deleted text
with zeros, and about a second later the write-ahead log (`tavi.sqlite-wal`),
whose older frames could still hold it, is checkpointed and truncated. A
reader holding an older snapshot (a backup in progress) delays that; it is
retried every 30 seconds. Not reached: text deleted before this release, which
stays in the file's free space until that space is reused or reclaimed (the
retention sweep's `VACUUM`), backups you made, a `tavi.sqlite.pre-restore-*`
copy, and whatever the disk itself keeps of overwritten blocks.

## Architecture

Network egress controls, local-model isolation, and link disarming are enforced across `@tavi/runtime`, `@tavi/channel-kit`, `@tavi/plugin-sandbox`, `@tavi/plugin-browser`, and `@tavi/cli`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Host & Address Guards** | `packages/runtime/src/host-policy.ts`, `packages/runtime/src/address-guard.ts`, `packages/runtime/src/fetch-tool.ts`, `apps/cli/src/features/browser/address-guard.ts` | Outbound host allowlist enforcement (`--http-allow-host`, `--browser-allow-host`), private/loopback/link-local/CGNAT IP blocking, and DNS-rebinding protection (connecting only to the verified IP). |
| **Sandbox & Browser Egress Proxies** | `packages/builtin/sandbox/src/egress.ts`, `packages/builtin/browser/src/egress-proxy.ts` | Per-child HTTP/CONNECT proxies that enforce domain allowlists, block local/private ranges, and inject host-bound credentials (`--sandbox-credential`) without exposing secrets to the child. |
| **Local-Model Chat Isolation** | `apps/cli/src/features/models/local-chats.ts`, `packages/runtime/src/memory/service.ts`, `packages/agent-host/src/hosts/{ideas-host,heartbeat-host}.ts` | Stamps chats and memories created on local connections (`localOnly`), prevents fallback or routing (`@tavi/plugin-router`) to remote models, and excludes local notes from remote recall, embeddings, Ideas, and Heartbeat calls. |
| **Outbound Link Disarming** | `packages/contracts/src/url-text.ts` (`disarmUrls`), `packages/builtin/telegram/src/send.ts` | Disarms unseen URLs in tainted chat replies (`example[.]com`) and disables link previews (`link_preview_options.is_disabled: true`) on outbound Telegram messages. |

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY-MODEL.md](SECURITY-MODEL.md) for how these guards fit into the turn pipeline.
