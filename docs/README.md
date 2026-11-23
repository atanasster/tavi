<img src="assets/brand/mark.svg" alt="Tavi's mark: a speech bubble with a sprout" width="56">

# Tavi documentation

Every guide in this folder, grouped by what you came to do. New here? Start
with the [README](../README.md) to install and run Tavi, then
[CONCEPTS.md](CONCEPTS.md) for the words the rest of these pages use.

## Use it

| Guide | What it covers |
| :--- | :--- |
| [How-to guides](use-cases/README.md) | Short, illustrated guides, one task each, with the real screens |
| [CONCEPTS](CONCEPTS.md) | The owner, chats, workspaces, memory, tools and the glossary |
| [USECASES](USECASES.md) | What Tavi is for, surface by surface, and the 65 everyday ideas |
| [ONBOARDING](ONBOARDING.md) | First run: `tavi onboard`, `tavi setup` and the canvas's Welcome |
| [WEB-UI](WEB-UI.md) | The web canvas (`tavi ui`): chats, the Command Center, Ideas and Settings |
| [TERMINAL-UI](TERMINAL-UI.md) | The terminal chat (`tavi chat`): panes, slash commands and approvals |
| [CHANNELS](CHANNELS.md) | Telegram, Gmail, Mailgun email and Discord, and who may reach the agent |
| [APPS](APPS.md) | Connected apps: MCP servers, channel accounts and plugins in one place |
| [AUTOMATION](AUTOMATION.md) | `tavi run`, schedules, watchers and triggers, reminders, to-dos, routines and agents |
| [REPORTS](REPORTS.md) | The daily brief: your projects' analytics, billing, revenue and news as a PDF |
| [HEARTBEAT](HEARTBEAT.md) | The proactive check that tells you only what needs you |
| [IDEAS](IDEAS.md) | The Ideas tab and the suggestions in an empty chat |
| [MEMORY](MEMORY.md) | What Tavi remembers, how you review it, and how recall works |
| [SKILLS](SKILLS.md) | Approved, versioned procedures the agent loads when they apply |
| [BROWSER](BROWSER.md) | The agent's browser: sessions, approvals per site, live view and takeover |
| [DESKTOP](DESKTOP.md) | Experimental desktop control on macOS |
| [WORKING-FOLDERS](WORKING-FOLDERS.md) | Each chat's folder, attached folders and the file tools |
| [PDF](PDF.md) | Reading, filling and rendering PDFs |
| [VIDEO](VIDEO.md) | Reading videos: frames, transcripts, pose and native video models |
| [JOBS](JOBS.md), [PLACES](PLACES.md), [TRENDS](TRENDS.md) | The job search, places and trends plugins built in this repository |

## Run it

| Guide | What it covers |
| :--- | :--- |
| [CLI](CLI.md) | Every command, action and flag, exit codes and environment variables |
| [CONFIGURATION](CONFIGURATION.md) | Credentials, model connections and roles, workspace settings |
| [LANGUAGES](LANGUAGES.md) | Choosing the language Tavi speaks, what follows it, and adding words or a language |
| [Tavi на български](bg/README.md) | An introduction to Tavi in Bulgarian: installing, choosing the language, what is in Bulgarian |
| [OPERATIONS](OPERATIONS.md) | The data directory, running the owner as a service, doctor, backups and storage |
| [WINDOWS](WINDOWS.md) | Tavi on Windows: WSL2, and what native Windows does and refuses so far |
| [SECURITY-MODEL](SECURITY-MODEL.md) | How a tool call is decided, approvals, untrusted content and the taint gate |
| [SANDBOX](SANDBOX.md) | The OS confinement of shell commands, plugins, PDFs and videos |
| [PRIVACY](PRIVACY.md) | What leaves your machine, and when |
| [ROUTER](ROUTER.md) | Optional model, tool, memory and skill routing |

## Extend it

| Guide | What it covers |
| :--- | :--- |
| [PLUGINS](PLUGINS.md) | Writing, reviewing and installing plugins: tools, providers, sites and canvas pages |
| [MODS](MODS.md) | Making a plugin or mod from a chat, step by step, then installing, updating and removing it |
| [MCP](MCP.md) | Adding, reviewing and confining MCP servers |
| [CHANNEL-PLUGINS](CHANNEL-PLUGINS.md) | A messaging channel of your own, step by step |
| [MEMORY-PLUGINS](MEMORY-PLUGINS.md), [HEARTBEAT-PLUGINS](HEARTBEAT-PLUGINS.md), [IDEAS-PLUGINS](IDEAS-PLUGINS.md), [ONBOARDING-PLUGINS](ONBOARDING-PLUGINS.md) | Replacing a built-in provider |
| [TOOLS-AND-SKILLS](TOOLS-AND-SKILLS.md) | How a turn's tools are chosen and called, the tool catalogue, and skills end to end |
| [Examples](../examples/README.md) | Example plugins, mods and a canvas page to copy from |

## Work on Tavi

| Guide | What it covers |
| :--- | :--- |
| [ARCHITECTURE](ARCHITECTURE.md) | Packages, the owner and its clients, a turn end to end, and every subsystem |
| [IPC](IPC.md) | Every message an attached client sends the owner |
| [ASYNC-PERSISTENCE](ASYNC-PERSISTENCE.md) | The database worker, its queues and checkpoints |
| [DEVELOPMENT](DEVELOPMENT.md) | Building, testing, the repository's gates, CI and evals |
| [Contributing](../CONTRIBUTING.md) | How to send a change |
| [templates/CHANNEL-PRIVACY-NOTICE](templates/CHANNEL-PRIVACY-NOTICE.md) | A privacy notice to give the people you let message your agent |
