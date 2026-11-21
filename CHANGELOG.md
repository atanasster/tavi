# Changelog

All notable changes to Tavi are recorded here. The project follows
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
change behaviour or stored data.

## Unreleased

### Changed

- `/new` in a chat no longer shows the earlier conversation's task id: it
  says the earlier one can still be read in the Tavi app, and mentions a
  cancellation only when something was still going.
- Approval cards in a chat with buttons say to press one, or to reply
  "approve" or "reject" with a reason, instead of a round code and a
  `<reason>` placeholder (the code stays where a typed answer needs it: a
  worker's round, or a group's shown to you privately), and still says what
  Session and Always allow. A button press and the reason prompt no longer
  name the round's code either. A decided card says "Approved for this chat by Ana
  via Telegram at 05:24 EET": no round code, the person's name rather than
  `operator`, and the workspace's time zone rather than UTC, as is the
  deadline a card is rejected by.
- An approval card in a chat says why a call is HIGH risk when reading
  outside content is the only reason ("HIGH risk, as the chat read outside
  content"), so a reminder or a site you named no longer looks dangerous for no reason.
  The rating rule itself is unchanged.

### Fixed

- An approval card no longer breaks the link of a site you sent the chat
  yourself ("after reading example[.]com" after you wrote
  https://example.com). Any other host, including one a page linked, is
  still disarmed.

## 0.3.1 — 2026-11-21

Fixes from testing 0.3.0 on a fresh install.

### Fixed

- A chat run on a Claude model through OpenRouter gets its title and summary
  in the activity list: the short summary call turns Claude's thinking off,
  which could spend the call's whole answer on some chats (a sum, a date).
- Started from a folder that was moved to the Trash or deleted, `tavi` says
  so and suggests `cd ~`, instead of failing with "could not resolve the model
  target: INTERNAL: EPERM … uv_cwd". `--help` and `--version` still answer.

## 0.3.0 — 2026-11-21

Tavi now checks the models it uses against Rhumb's catalog: it warns before
one retires or is redirected, suggests a replacement, and `tavi models
replace` moves every use of it in one step.

### Added

- `tavi models sync` asks Rhumb (with `RHUMB_KEY` set) which of the models
  tavi uses are retired, redirected to another model, retiring, deprecated
  or changing price, stores it per connection, and prints the warnings with
  every place each model is used (defaults, roles and their fallbacks,
  routines, heartbeats, chats). `tavi serve` does the same at start and every
  24 hours and logs one line, and `tavi doctor` shows what was stored as a
  "Model lifecycle" line (`modelConfiguration.lifecycle`). Only provider
  names are sent, and no model is ever changed for you. The key may also be
  stored as the credential `rhumb`: `tavi setup` offers it once a cloud model
  works, and Settings → Models has a **Model retirements** card for it.
  Settings → Models shows a banner for the roles' models that retire or are
  redirected, the chat's model picker marks them, and the TUI's `/models`
  ends with them. Setup no longer proposes a model the last sync says is
  retired, deprecated, closed to new users, or retiring or redirected within
  30 days. A model in use that is retired, redirected, or retiring or redirected within
  30 days now comes with what could replace it: the provider's redirect target and Rhumb's pick on the
  same provider for each kind of use (with tools, cheaper background work,
  embeddings, video), asked once per catalog version (kept by the running
  owner) and shown in
  `tavi models sync`, `tavi doctor`, `/models` and the Settings → Models
  banner. Nothing is switched for you: `tavi models replace
  <connection>/<model> --with <model>` (and a **Replace with …** button on
  that banner) lists every place a model is used in the workspace, asks, then
  moves the default, roles and fallbacks, routines (once their quality check
  passes), heartbeats, activity summaries and chats to the new one.
- `tavi serve` (at start) and `tavi doctor` (`mcp.weakerSandbox`) name each
  approved MCP server that runs unsandboxed or in the nested sandbox while
  this host's sandbox now confines more, with the way to move it: add the
  server again with a new `--version`, which probes in the sandbox, and
  approve that version. Nothing is moved for you: the server might not run
  under the stronger sandbox.
- `pnpm test:coverage` measures test coverage per package (lines,
  statements, branches, functions) and sums it into a table; a weekly and
  on-demand CI workflow (`coverage.yml`) posts it to the job summary and
  uploads each package's HTML report. Report-only: no floor is enforced yet.
- The sandbox runtime's bumps get the full sandbox matrix: Dependabot raises
  `@anthropic-ai/sandbox-runtime` in a pull request of its own, `sandbox.yml`
  runs the matrix on any pull request that changes its pin (no label needed)
  and weekly, and `SECURITY.md` has a "Critical dependencies" section on what
  a bump must pass. A repository test fails once an ignored audit advisory no
  longer matches an installed package.
- On a headless Linux service the credential key can be kept as a systemd
  credential, encrypted by `systemd-creds` and handed decrypted to the service
  alone, rather than in the clear in `credentials.key` beside the data.
  `tavi credentials key --export` pipes the key to `systemd-creds encrypt`,
  `tavi service unit --credential-encrypted` adds the `LoadCredentialEncrypted=`
  line, and `tavi credentials key --to-systemd`, run against the started
  service, makes the credential the key's home once it holds the same key
  (`--to-file` moves it back). A page cannot move the key.

### Changed

- A routine's models count as in use (doctor, `tavi models sync`, Settings →
  Models) from the revision it runs, not an edit still waiting for its check,
  and an archived routine's not at all; they are read in one request.
- A model whose end a catalog claimed, but its provider never confirmed, is
  still noticed once that day has passed: "may have retired on …".
- `tavi models suggest` uses a Rhumb key stored as the credential `rhumb`
  (the setup offer, Settings → Models or `tavi credentials set rhumb`), as
  `tavi models sync` does; `RHUMB_KEY` still wins when both are there.
- Once a chat has read content Tavi does not trust, opening a browser session
  on the workspace's signed-in profile asks first, whatever the page, unless
  you approved a signed-in session earlier in that task; a signed-out session
  (`profile: "ephemeral"`) does not. A run nobody attends is refused and told
  to open a signed-out one.
- A new data directory is encrypted at rest from its first open even where
  there is no OS keychain (Linux without a Secret Service, or
  `TAVI_CREDENTIAL_KEYCHAIN=off`): the key is written to `credentials.key`
  (0600), as `tavi credentials encrypt` does. A directory from before is left
  as it is, and the startup and doctor warning still names a plain store that
  holds values.

### Fixed

- On an OpenRouter connection, a model's redirect target, and the provider's
  replacement drawn from it, is named as OpenRouter lists it
  (`google/gemini-3.5-flash-lite`, not `gemini-3.5-flash-lite`), so replacing
  a model with it finds the model.
- `tavi models suggest` asks Rhumb at `https://rhumbdata.com` by default:
  its old address, `https://models.nannertech.com`, no longer resolves, so
  every suggestion failed unless `RESOLVER_URL` was set. Its key is read
  from `RHUMB_KEY`, the name Rhumb's own docs use; `RESOLVER_KEY` still
  works when `RHUMB_KEY` is unset, and the hint names where to get a key.
- Setup's suggested models follow today's catalogs: on OpenAI it proposes
  GPT-6's sol tier as the main model and luna as the fast one (it proposed
  GPT-5.6 and GPT-5.4 mini), and on Gemini, Gemini 4 carbon or argon (it
  proposed the deprecated Gemini 2.5 Pro over the newer 3.1 Pro preview).
  The deprecated `o3` and GPT-5 nano are no longer proposed, an OpenRouter
  model's plain id comes before its `:free` variant, and a `:batch` variant
  is never proposed.
- Under a systemd unit, confined children (sandboxed commands, plugin
  workers, MCP servers, the PDF, video and browser children) could read the
  credentials systemd hands the owner (`$CREDENTIALS_DIRECTORY`, from
  `tavi service unit --credential`): they run as the unit's own user, and the
  folder was not on the owner's read-deny list. It is now.

## 0.2.0 — 2026-11-20

The first release with a prebuilt install, from the release's `install.sh`
([README](README.md#quick-install)).

### Added

- A prebuilt install for people who are not building Tavi: each GitHub
  Release carries the packed packages, `install.sh` and `SHA256SUMS`, and
  `curl -fsSL https://github.com/atanasster/tavi/releases/latest/download/install.sh | sh`
  checks Node, verifies every package, installs into `~/.tavi/app` with the
  browser tools, and links `tavi` into `~/.local/bin`. A `v<version>` tag
  publishes one after installing it on fresh Linux and macOS runners
  (`.github/workflows/release.yml`).
- `tavi remote connect <ssh-target>` lets the clients on this computer use a
  `tavi serve` on another one, such as a Mac mini on your network, over your
  own SSH sign-in. It keeps a mirror directory (`~/.tavi-remote/<host>`) that
  `tavi chat`, `tavi ui`, `tavi run` and the other commands name with
  `--data-dir`, follows the owner when it restarts, and signs in again when the
  connection drops. The canvas shows the remote owner's plugin pages too. Clients of a remote owner no longer send it folders of
  this computer, and the mirror is never opened as a data directory of its own.

### Changed

- Approving a plugin to run in-process (unsandboxed) is the terminal's alone,
  as an MCP server's weaker sandbox is: Settings → Plugins no longer offers
  **Approve in-process…**, names `tavi plugins approve <id> <version>
  --in-process` for a version that cannot be a worker, and the owner refuses an
  in-process approval from a page.
- An approval or question email that carries single-use links now says that
  anyone with the message can use them, and not to forward it.
- A credential store that holds values but is not encrypted at rest — where no
  OS keychain could keep a key, such as Linux without a Secret Service — is no
  longer silent: `tavi serve` warns at start and `tavi doctor` says so under
  `credentialStore`, naming `tavi credentials encrypt`.
- Each answer in the canvas says, on the line of its copy and read-aloud
  buttons, how long it worked, the model that answered and its tool calls
  (`2m 05s · gemma4-32k:latest · 3 tool calls`), and the memories it used are
  a memory icon with the count there. The figures strip along the bottom of
  the page is gone; its keyboard-shortcuts button is an icon at the right of
  the header. The "Enter to send · Shift+Enter for a new line" line under the
  message box is now the second line of its placeholder, and a chat being
  continued says **Continue this chat…** rather than repeating its title. On a
  phone the chat panel's button sits at the right of the row under the header
  instead of over the Send button.
- A run's notice in Home shows what the run said as it would in a chat — a
  list as a list, bold as bold — rather than its raw `**` and `*` marks, and
  its Open run and Reply in a side chat are both words, lined up with the
  notice's text.
- The Ideas tab: an idea's ⋯ menu is wider, so its longer items take a line
  or two rather than three; on a phone Refresh lines up with the text above
  it; and the brief's note in Tune sits as close under its box as it does in
  Settings.
- Settings → Ideas is easier to scan. What Ideas may read has its own card,
  apart from the switches and when Ideas look; a switch whose words wrap
  keeps them beside its box; the brief asks its question as its label, with
  how it is read as a note under the box; and Bring back, Unmute and Use
  again are drawn as every list row's ordinary action is.
- Settings → Permissions reads more cleanly. A rule's note starts as a
  sentence, without the "yours:" or "shipped with Tavi:" in front, and the
  shipped rules no longer each say "All workspaces" under a heading that
  already says where they come from; a rule from `serve --allow` is tagged so.
  A chat grant leads with the site it reaches, kept whole, before its tools,
  and the injection detector's note sits under its own field.
- A list row's buttons look the same on every page. An ordinary action
  (**Test**, **Disable**, **Settings**, **Replace**, **Set**, **Rediscover**,
  **Run now**, **Inspect**) is small words with no box. Only an action that
  removes, revokes or ends something (**Remove**, **Delete**, **Revoke**,
  **Disconnect**, **Forget**) has an outline, in red. The one action a row is
  waiting on (**Approve** a plugin version, **Set** a default model not yet
  chosen) is filled. Before, Plugins, Credentials, Models, an app's accounts and
  the Connected apps list drew their actions as outlined buttons while Channels
  and Web search used words, and Permissions and memory drew **Remove** and
  **Forget** as red words. On a phone, a row whose actions wrap under its name
  starts them on the name's edge.
- Settings → Plugins, walked at desktop and phone width. A plugin's
  **Settings** dialog names each field as its plugin labels it ("Your
  contact", "AFDC key") rather than by its key, and each field's explanation
  sits right under that field as one hint, read with it, instead of a separate
  paragraph as far from its field as from the next one. A row's state
  (**stopped**, **disabled**, **failed**) is toned as states are elsewhere, apart
  from the plain **worker** tag beside it, and a description's `commands`
  are set as code instead of showing their backticks. A greyed **Remove** says,
  on hover, to disable the plugin first. The Install dialog's placeholder, cut
  short on a phone, is now `/path/to/plugin`, with "The folder that holds its
  `tavi-plugin.json`" under the field.
- Settings → Allowed people, walked at desktop and phone width. **Person
  allowed** and **Access revoked** are the boxed note held in view a moment,
  as on the other settings pages, rather than a bare line above the list. The
  Display name field's placeholder, cut short on a phone, is now an example
  ("e.g. Sam"), with "Shown in Center; the person ID otherwise." under the
  field as the fields above it have. Revoking a person with no display name
  names them by their person ID as well as their number ("walktest
  (1000000001)"), as their row does, instead of the number alone.
- Settings → System prompt, walked at desktop and phone width. The prompt's
  box sits a little apart from its label instead of 2px under it, and
  **Saved.** or **Cleared.** is the boxed note held in view a moment, as on the
  other settings pages and the Command Center's prompt editor. The note on how
  **Restore default** works appears only when a custom prompt is saved, not
  while a first one is still being written.
- Settings → Web search, walked at desktop and phone width. A provider's
  **Test** and **Disable** are text buttons, as a channel's are, with only
  **Remove** outlined, and on a phone they start on the provider's name. A
  disabled provider shows a muted status rather than a pill that looked like
  a button, and a SearXNG provider's address follows a "·" like the other
  details. `web-providers.json` and `tavi serve` are set as code and no longer
  break at the hyphen, and the notes for a long or partly unreadable list show
  their commands as code instead of literal backticks. **Test** says "answered
  with 5 results" (also in `tavi search test`), the add dialog sets the key's
  credential name as code, and removing a provider says "The agent's web
  searches stop going to tavily" instead of naming the `web_search` tool.
- Settings dialogs and saved states, walked again. A page's note after a
  save (**Saved.**, a refusal) is a boxed note that stays on screen for a few
  seconds while you scroll, then settles in place; a refusal is said as an
  error, not as a quiet status. The notes of a dialog (the Rooms grant, a
  connection's settings, **Test**) sit above its Save and Cancel row instead
  of under it, where the sticky row hid them. Counts read "1 conversation",
  "1 heartbeat target", "Discovered 1 model" rather than "1 conversations".
  Pairing a person on a phone puts the `/link` command and its **Copy**
  button under the QR code instead of in a column one word wide, and closing a
  pairing no longer crashes the People dialog in newer browsers. Connecting
  Home Assistant asks for its address beside its token in the key step, where
  before it said it needed a url and showed only the token field; each field
  is named in words ("Its MCP address", "A long-lived access token"). An app
  whose tools are not listed yet says so in one sentence, and its connect
  sheet's **Cancel** is a plain text button.
- Settings → General, walked at desktop and phone width. A section's lone text
  button (**Clear browser profile…**, **Forget all recipes**, **Reset
  instance…**) starts on the page's edge with the paragraph above it instead of
  13px in, and Site recipes are hairline rows rather than a bulleted list. On a
  phone the timezone field fills the row beside **Save**, with **Use host zone**
  on the edge under them, and the video setting keeps "30 days" together
  instead of leaving "days" alone under its field.
- Settings → Channels, walked at desktop and phone width. In a channel's
  **People** dialog the **Pair with a code** / **Allow person** row lines up
  with the Allow a person fields above it; before, it started 24px to their
  left. On a phone a connection's buttons wrap under its name with the first
  button's word lined up with the name.
- Settings → Credentials, walked at desktop and phone width. A dialog whose
  title names something long (**Replace channels.6557…token**) wraps the title
  instead of scrolling the whole dialog sideways and losing its left padding;
  this holds for every dialog. "Not encrypted: run tavi credentials encrypt"
  is a boxed warning, and on a phone the page's description sits under its
  title, above **Set a credential**, rather than after the button.
- Settings → Connected apps, walked at desktop and phone width. Discover's
  cards keep their tags with their button at the foot, so the cards in a row
  line them up, and a card's description is spaced like its name rather than
  by a paragraph's margins too. An app's Recent activity is a hairline log
  instead of a bordered card per line, its state and time on one line under the
  chat it happened in and that chat's title held to two lines; on Places the
  section went from about 5,400px to 3,300px tall. An app's "← Connected apps"
  has its arrow on the page's left edge. In the MCP Registry's results, the
  name a server is added under has a visible **Name** label and a field wide
  enough for its longest (19 letters), so its default is read whole; a
  listing whose title is its registry name shows that name once.
- Settings → Models, walked at desktop and phone width. A connection's
  Rediscover and Manage sit level with its name instead of dropping to the
  middle of an opened Native video list, and on a phone a role's Clear and Set
  sit beside its name, not halfway down a description that wraps. In Manage,
  "Remove this connection…" starts on the dialog's text edge. The tiles in Add
  a model connection start their words at the top, so tiles in a row line up,
  and its intro says "Tavi's". On a phone the model picker wraps a model's name
  and details and puts its badges under them, rather than cutting every name to
  "AionLabs: Aion …".
- A chat's page, walked at desktop and phone width. A replayed turn that kept
  only its prompt no longer shows an empty **Tavi** heading under it. The
  chat panel's Hide button sits level with the chat's name rather than halfway
  down its name and status, without the grey fill of an open control. A long
  URL quoted in the panel (Schedule's "Runs …") breaks at the panel's edge
  instead of widening it. On a phone a block of tool calls keeps "Worked · 2
  steps" on one line, the calls' names giving way. A saved tool call that kept
  no input or answer shows no chevron that opens to nothing, and a chat's
  Agents view no longer starts with its own bare task id.
- Approvals, walked at desktop and phone width. A tool call's "after
  reading …" line is spaced by the card's gap, not a paragraph's margins on
  top of it, and starts as a sentence. A pick-several question's tick sits
  level with its number and words, not 4px above them.
- Activity, walked at desktop and phone width. A warning about the owner's
  own health (memory, open files, processes growing) is a boxed warning that
  starts as a sentence, not a loose lowercase line of colour. A row's
  "1 follow-up" and the follow-ups under it start on the title's edge, not
  6px in. A chat's title, when the owner hands it to a client, is cut with
  an ellipsis rather than mid-word.
- Browser, walked at desktop and phone width. Show visits sits at each
  card's foot, level across a row whatever the titles' lengths. A task's
  title is at most four lines, ending in an ellipsis. A session that opened
  no page is a short card with its task, not a "?" placeholder the size of a
  page's picture.
- Soul & memory, walked at desktop and phone width. Keep without asking
  says what may be kept under its name, before its ticks, rather than under
  Lessons as if it were that one's. A tick in Memory's settings stands 8px
  from its words, not one space. The limits under More show their numbers
  whole (8,000 read "800(" before). Keep all and Discard all sit under the
  suggestions card on its edges, not against it and past its right side.
  Chat notes and Skills start on the cards' edge, not 16px in.
- Schedule, walked at desktop and phone width. Pause all stays on the
  Recurring filter row, the name filter giving up width for it, rather than
  wrapping onto a line alone. Done / missed shows the chevron it opens with.
  A to-do's note starts under its words, not under its tick. Show the rest
  of the week starts on the section's edge.
- Heartbeat, walked at desktop and phone width. The day's limits are a row
  of four even fields with Save limits (now a button, not a ghost) under
  them; Signal sources tick in even columns; Where lists Home above the
  Channel and To fields, which fill the row; Forget heartbeat history is in
  red and sits on the Provider field's line; with no lines yet, Edit reads
  "Add a line", and it and History start on the text's edge. The rail's
  Heartbeat chip is as wide as its words. A fieldset among form fields no
  longer sits 2px in from them. An extra tool's description cut short ends
  in an ellipsis rather than mid-word. On a phone, a Command Center or
  Settings page opened directly now shows its own tab in the strip, also
  after the tabs' counts arrive and widen it.
- Buttons keep their size on a phone. An approval card's Allow once and
  Deny, the undo bar, Heartbeat's buttons and a recurring task's controls
  no longer grow to 44px tall on a narrow window or touch screen; the room a
  thumb needs is an invisible target around each button, as everywhere else.
  An app's Remove button now sits in its Advanced card beside Turn off,
  rather than against the card's edge below it, and Save limits in Soul &
  memory and Load older chats stand off what is above them.
- One scrollbar, never two. On a phone, Settings and the Command Center
  scrolled both the page and the area holding the section tabs; now only
  the page scrolls. Long text you open in Soul & memory, a skill, the chat
  panel's instructions or Settings → System prompt runs its full length
  instead of sitting in a scroll box inside the scrolling page.
- Settings: a paragraph under a page title keeps a readable width rather
  than the page's full width. Form help, legends and checkbox labels are
  the size of the labels around them. A checkbox's description stays under
  it when the field beside it is taller. Each model connection's status dot
  sits on its name's line. Credentials kept unencrypted are said in the
  warning colour. A plugin's Hook activity opens with a chevron like its
  Tools list, and Settings → Ideas' Save brief is the primary button.
- In a chat, the side panel's text actions ("Set up a schedule…", "… in the
  Command Center →") start on the same edge as the text above them, one a
  line, and the composer's model picker is as tall as Send.
- Command Center reads better beside the sidebar and the rail. Soul & memory
  stacks its two panes whenever the column is too narrow for both, rather
  than squeezing a memory proposal to a few words a line. The Approvals
  history keeps what was asked readable and wraps a long task title inside
  its column. A review waiting on you is labelled like the other cards. In
  Heartbeat, Add sits level with the field beside it, the sections have room
  between them, "Where" is a plain list at the form's size, and on a phone
  each Tell me choice's radio sits on its first line.
- The Ideas tab lays every section out two cards a row, so a section of one
  is as wide as a card in For you rather than a narrow third. A card's ⋯
  menu is drawn as the Center's row menus are, with each item tinted under
  the pointer and ringed when focused. The "Why this" line is as close to
  "Uses" as any two lines, card titles share the page's heading weight, and
  Tune's Save is the primary button. Row menus' items are now the size of
  other menu text.
- Controls are the size of the text around them. Buttons, fields, menus and
  tabs use 13px text, and a field is exactly as tall as the button beside it
  (it used to grow a few pixels taller). The actions in a list's row (Channels,
  Credentials, Plugins, Web search, Permissions, Allowed people) are small, and
  a row's Remove in Permissions is red text instead of a red box. Settings'
  text is 13px with a readable line length, and a section's heading is never
  larger than the page's title. Badges, switches and checkboxes are smaller;
  primary buttons are no longer bold; a reminder's Done is outlined instead of
  filled. Every fold opens with the same chevron. On a touch screen a field's
  text is 16px, so iOS no longer zooms in on it, and each button keeps a 44px
  target around its smaller look. On a phone the Settings and Command Center
  strips scroll to the page you are on. Fixed: a reminder's line in Coming up
  showed "· ·", and the Heartbeat day chips were underlined.
- Settings is simpler to scan. General and System prompt say "this
  workspace" instead of its id `default`, and the timezone explanation sits
  under **Timezone**. A model role's way back to the default says **Use
  default** (Embedding: **Clear**). Web search names a provider once.
  Credentials say what each stored key is for ("ollama API key", "Channel
  token"). Connected apps hides the search and filters while there are few
  apps that all work, and no longer badges each working app "Connected".
  Channels no longer repeats a connection's name under it; Allowed people
  lists who is allowed above the form to add someone. Plugins folds Tavi's
  built-in plugins and a long tool list under their counts, Permissions
  folds the rules shipped with Tavi under yours, Ideas says "Written by Tavi
  itself" and offers **Unmute every section** only while one is muted, and
  site recipes give their date as "Tue 17 Nov".
- The Command Center is easier to read. Long chat titles and answers end in
  "…" instead of stopping mid-word. Schedule's **Coming up** shows the next
  two days, with the rest of the week behind **Show the rest of the week**,
  separates "Added from" from a reminder's cadence, and says a to-do's due
  date as "Sat 21 Nov". Approvals no longer names a lone tool twice, ends the
  "after reading…" line with a full stop, and says "policy" once in History.
  Heartbeat shows only its switch while off, and no row of zeros before it
  has run. Browser folds sessions that never opened a page. Soul & memory
  and Settings → System prompt offer **Discard changes** only after an edit,
  and the new-routine form explains its first check in plain words.
- The chat panel on a phone can be dragged to any height between a quarter of
  the page and nearly all of it, and remembers it; a tap on its grip still
  moves between half and full. Its tabs are simpler: Schedule says which
  message **Set up a schedule…** would run again (it was **Repeat this…**,
  which did not say); Memory puts **Fresh context** and **Forget history…**
  under one **History**, and its link to the Command Center says **Review N
  proposals** when some wait; Activity no longer marks every turn
  "Follow-up", says a turn that asked you something was answered once you
  replied, and gives a run of decisions one time span; Instructions shows
  **Discard** only for an edit and **Clear** only for saved instructions;
  Details leads with turns, models (by name) and tokens, and folds the ids
  under **Technical details**.
- A chat's header is one line: its title and status, then its tools as icons
  at the far end — an amber shield for content it read that Tavi does not
  trust, a folder for its files, and its memory, raised while on. On a phone
  the status is a coloured dot.
- The canvas header no longer spells out the connection: Tavi's mark is in
  its colours when connected, grey when not, and breathes while it connects.
  At phone width the model picker sits between the attach and send buttons
  instead of across a row of its own, and its list is compact.
- Ideas are chosen for what Tavi knows of you, not only for words you
  happened to use: with a *Fast* model set, it first asks that model which
  ideas fit your interests (each resting on one thing you said), and those
  come first. Ideas now read your lessons and put your core facts and
  preferences ahead of newer passing details. They still never use your main
  chat model.
- A chat that was stuck answers your new message and stops there: it no longer
  goes back on its own to the earlier requests it never finished, each asking
  for approvals again. It says in a line which are not done and offers them.
- The Node.js floor is now 22.22.2 (it was 22.21.0): the test toolchain's
  jsdom needs it, and `pnpm install` refuses an older Node.

### Fixed

- Chatting with a local Ollama model works: its thinking, which Ollama streams
  in a field of its own, counts as output, so a model that thinks for minutes
  is no longer given up after 60 seconds, and a server on this computer gets
  ten minutes to read a long prompt before its first word. When a server reads
  far less of the prompt than was sent — Ollama runs at a 4,096-token context
  unless told otherwise, and silently cuts the rest — the turn fails with a
  note naming the setting to raise, instead of showing a reply to a question
  it never saw. The Ollama connection says the context it needs, and its
  **Manage** dialog no longer leads with an API key it does not take.
- The composer's model picker says which connection each model comes from
  when there are several, finds models by it, keeps naming the chat's model
  while a search hides it, and no longer jumps below the composer as a search
  narrows the list. A new chat started after a failed one offers **Send**, not
  the old chat's **Retry**, and the footer no longer shows the previous chat's
  elapsed time and tool calls.
- A model connection can be removed once it has discovered its models: its
  catalog goes with it (**Remove this connection…** and `tavi models remove`
  used to refuse any connection that had found a model). Removal is still
  refused while a role or the workspace default uses it, and the dialog now
  says so instead of promising a fallback.
- The canvas takes a photo (PNG or JPEG, up to 5 MB): it is uploaded when you
  send and the chat looks at it, as it does a photo from a messaging channel.
  A message shows its attached files as badges under your words; a text file
  no longer fills the bubble with its whole content: press its badge to read
  it in a dialog.
- A canvas tab whose `tavi ui` restarted can be signed in again: opening the
  new link in that same tab now loads the page with it, where it used to
  change only the address. Settings and other pages there say why they cannot
  load (open a new link) rather than "this client is closed".
- The **Chat folder** panel of a new chat no longer opens partly off the left
  edge of the window; a panel that opens by its button is moved back inside.
- Approvals in a chat that reads Bulgarian or Russian pages no longer all warn
  of "possible prompt injection (mixed-script)". The warning now needs Latin
  words forged with Cyrillic or Greek look-alike letters (such as a fake
  "paypal" or "google"). Cyrillic text that names Latin brands, has a Latin
  letter typed for a Cyrillic one, or runs two words together no longer
  triggers it.
- When your search provider answers "too many requests", Tavi stops asking it
  until the time it gives (a minute when it gives none, at most fifteen), and
  no longer asks you to approve searches that could only fail meanwhile. The
  model is told when it may search again, and answers from what it has.
- The built-in browser opens Google pages (Maps, Search, YouTube) again. Behind
  Tavi's egress proxy, every request on those sites stalled when Chromium sent
  it a second time with the client hints the site asked for, so the page never
  loaded and each browser call waited out the 2-minute tool timeout. A page
  that still does not answer now fails within seconds, saying so: a
  navigation with its own timeout, an observation when the page's scan gets no
  answer in 10 s, and a screenshot is skipped.
- The *keep in touch* idea asks which weekday or day of the month to remind
  you, the repeats a reminder can keep, instead of a free interval such as
  "every two weeks" that it then had to turn down.
- On a phone, an idea's **Try it** closes the chat's sheet, so the prompt it
  put in the box is in view instead of under the sheet. The Ideas tab's
  **For you** shows its four ideas two by two, not three and one alone.
- A message the model will not answer (it returns nothing, twice) is answered
  with a short note saying so and suggesting a rephrase or `/new`, instead of
  silence. On Telegram, a prompt injection and every message after it in that
  conversation had gone unanswered.
- A message the model declined is no longer sent to it with later messages:
  it stays in the chat's history, marked as declined, so the next message is
  answered normally rather than declined with it.
- A chat's **Held files** shows its files as cards: an approved screenshot or
  image as its picture, any other file with its type, size and review state in
  words, instead of a bulleted list of ids, MIME types and byte counts.
  Opening one shows the image in **Details**. `artifacts read` now also serves
  approved images (JPEG, PNG, WebP, up to 4 MiB) of the workspace.
- A chat no longer stops answering after a message arrives while it waits for
  you: a browser handoff (a captcha, a sign-in) or a call waiting for
  approval. The new message is answered, the waiting call is recorded as not
  run, and a handoff is cancelled with the page handed back. Before, the model
  was sent a call with no result, the provider refused it, and every later
  message in that chat failed. Chats already stuck this way answer again.
- Pairing or allowing someone on a channel now says plainly what changed:
  "You're paired: your messages on this channel now reach Tavi."
- The browser refuses a click on a captcha embedded in an ordinary page (a
  Turnstile or reCAPTCHA box beside a form), by element or by sight, as it
  already did on a page that is only a captcha; it is handed to you.
- A chat whose turn waited for a file's review (a browser screenshot) no
  longer stops answering: a new message goes on without the file, which stays
  waiting in **Held files**. On Telegram and other channels, the chat is told
  when a turn waits on a review and where to give it; before, it went silent.
- A Telegram approval keeps each line of a call's details (a form's fields)
  under that call, and says when it expires in words (`Wed 18 Nov, 09:39 UTC`)
  instead of a raw timestamp.
- After a chat has read web content, a page on a site it has seen or you
  allowed opens without asking when its path is one your message names
  (`/login`, `/dynamic_loading/2`) and it has no query or fragment. Before,
  only an exact full URL counted, so naming pages by path asked about each.
- An approval for a press says what that button can do ("can send or submit
  something" for a **Confirm**, "can pay, book or order" for **Place order**)
  instead of calling every such press a payment. An approval card with several
  calls says **Allow all** where it said **Allow the rest**.
- The folded sidebar (as on a phone) offers **New chat** beside **+**, so a
  clean chat, without the side chat's carried-over untrusted content, is a tap
  away; **+**'s tooltip says what a side chat carries on.
- On a phone, the page under the open chat panel scrolls its last rows (and
  buttons such as **Refresh**) clear of the panel instead of stopping behind
  it.

- A chat on Telegram (or any channel) can be sent back a file it asked for:
  `messaging.send` takes an approved artifact, such as a browser screenshot,
  with its text as the caption. Before, a screenshot asked for in a Telegram
  chat could not be sent at all.
- `messaging.send_to` that names no one, or a target the allowlist refuses, is
  refused before anyone is asked to approve it; it used to be approved and
  then fail.
- Telegram shows a picture in the chat as a photo, not a file to download;
  one too long to draw goes as a document, as before.

- `pnpm install` installs the Chromium the browser uses, and the newer one a
  Playwright update wants (the root `postinstall`; skipped in CI and with
  `TAVI_SKIP_CHROMIUM=1`). Chromium used to be a step of its own, so an
  update could leave the browser without one, and no chat was offered it.

- `tavi doctor` says whether the browser has a Chromium to launch
  (`browser.chromium`), and how to install one when it does not
  (`browser.install`). Without one, a chat is never offered the browser's
  tools, as after a Playwright update that wants a newer Chromium; until now
  nothing said why.
- Settings → Channels, from the Mac mini Telegram tests:
  - The page reads its connections again every 15 seconds, so a connection's
    state and its last message stay current while it is open.
  - "last message in" now reads "last message received".
  - Save webhooks is off until something is changed.
  - Pairing brings the code into view, and says Pair with a code waits on
    This is me or a Person ID.
  - The time a pairing was last checked is on the 24-hour clock, as its
    expiry is.

- A picture a model provider will not take, one over 8000 pixels on a side
  or one whose header is damaged (a PNG signature followed by text), passed
  `artifacts.view_image` and then failed the model call, and every later one
  in that chat. `view_image` now refuses such a picture and says why. A
  picture already in a chat's history is left out of the request instead of
  failing it, so a chat broken this way works again.
- A schedule or agent name could hold a tab, a line break or a terminal
  escape sequence, which `tavi schedules list` and `tavi agents list` printed
  raw. A new name must be one line of text; names already stored still read.
- `tavi agents add` accepted an id that differed from another only in case
  (`RESEARCHER` beside `researcher`) and a display name another agent had,
  so a chat could not tell the two apart. Both are now refused, as is
  renaming an agent to another's name. When `agents.spawn` refuses an agent
  it does not know, the list it gives now shows each agent's name beside
  its id.
- `tavi run --folder ""` ran in the current directory. An empty `--folder`
  is now a usage error.
- `tavi skills approve` said "no skill X@v here" where `reject` and
  `activate` said "Skill X@v does not exist"; all three now say the latter.
  A folder file over a tool's size cap no longer says the cap is "for a file
  sent out".
- Web UI:
  - The video retention form in Settings → General saved with a plain
    button that could be pressed before anything changed. Its Save is now
    the page's green button, enabled only for a new number in range.
  - Settings pages short enough not to scroll sat 4 px to the right of
    long ones, as did the Command Center, Ideas and the transcript. Each
    page now keeps its scrollbar's room.
  - A Plugins card with a long description dropped its Disable and Remove
    buttons under the text, at the left. The buttons now stay at the
    right, as on a short card, until the window is too narrow for both.
  - The Ideas brief in Settings was set in the code font, because a rule
    meant for the system prompt editor caught every text box in Settings.
  - A checkbox in a line of text sat 2–3 px above its words; it is now
    centred on them.
  - A reminder card in the Command Center opened with an emoji alarm
    clock, which the canvas draws nowhere else (the section already has its
    bell). Its Done button now has its own row with the two snoozes side by
    side under it; before, one snooze wrapped onto a line of its own.
  - Opening a Command Center section kept the scroll position of the one
    before it, so Soul & memory could open halfway down with its heading out
    of sight. Each section now opens at its top.
  - "Loading…" while a page's code arrives sat in the top-left corner; it
    is now spaced as the page's other notices are.
  - The "disconnected" line under the bar ran into the window's edge and
    into its own advice ("…finds one Press Enter…"). It is now in from the
    edge, and the owner's reason ends with a full stop.
- Tavi could not look at a picture in the chat's folder: `artifacts.view_image`
  opened only attachments, so "Look at lisbon.jpg" in a run under `--fs-root`
  ended in shell commands and no description. It now also takes a `path` in
  the chat's folders, read as `fs.read` reads it and typed by its bytes, and
  the copy it shows keeps the label `fs.read` would give the file.
- A schedule's prompt such as "Remind me to stand up and stretch." (the
  schedule guide's own example) set a one-off reminder for an hour later at
  every fire instead of reminding you. Every fire's run is now told it is the
  schedule doing its job, so the reminder is in its answer.
- A chat that started a worker as "Researcher" was refused with "No agent
  definition Researcher": `agents.spawn` now takes an agent's id in any case,
  or its name.
- `tavi skills approve <skill>`, `reject` and `activate` needed `--version`
  even when the skill had only the one version. Without it they now take the
  only proposed (or, for `activate`, approved) version, and list the versions
  when there are none or several.
- `tavi onboard`'s questions are drawn in a terminal where `CI` is set: Ink
  took that to mean "print only the last frame", so the prompt never showed.
- A plugin worker whose proxy CA came due for renewal while it was starting
  was stopped as soon as it was ready, failing the call that started it. That
  call is answered first, and the worker restarts after it.
- On Linux, a PDF read in the owner's first moments, before its sandbox check
  had answered, was tried in the sandbox: on a host without a working one it
  failed as a crash, the document was refused for a day, and
  `--pdf-allow-unconfined` had no effect. A PDF call now waits for that first
  answer.
- A tool call whose arguments were not JSON (a model writing a list without
  its brackets, say) was answered "expected object, received string". It is
  now told the arguments are not one JSON object, where they broke, and to send
  them again as one, so the model corrects the call on its retry.
- While Playwright's Chromium is not installed, the browser's tools are not
  offered: a chat asked to look something up went to the browser, asked you to
  approve it, and failed. It now goes to web search and `web_fetch`; install
  Chromium and the browser's tools are offered within half a minute.
- A browser call that failed because Chromium was missing marked the chat as
  having read a web page, though none opened, so later calls asked again.
- The card asking to open the browser names the page, not only its site
  ("Use the browser to open nodejs.org/en/download"), so two pages on one site
  no longer look like the same question asked twice.
- A call Tavi refused before it ran (a sandbox run asking for a domain it may
  not ask for, an unapproved call, a repeated one) had no line in the chat or
  its Trajectory, so a reply that said "the sandbox refused the fetch" looked
  made up. It now shows as a failed call, with what was asked. A call you denied
  keeps its approval card, marked denied, and no call line: nothing ran.
- A chat that handed a task to a worker could only name the browser worker,
  the one built-in agent, so a vowel count went to the browser while Chromium
  was missing. Every workspace now has a general `worker` agent, and the
  browser worker is offered only while the browser can open.
- On macOS every sandboxed `python3` (or `git`, `make`, …) printed
  "couldn't create cache file … xcrun_db" to stderr, which the model then had
  to explain. The owner fills xcrun's cache for these tools when it starts.
- At narrow widths the chat's tool lines broke words mid-way ("sandbox.r un",
  "faile d"): the tool name and its status keep whole, and the headline wraps.
- `tavi run --approval approve` printed a call a person must decide (a form
  fill, a forget) as "denied by --approval deny". It now says it was denied as
  a person must decide it and nobody attends the run.
- The skills list in Soul & memory showed a proposal twice, a skill's name
  twice, a review button that looked like grey text, and "(not yours)" with a
  raw `chat:task-…` id. A proposal shows once, under its skill, with a Review
  button, and its source reads "proposed by Tavi in a chat".
- A routine's run marked "degraded" said nowhere why: `routines.inspect` now
  answers the reasons (`publication.gaps`) and the report itself as text, so
  the chat can read it (it was refused as not found). A weekly or monthly
  routine's report looks back over its whole period (up to 8 days), not only
  the last 72 hours, so it no longer reports days it skipped as gaps.
- `tavi run` under `tavi serve` exited with code 7 ("waiting on worker task")
  while the chat waited on its worker, so the answer never showed. It now
  follows the task until the worker answers and the chat replies.
- `tavi tasks` and `tavi doctor` print text at a terminal (JSON in a pipe, or
  with `--format json`): a task a line, and a summary of each check. `tavi
  memory list` and `proposals` end each row with the record's title.
- A rate-limited web search (429) was reported to the model as a call that
  "may have run", so it checked and retried at once. A search the provider
  refused ran nothing: it is now said to be retryable after a wait.
- Desktop control without the Accessibility permission read every window as
  empty and failed each action as "could not be resolved". `desktop.observe`
  and `desktop.act` now refuse at once, saying to grant Accessibility to the
  terminal that started `tavi serve` and restart it, and the chat is not
  marked as having read an app's screen.
- `desktop.observe` of an app not in `desktop.grantedApps` (the app in front,
  when none was named) said only "is not granted. Do not retry.". It now names
  the granted apps, so the model can look at one of them or ask you to add it.
- Typing or pressing a key with `desktop.act` while the app it named was not
  in front was refused as "Target element or application could not be
  resolved". It now says where the keys would have gone (the app with focus,
  or the app in front when no focus can be read) and to bring the app forward.
- On macOS, typing into TextEdit with its document focused and in front was
  refused because the system-wide query for keyboard focus answered nothing.
  The desktop helper now asks the app in front for its focused element when
  that query is empty. Rebuild the helper (the refusal prints the commands)
  to pick it up.
- `desktop.act`'s report after typing or a key press read the field while the
  app was still taking the keys in, so "Hello from Tavi" came back as "Hello
  from". It now waits, briefly, for the field to settle before reading it.
- With an app granted by its bundle id (`desktop.grantedApps =
  com.apple.TextEdit`), a `desktop.act` that named it only as "TextEdit",
  before any `desktop.observe`, was refused as "not granted desktop control in
  this workspace". The name is now matched to the running app's bundle id.
- On macOS the desktop helper kept taking the app that was in front when it
  started (the Terminal that ran `tavi serve`) as the app in front, so keys
  for TextEdit were refused as "Keyboard focus is in Terminal" and
  `desktop.observe` reported TextEdit as not active. It now asks which app is
  in front at each call. Rebuild the helper to pick it up.
- In a freshly started owner, a `desktop.act` before any `desktop.observe` was
  refused as "not granted desktop control in this workspace" for a granted
  app: its card read the grants before they were loaded. They are loaded then,
  and the gate still refuses an app they do not grant before it acts.
- A desktop action the gate refused showed as "desktop.act done". It now shows
  as a failed call, with the gate's reason.
- A desktop action's card asked "Why am I asked?" with "changes something that
  lasts beyond this chat (a routine, a reminder, a rule, a file)", wrong for a
  keypress. It now says the call clicks, types or presses keys in an app on
  your computer.
- `sandbox.run` refused `echo` with the argument `rm -rf /` as deleting the
  root directory: an argument was read as if unquoted. It is read as the shell
  would read it, as `echo "rm -rf /"` already was; `rm -rf /` itself is still
  refused.
- `tavi run`'s `[approval]` lines and `tavi approvals show` did not say what
  flagged a call, such as a guard mod's reasons ("acme.guard: …"). Both now
  print a `Flagged:` line, as the terminal UI's card does.
- A chat's shell could not run the owner's own Node when it was installed by
  hand under your home folder (`~/.local/node`, say) rather than by a version
  manager. That install is now readable in the sandbox when its `bin` is on
  `PATH`.
- The Plugins settings page and the model's plugin authoring guide said an
  approved plugin runs inside the owner with its privileges. An approved
  plugin runs as a confined worker; only one approved `--in-process` runs in
  the owner's process.
- The refusal printed while the desktop helper is not built now says what to
  do when `swiftc` stops at "redefinition of module 'SwiftBridging'" with the
  Swift 6.1 Command Line Tools ([DESKTOP.md](docs/DESKTOP.md#build-the-helper-with-the-command-line-tools)).

## 0.1.0 — first release

The first release published under the MIT licence. Tavi runs from a clone of
this repository: there is no npm package.

### Added

- **A new look for the web canvas**: the Pine & Sun palette, Bricolage
  Grotesque as the display face, the sprout mark and wordmark, a floating
  composer, a greeting on a new chat, and small moments of motion.
- **Smarter schedules**: one cadence engine (several times a day, every N
  hours, monthly, yearly, once, until), cheap pre-checks that skip the model
  call when nothing changed, watchers, webhook triggers and email triggers,
  per-fire and monthly token budgets, retries for transient failures, a fire
  ledger, and notifications only when there is something to say. Schedules and
  routines can be created and changed from a chat, and "Repeat this…" turns a
  chat that worked into a draft.
- **To-dos** (`tavi todos`, the `todos.*` tools) that work with no setup and
  defer to a task app connected over MCP (`tasks.home`).
- **Skills**: importing Agent Skills packages, skills the agent proposes for
  review, on-demand loading (`skills.read`, `skills.search`), use counts, and
  `allowed-tools` as a ceiling, never a grant.
- **Experimental desktop control** on macOS (`tavi.desktop`, off until
  enabled).
- **Browser**: site recipes that can replay, site notes, long forms filled in
  one `browser.batch`, tabs, frames, downloads, page dialogs, an opt-in
  agent signature, and a model's own computer-use tool for acting by sight.
- **Memory**: forget and replace from a chat, past facts on request, recency
  and confirmation in recall ranking, and an always-in-context profile.
- **Models**: native Anthropic Messages connections, and provider failover
  when a stream stalls (`--first-byte-timeout`, `--idle-timeout`).
- **Tools**: `math.eval`, `artifacts.read`, paged `web_fetch`, a richer
  `http.request` and file tools, and `sandbox.run` lines approved command by
  command.
- The owner watches its own memory, descriptors and children; `tavi doctor`
  and the Activity view warn on sustained growth. Offline `tavi doctor` runs
  SQLite's quick integrity check, and the full one with `--deep`.
- A new data directory keeps its credential key in the OS keychain, so
  credentials are encrypted from the start; `tavi credentials key` moves it.

### Changed

- An idle owner sleeps until its next due work, and the Command Center updates
  on writes instead of polling.
- Image, document and video bodies sent to a model are kept between steps.
- Commands load their handlers only when they run; past-chat search, the
  database's hot queries and the web canvas's first load are faster.
- The lean tool layout is the default: rarely used families wait behind
  `tools.search` (`models.toolDeferral`).
- A Node.js older than 22 gets an upgrade message before the CLI loads, and
  `pnpm install` refuses it; the floor stays 22.21.0.
- **Settings** has its own grouped navigation (Workspace, Connections,
  Control) in the left column instead of a row of tabs.
- The Command Center shows "Coming up" once on Schedule; the heartbeat's
  on/off control is a switch.
- The chat composer grows with what you type; the footer strip names the model
  by its own name (`Model: gemini-3.8-flash`); a grouped approval offers
  **Allow once**, with its explanation behind "What does this allow?".
- Empty states say what is true: the chats list ("No chats yet", "No archived
  chats"), Connected apps, and Plugins, which folds its core built-ins under
  "Core (always on)".
- `tavi schedules agenda` and `tavi todos list` print aligned columns, the id
  last.
- Smaller fixes from the same review: a plugin nobody has approved says
  "awaits review" rather than "disabled" and "not composed"; a refused key,
  Welcome and Settings link to the provider's page for creating a key rather
  than its API reference; a chat's later turns no longer say "Continues chat"
  with an internal id; System prompt's Save says "use the shipped default"
  only when that is the change. A chat with no title and no prompt is
  "Untitled chat" (one replayed after a reload, "Earlier chat") in its header,
  the chats list and Activity, never its task id. A round `tavi run
  --approval deny` refused says "automatic denial (--approval deny)", in the
  terminal and the canvas, not "automatic approval".

### Fixed and hardened

- Turning a plugin off no longer leaves the model or the person pointed at it.
  `tavi.localmessaging` is core, since the terminal's and canvas's chats go
  through it. Flight search, `web_fetch`, `http.request`, site notes and
  desktop control name the browser's tools only while the browser is on.
  `tavi onboard` names no particular channel or app, and the built-in
  onboarding flow offers the installed channels when Telegram is not one of
  them. Settings → General and Settings → Models hide the browser, flight
  search and video settings while their plugin is off. A plugin tool can
  declare `requiresTools`, so a tool that needs the browser is offered only
  while the browser is on (jobs' `fill_plan`, trends' `profile` and `ingest`,
  places' `reconcile`).
- The shell approval reads command lines the way `/bin/sh` does, cross-checked
  by a second parser; home and root deletes are refused in every spelling.
- `http.request` dials only a pinned public address; the browser holds every
  approved call to its host, including frames on other sites.
- A Gmail sender is verified only by an aligned DKIM signature; channel
  ingress budgets are per address.
- Forgotten text leaves no bytes behind in the database or its write-ahead
  log.
- When the agent tried to close a browser session's last tab, the refusal named
  `browser.close_session`, a tool that does not exist; it names `browser.close`.
- `tavi projects --help` no longer offers `--google-service-account-ref`, which
  no action accepted; `projects.json` carries that setting.
- Routines work on models that wrap their JSON in a Markdown fence, such as
  gemini-3.8-flash: the activation check read every such answer as malformed,
  so the routine never activated. One dropped or retryable provider answer no
  longer fails the check, and a new routine's run may make 12 model calls
  instead of 5, so research that searches one query a turn finishes. A
  routine made before is raised to 12 once, on the owner's next start, by a
  revision Tavi saves (archived routines, and ones whose latest revision
  failed its check, keep 5). Research's last call within its budget writes up
  what it found instead of being refused, and a failed run's page says why.
- A turn that spent nearly all its steps on tool calls could end on the
  workflow engine's own recursion limit ("Recursion limit of 41 reached")
  before its last step, which answers with what it gathered.
- Settings → Models no longer says the Embedding role uses the default: it is
  unset until bound, and memory search matches words only until then.
- On a phone, the composer's model picker gets its own row and the footer
  strip no longer runs off the screen.
- Many browser, schedule and routine fixes.

### Documentation

- A guide to the daily brief ([REPORTS.md](docs/REPORTS.md)), the owner's IPC
  messages ([IPC.md](docs/IPC.md)), a catalogue of every built-in tool, an index
  of the docs ([docs/README.md](docs/README.md)) and of the examples.
- Screenshots of the web canvas and the terminal, diagrams of the main
  mechanisms, and a banner; `scripts/docs/` retakes them.
- CLI.md covers every command and flag `--help` offers, and a test keeps it so.
