/**
 * The `core` words of the built-in plugins a person reads, in English: each
 * built-in's description in the plugin list, the built-in onboarding flow,
 * the built-in channels' setup words, the guard's approval reasons, the flight
 * search's approval card and the daily brief's PDF. What the model reads (tool
 * descriptions, schemas, prompts, refusals) is never here: it stays English.
 */
export const plugins = {
  // ——— Each built-in's description, as the plugin list shows it (`plugins.catalog.<plugin id>`).
  "plugins.catalog.tavi.providerreadiness": "Activates reviewed provider instances before admissions open.",
  "plugins.catalog.tavi.providers": "Account-scoped search, fetch and model provider factories.",
  "plugins.catalog.tavi.logger": "Structured logging for every other plugin.",
  "plugins.catalog.tavi.persistence": "The SQLite store and data-directory ownership.",
  "plugins.catalog.tavi.tools": "The tool registry the workflow offers to models.",
  "plugins.catalog.tavi.access": "Workspace access policy and permission checks.",
  "plugins.catalog.tavi.clock": "The shared clock.",
  "mods.reads.everyTool": "every tool",
  "mods.reads.fromSources": "from {sources}",
  "mods.reads.onChannels": "on {channels}",
  "mods.reads.scope": " (turns {where})",
  "mods.reads.everyWorkspace": "It sees this in every workspace.",
  "mods.reads.toolInput": "Sees the input of {tools}{scope}, and can refuse the call.",
  "mods.reads.toolResult": "Sees and can change the output of {tools}{scope}.",
  "mods.reads.prompt": "Reads every prompt and every message you receive{scope}, and can add to it or drop it.{trusted}",
  "mods.reads.everyChannel": ", on every channel",
  "mods.reads.trustedContext": "What it adds is trusted context: it does not mark the chat as holding untrusted content.",
  "mods.reads.modelStep": "Sees each model call as it starts: its step and its model{scope}.",
  "mods.reads.turn": "Sees when each turn starts and ends, and its token usage{scope}.",
  "mods.reads.heartbeatTick": "Sees when each heartbeat check runs and how it ended.",
  "mods.reads.heartbeatItem":
    "Sees each heartbeat item's key, title, urgency, sources and signal keys, with the check's time and your timezone, and can hold it back for good or make it wait for the summary.",
  "plugins.catalog.tavi.router": "Jev (TypeSafe) routing provider. Routing stays off until configured with `tavi router`.",
  "plugins.catalog.tavi.models": "Model connections (composed when a model connection is configured).",
  "plugins.catalog.tavi.workflow": "The task workflow engine (composed when a model connection is configured).",
  "plugins.catalog.tavi.retention": "Six-hourly retention sweep of finished transport rows (serve only).",
  "plugins.catalog.tavi.agentwaitscheduler": "Wakes tasks waiting on agent replies.",
  "plugins.catalog.tavi.schedules": "Fires recurring unattended schedules.",
  "plugins.catalog.tavi.ideas":
    "The ideas host: looks for new ideas once a day inside each workspace's hours, and answers /ideas (serve only). Disabling it stops the daily run; a refresh still works.",
  "plugins.catalog.tavi.heartbeat":
    "The heartbeat host: wakes each heartbeat inside its active hours, runs its cheap checks before any model call, and keeps its log (serve only). Disabling it stops every heartbeat.",
  "plugins.catalog.tavi.heartbeatagent":
    "The built-in heartbeat provider: one short, metered, read-only model turn on the fast model each check, telling you only what it reports (serve only). Disabling it pauses heartbeats that use it.",
  "plugins.catalog.tavi.ideasagent":
    'The built-in ideas provider: ranks the use-case catalogue by what Tavi can do here and what you mentioned, and has your fast model reword the ones that fit you, within the day\'s ideas budget. A plugin with provides: ["ideas"] can replace it per workspace; disabling it skips the runs of workspaces that use it.',
  "plugins.catalog.tavi.onboarding":
    'The built-in onboarding flow: the steps tavi onboard, tavi setup and the canvas\'s Welcome walk — a model first, then you, apps, channels, search, keeping Tavi running and a first idea. A plugin with provides: ["onboarding"] can replace it; disabling it leaves the setup checklist with the command for each open step.',
  "plugins.catalog.tavi.heartbeatsignals":
    "The heartbeat's built-in signal sources: what waits on you, what is coming up, failed schedules and routine runs, channels needing attention, held messages, messages left unanswered, sends that failed, watched pages, and chat folders or the disk filling up (serve only).",
  "plugins.catalog.tavi.memoryprovider":
    "The built-in memory provider: ranks what memory recalls for turns, the memory.search tool and heartbeat checks with Tavi's own index, drafts the idle review's and the epoch flush's proposals, and drafts weekly tidy-up suggestions when a workspace turns them on. It is what any other provider falls back to; disabled, with no other chosen, recall is the host's own search and nothing drafts proposals.",
  "plugins.catalog.tavi.memory":
    "The memory host: the chat commands /remember, /forget, /memory and /why, in the app, the terminal and direct chats, and the weekly review digest (serve only). Disabling it withdraws them and stops the digest, the idle review, weekly tidy-ups and the vector backfill; recall, proposals and provider removals keep working.",
  "plugins.catalog.tavi.reminderrule":
    "Seeds each workspace once with the allow rule for the reminder tools; a revoked rule is not put back.",
  "plugins.catalog.tavi.reminders":
    "Fires reminders when they are due, with their buttons; a text-only reminder needs no model connection.",
  "plugins.catalog.tavi.tasksummaries":
    "Writes each task's title and summary in its own loop, one call at a time, never on the path that finishes a task.",
  "plugins.catalog.tavi.localmessaging":
    "The local connection each workspace's terminal and canvas chats go through: core, since without it no message typed there reaches a task.",
  "plugins.catalog.tavi.channelhost":
    "Opens the saved connections of every installed channel, built-in or a plugin's, and applies Settings changes live; each channel is its own plugin.",
  "plugins.catalog.tavi.telegram": "The Telegram channel: a bot you message, paired to you.",
  "plugins.catalog.tavi.mailgun": "The email channel over Mailgun: inbound routes and outbound sending.",
  "plugins.catalog.tavi.gmail": "The Gmail channel: your mailbox, read and drafted with your approval.",
  "plugins.catalog.tavi.flights":
    "travel.flights_search: flight search over Kiwi.com's public MCP server, before browsing, with Google Flights and Kayak links.",
  "plugins.catalog.tavi.browser":
    "The agent's browser engine and its browser.* tools. Disabled, the agent has no browser from the next start; a replacement engine is an embedder's composition option, never a plugin.",
  "plugins.catalog.tavi.pdf":
    "Reading and filling PDFs (pdf.* tools), each document parsed in a confined, single-use process. Disabled, the pdf tools are not offered from the next start.",
  "plugins.catalog.tavi.video":
    "Understanding videos and voice messages with the person's own FFmpeg (video.* and audio.transcribe), each read in a confined, capped run. Disabled, the video tools are not offered from the next start, and a voice message is kept but not transcribed.",
  "plugins.catalog.tavi.sandbox":
    "The confinement every plugin worker, sandbox.run, the PDF parser and video reads run under. Core: it cannot be disabled, nor replaced by a plugin, since it confines every plugin.",
  "plugins.catalog.tavi.limits":
    "The CPU, memory and time limits confined runs get. Core: it cannot be disabled, nor replaced by a plugin.",
  "plugins.catalog.tavi.worker":
    "The worker processes approved plugins run in, through the confinement. Core: it cannot be disabled, nor replaced by a plugin.",
  "plugins.catalog.tavi.siteskills":
    "What is known of sites an agent often browses (Google Flights, Kayak, Skyscanner, Booking.com, Google Maps), carried on a first observation.",
  "plugins.catalog.tavi.collectors":
    "The daily brief's collectors (projects, GA4, Search Console, GCP billing, Stripe, news) and its report tools (reports.generate, reports.history).",
  "plugins.catalog.tavi.desktop":
    "Experimental, macOS only: desktop.* tools that see and act in the apps a workspace grants (desktop.grantedApps), every action asked about in an attended run. Off until enabled; its helper is built once on the Mac it runs on.",
  "plugins.catalog.tavi.guard":
    "Asks before shell commands that delete or overwrite files, and says what they would touch; refuses them where nobody can approve. Off until enabled.",

  // ——— The built-in onboarding flow (`tavi.onboarding`).
  "plugins.onboarding.title": "Welcome to Tavi",
  "plugins.onboarding.model.title": "Choose the model Tavi thinks with",
  "plugins.onboarding.model.body":
    "Tavi needs one model to answer you. A cloud provider takes a key and bills per use; OpenRouter is one key for many models. A model on this computer (Ollama, LM Studio) is free and private, but small ones handle agent work less well.\nThe key is stored in Tavi's credentials file on this computer, never in a chat.",
  "plugins.onboarding.about.title": "About you",
  "plugins.onboarding.about.body":
    "Your name and time zone, so Tavi addresses you and says times in your zone. They are saved in this workspace's settings and, when memory is on, as two preferences you can see and forget.",
  "plugins.onboarding.apps.title": "Connect an app",
  "plugins.onboarding.apps.body":
    "Let Tavi read your mail or calendar to help with them. Each app says what it reads; anything that sends or changes something asks you first.",
  "plugins.onboarding.tasks.title": "Where do you keep tasks?",
  "plugins.onboarding.tasks.body":
    "Tavi keeps a to-do list of its own that works everywhere you reach it, with nothing to set up. If you already keep tasks in an app such as Todoist, connect it and Tavi adds to that instead; nothing is copied between the two.",
  "plugins.onboarding.channels.title": "Message Tavi from your phone",
  "plugins.onboarding.channels.body": "Reach Tavi from a chat app. You pair yourself with a one-time code; strangers are never answered.",
  "plugins.onboarding.voice.title": "Understand voice messages",
  "plugins.onboarding.voice.body":
    "Send Tavi a voice message and it is turned into text on this computer: nothing you say leaves it. That takes FFmpeg and whisper.cpp, which Homebrew installs as your user (never with sudo), and Whisper's base speech model (about 148 MB, MIT licence) from Hugging Face, kept only when its checksum matches.",
  "plugins.onboarding.search.title": "Web search",
  "plugins.onboarding.search.body":
    "A search provider lets Tavi look things up. Most need a key of their own; Tavily can start without one, and SearXNG needs only its address.",
  "plugins.onboarding.service.title": "Keep Tavi running",
  "plugins.onboarding.service.body":
    "Channels, reminders and schedules work only while tavi serve runs. Tavi can start it with your computer, as your user, never with sudo.",
  "plugins.onboarding.ideas.title": "Try something",
  "plugins.onboarding.ideas.body": "A first thing to ask, from what Tavi can do here now. Nothing is sent until you send it.",
  "plugins.onboarding.ideas.week.label": "Plan my week",
  "plugins.onboarding.ideas.week.prompt": "Help me plan my week: ask me what I have on, then suggest a simple schedule.",
  "plugins.onboarding.ideas.research.label": "Research a topic",
  "plugins.onboarding.ideas.research.prompt": "Research a topic for me and give me a short summary with sources. Ask me which topic first.",
  "plugins.onboarding.ideas.remind.label": "Remind me later",
  "plugins.onboarding.ideas.remind.prompt": "Remind me tomorrow at 9:00 to check what I asked you today.",
  "plugins.onboarding.done.title": "You're set up",
  "plugins.onboarding.done.body": "Ask Tavi anything. Steps you skipped stay on the Home checklist and in tavi onboard.",

  // ——— Telegram's setup words (`tavi.telegram`).
  "plugins.telegram.app.summary": "Chat with Tavi from Telegram through a bot you create.",
  "plugins.telegram.description": "Chat with the agent through a Telegram bot.",
  "plugins.telegram.token.label": "Bot token",
  "plugins.telegram.token.help": "From @BotFather: /newbot, then copy the token it gives you.",
  "plugins.telegram.sender.label": "Telegram user ID",
  "plugins.telegram.target.label": "Chat ID",
  "plugins.telegram.target.help":
    "To message someone directly, enter their Telegram user ID: a private chat's ID is the user's. A group's chat ID is negative. They must have messaged the bot first.",
  "plugins.telegram.pairing.open": "Open in Telegram",
  "plugins.telegram.setupHelp":
    "Create a bot with @BotFather: send it /newbot, pick a name and a username ending in bot, and paste the token it answers with. Then pair yourself with a one-time code.",
  "plugins.telegram.setupLink": "Open @BotFather",

  // ——— Gmail's setup words (`tavi.gmail`): the Google account in Connected apps.
  "plugins.gmail.description":
    "Email the agent through your own Gmail account: it reads only mail you label, and replies from your address.",
  "plugins.gmail.label.label": "Label to read",
  "plugins.gmail.label.help":
    "Only mail with this Gmail label reaches the agent; give it with a filter (for example, mail to you+tavi@gmail.com). Each message read is labelled <label>-processed.",
  "plugins.gmail.receive.label": "Reach Tavi by email",
  "plugins.gmail.receive.help":
    "Take in mail with the label, and answer it from your address. Off, the account only carries its mailbox's and calendar's tools.",
  "plugins.gmail.address": "Email address",
  "plugins.gmail.app.summary": "Your Google account: its calendar and Gmail, each turned on by you, and Tavi reached by email.",
  "plugins.gmail.scope.email": "See your Google account's email address",
  "plugins.gmail.scope.mail": "Read and label your mail, write drafts, and send as you (only while Gmail is on)",
  "plugins.gmail.scope.calendar": "See your calendars and free time, and add or change events (only while the calendar is on)",
  "plugins.gmail.setupHelp":
    "Set up Google once from Connected apps (Set up Google): a Google Cloud project of your own with the Gmail and Calendar APIs, a published consent screen, and an OAuth client of type Desktop app, whose downloaded JSON you drop there; or enter its client ID and secret here. Your other Google apps use the same client. An app left in Testing signs in for 7 days at a time. Mail sent through this channel goes out as you, from your address, into your Sent folder.",

  // ——— Mailgun's setup words (`tavi.mailgun`).
  "plugins.mailgun.app.name": "Email (Mailgun)",
  "plugins.mailgun.app.summary": "Reach Tavi by email on a domain you send with through Mailgun.",
  "plugins.mailgun.label": "Email",
  "plugins.mailgun.description": "Email the agent through a Mailgun domain and inbound route.",
  "plugins.mailgun.domain.label": "Sending domain",
  "plugins.mailgun.from.label": "Sender address",
  "plugins.mailgun.from.help": "An address on the sending domain; tavi@<domain> when empty.",
  "plugins.mailgun.region.label": "Region",
  "plugins.mailgun.region.help":
    "The region the domain was created in, as Mailgun → Domains shows it: eu is reached at api.eu.mailgun.net.",
  "plugins.mailgun.apiKey.label": "API key",
  "plugins.mailgun.apiKey.help": "Mailgun → API Security → a sending key for this domain.",
  "plugins.mailgun.signingKey.label": "Webhook signing key",
  "plugins.mailgun.signingKey.help": "Mailgun → Webhooks → HTTP webhook signing key: a separate secret from the API key.",
  "plugins.mailgun.address": "Email address",
  "plugins.mailgun.setupHelp":
    "Add a Mailgun inbound route that forwards to this connection's webhook address (behind your https reverse proxy), and allow each sender's address in Allowed people.",

  // ——— The guard (`tavi.guard`): what its hook discloses, and why it asks, as an approval card says it.
  "plugins.guard.disclosure": "Asks before a shell command that deletes or overwrites files, and says what it would touch.",
  "plugins.guard.reason": "This command {does}.",
  "plugins.guard.reasonPaths": "This command {does}: {paths}.",
  "plugins.guard.does.overwrite": "overwrites a file",
  "plugins.guard.does.dropDatabase": "drops database objects",
  "plugins.guard.does.removeRecursive": "deletes files and folders recursively",
  "plugins.guard.does.openToEveryone": "opens every file to everyone",
  "plugins.guard.does.overwriteDevice": "overwrites a file or device",
  "plugins.guard.does.format": "formats a disk",
  "plugins.guard.does.findDelete": "deletes the files it finds",
  "plugins.guard.does.truncate": "cuts files short",
  "plugins.guard.does.gitReset": "discards uncommitted work",
  "plugins.guard.does.gitClean": "deletes untracked files",

  // ——— Flight search's approval card (`tavi.flights`).
  "plugins.flights.approval.title": "Search flights {from} → {to}",
  "plugins.flights.approval.detail":
    "Sends the trip (places, dates, passengers) to Kiwi.com's flight search, and to Google Flights where that is on",
  "plugins.flights.approval.reason": "sends the trip to Kiwi.com's flight search and to Google Flights",

  // ——— The daily brief's PDF (`tavi.collectors`): its frame; metric labels and notes are the collectors' data.
  "plugins.collectors.brief.title": "Daily brief",
  "plugins.collectors.brief.heading": "Daily brief — all projects",
  /** English has always said "project(s)", whatever the count. */
  "plugins.collectors.brief.meta": { other: "Period {start} → {end} · generated {generatedAt} · {count} project(s)" },
  "plugins.collectors.brief.crossProject": "Cross-project",
  "plugins.collectors.brief.sessions": "Sessions",
  "plugins.collectors.brief.mrr": "MRR",
  "plugins.collectors.brief.revenue": "Paid revenue",
  "plugins.collectors.brief.metric": "Metric",
  "plugins.collectors.brief.source": "Source",
  "plugins.collectors.brief.value": "Value",
  "plugins.collectors.brief.news": "News",
  "plugins.collectors.brief.noNews": "No news items matched this project's keywords.",
  "plugins.collectors.brief.noMetrics": "No metrics were collected for this project.",
  "plugins.collectors.brief.dataQuality": "Data quality",
  // A plugin's chat command (`/name`) that could not run, answered to whoever typed it.
  "plugins.command.suspended": "/{name} from {pluginId} is off: it failed too often and is suspended until the owner restarts.",
  "plugins.command.tooMany": "Too many commands at once: try /{name} again in a moment.",
  "plugins.command.gone": "/{name}: {pluginId} is no longer running.",
  "plugins.command.failed": "/{name} from {pluginId} failed.",
  "plugins.command.timedOut": "/{name} from {pluginId} failed: it ran out of time.",
} as const;
