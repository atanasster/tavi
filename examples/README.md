# Examples

Plugins, mods and a canvas page to read and copy from. Each folder is a
complete plugin — a `tavi-plugin.json` manifest beside its code — that
`tavi plugins install <folder>` takes as it is. The smallest, `acme-units`,
installs like this:

```bash
tavi plugins install examples/plugins/acme-units
tavi plugins approve acme.units 0.1.0
tavi plugins enable acme.units
```

[PLUGINS.md](../docs/PLUGINS.md) is the reference for every manifest field and
the module API; [MODS.md](../docs/MODS.md) walks through writing `acme-units`,
`acme-fx`, `acme-guard` and `cache-meter` from nothing.

## Tool plugins

| Example | What it shows |
| :--- | :--- |
| [`acme-units`](plugins/acme-units/) | The smallest tool plugin: one read-only unit converter, `acme.units.convert` ([MODS.md](../docs/MODS.md)) |
| [`acme-fx`](plugins/acme-fx/) | A tool with a credential setting that calls an outside API, `acme.fx.rate`: store its key with `tavi credentials set plugins.acme.fx.apiKey --file …` and point the setting at it (`tavi plugins config acme.fx --set apiKey=plugins.acme.fx.apiKey`) before its tool works ([MODS.md](../docs/MODS.md)) |

## Replacing a built-in

Each of these stands in for a built-in once that built-in is disabled, through
the same path it uses; [PLUGINS.md](../docs/PLUGINS.md#reference-replacements)
says how each is selected, and `apps/cli/test/plugins/replacements.test.ts`
runs each one through the host. A channel or a provider runs in the owner's
process, so it is approved with `tavi plugins approve <id> <version>
--in-process`.

| Example | Replaces |
| :--- | :--- |
| [`acme-telegram-webhook`](plugins/acme-telegram-webhook/) | The Telegram channel, with Bot API webhooks in place of polling |
| [`acme-mailgun-lite`](plugins/acme-mailgun-lite/) | The Mailgun email channel |
| [`acme-gmail-lite`](plugins/acme-gmail-lite/) | The Gmail channel |
| [`acme-memory-keywords`](plugins/acme-memory-keywords/) | The memory provider: keyword recall and capture with no model |
| [`acme-ideas`](plugins/acme-ideas/) | The ideas provider: a fixed catalogue |
| [`acme-onboarding`](plugins/acme-onboarding/) | The onboarding flow |
| [`acme-heartbeat-rules`](plugins/acme-heartbeat-rules/) | The heartbeat provider: rules, no model |
| [`acme-router`](plugins/acme-router/) | The routing provider: keyword routing with no model or network |
| [`acme-flights`](plugins/acme-flights/) | Flight search, over a fixed fare sheet |
| [`acme-daily-brief`](plugins/acme-daily-brief/) | The daily brief's report ([REPORTS.md](../docs/REPORTS.md)) |
| [`acme-flight-sites`](plugins/acme-flight-sites/) | Site skills: a reviewed site profile for one fare site |

## Mods

| Example | What it shows |
| :--- | :--- |
| [`cache-meter`](mods/cache-meter/) | A whole mod in two files: a `turn.complete` hook that shows how long the prompt cache stays warm ([MODS.md](../docs/MODS.md)) |
| [`acme-guard`](mods/acme-guard/) | A `tool.check` hook on `sandbox.run` that asks before a destructive command, as the built-in `tavi.guard` does ([MODS.md](../docs/MODS.md)) |

## Canvas pages

| Example | What it shows |
| :--- | :--- |
| [`minimal-browser-view`](ui-plugins/minimal-browser-view/) | A page the web canvas frames: a live view of the agent's browser ([its README](ui-plugins/minimal-browser-view/README.md)) |
