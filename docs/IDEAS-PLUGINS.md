# Ideas plugins

This guide explains how to replace what writes a person's **Ideas** with your own provider. Ideas are the things Tavi offers to do for someone, shown on the Ideas tab and as suggested prompts in an empty chat. Plugin basics are in [PLUGINS.md](PLUGINS.md).

One provider writes a workspace's ideas at a time. The built-in one, `tavi.ideasagent`, ranks a catalogue of use cases by what the person has mentioned. Yours can do anything else: a different catalogue, a rules engine, a model of your own.

You write ideas. Tavi does everything else:
- **Inputs.** What your provider is given: only what your manifest asks for, narrowed by each workspace's switches.
- **Census.** The capability census: what Tavi can actually do here.
- **Validation.** Every idea you propose is checked against the contract, and failures are dropped. The run says why: `tavi ideas list` prints the first few rules broken under *Last run* (`Left out: idea 1: basis.0: …`), `--format json` gives them as the run's `reason`, and the owner's log has a warning for each.
- **Ledger and cap.** The ledger (dismissals, snoozes, muted sections, excluded sources) and the cap of 12 active ideas.
- **Storage, display and expiry.**

Your provider never stores, sends or runs anything. It proposes. That is what makes a provider safe to install and safe to swap.

## Step 1: the manifest

```json
{
  "schemaVersion": 2,
  "abi": "tavi.providers/1",
  "provenance": { "format": "bundled-esm", "packages": [] },
  "id": "acme.ideas",
  "version": "1.0.0",
  "name": "ACME ideas",
  "description": "Offers a weekly review and an inbox clean-up, nothing else.",
  "entry": "index.mjs",
  "isolation": "in-process",
  "provides": ["ideas"],
  "ideas": { "abi": "tavi.ideas/1", "receives": ["ledger"], "maxRunSeconds": 30, "disclosure": "Reads none of your memory or chats; it sees which of its ideas you dismissed, snoozed or muted." }
}
```

- **`provides` and `ideas.abi`.** Together they say the plugin supplies an ideas provider built for contract `tavi.ideas/1`. A plugin built for another contract is refused before any of its code runs.
- **`receives`.** Lists what your provider asks to be given. Code for each one being absent:
  - `memory`: the person's approved, normal-sensitivity preferences, facts and lessons, their profile first (core `me.*` facts, then preferences and lessons, then other facts, newest first within each). Sensitive and run-local records are never read.
  - `tasks`: their recent chats' titles and summaries. A chat's summary comes only when its content label was read and is trusted; otherwise you get its title alone.
  - `brief`: the text they wrote to steer ideas.
  - `ledger`: what they dismissed, snoozed, muted, excluded, tried lately or asked for more of, plus the ideas active now. The prompts they edited before sending (`examples`) are their own words, so they come only with `tasks`, and never those typed in a chat they set aside.

  A record, chat or brief the person excluded (*Don't use this*) is withheld from you entirely. Private and memory-off chats, chats from messaging conversations, and runs never reach you. The request is a deep-frozen copy: change nothing in it.

  Each of `memory`, `tasks` and `brief` also has a per-workspace switch (`tavi ideas` settings). When the person turns one off, you don't get it, whatever your manifest says. While their memory is paused, you get neither `memory` nor `tasks` (nor `examples`), only `brief`, and the census leaves out `memory`.
- **`maxRunSeconds`** (1–120) is your deadline. Past it, the request's `signal` aborts and the run is recorded as failed.
- **`usesTurns`** (default `false`) asks for `request.host.runTurn({ system, user, maxOutputTokens? })`: one tool-less turn on the workspace's *Fast* model, answering `{ text }`. A run takes at most 3, each answer at most 2,000 tokens, within the workspace's daily ideas budget (20,000 tokens by default), which the prepared first steps spend from too. Each turn holds its longest answer against the day until it ends, so turns asked at once can't all squeeze in; a turn still running when your deadline stops the run has up to 5 seconds to report what it spent, and that is counted. Past it, or with no *Fast* model set, the call throws (`IdeasProviderError("budget")`, or `UNAVAILABLE`): write what you can without it. `system` and `user` are at most 32,000 characters each, and `user` must not be blank; a turn outside that throws `IdeasProviderError("invalid")` before anything is sent. The text is yours to parse; every idea you propose from it is checked like any other. The person is told at approval that you may ask their model.
- **`disclosure`** is shown to the person when they review the plugin (`tavi plugins show`, Settings → Plugins), after what your `receives` lets you read.
- **`isolation: "in-process"`.** A provider is a live object the owner calls, so it can't run as a confined worker. Approve the plugin with `--in-process`.
- **Hooks.** If the plugin also declares turn hooks (`mods.hooks`), each must name its `match.sources` and leave out `ideas`; a manifest that doesn't is refused. Your hooks never run in the prepared steps of your own ideas (see [Prepared first steps](#prepared-first-steps)).

## Step 2: register the provider

Call `provideIdeas` once, in `register`. Tavi takes your `generate` and `status` functions at that moment, so changing the object later changes nothing. They answer only while the plugin runs, and a generation stops when the plugin does.

```js
export default {
  register({ provideIdeas }) {
    provideIdeas({
      async generate({ capabilities, ledger, signal }) {
        signal.throwIfAborted();
        const offered = [
          { key: "productivity.weekly-review", needs: "memory", icon: "📋", title: "I can run your weekly review", label: "Weekly review", prompt: "Run my weekly review: what got done, what slipped, what's next." },
        ];
        const ruledOut = new Set([...(ledger?.dismissedKeys ?? []), ...(ledger?.snoozedKeys ?? [])]);
        return {
          ideas: offered
            .filter((idea) => capabilities.includes(idea.needs) && !ruledOut.has(idea.key))
            .map(({ needs, ...idea }) => ({
              idea: { ...idea, category: "productivity", pitch: "Every Friday, five minutes.", basis: [{ kind: "general", ref: "weekly-review" }], uses: [{ capability: needs, approval: false }] },
              score: 0.6,
            })),
        };
      },
      status: () => ({ ready: true }),
    });
  },
};
```

## What you are given

`generate(request)` receives a frozen request. Whatever your manifest and the person's switches leave out is simply absent.

| Field | Always | What it is |
|---|---|---|
| `workspaceId`, `now`, `timezone` | ✓ | Where and when |
| `capabilities` | ✓ | The census: `web`, `browser`, `memory`, `reminders`, `routines`, `files`, `sandbox`, `pdf`, `image`, `video` (proven by Tavi's own tools), and the categories plugins prove: `places`, `care`, `jobs`, `trends`, `travel`, `mailbox`, `calendar`, `home`, `messaging`. Only what is here: a plugin's tool or channel proves a category by declaring it (`proves` in its manifest's tool or channel), a mailbox by its account's search tool |
| `limits` | ✓ | `{ maxIdeas, deadlineMs }`. `maxIdeas` is the workspace's volume: 12 by default, moved between 4 and 12 by auto-volume on how many ideas the person takes up |
| `signal` | ✓ | Aborts at your deadline or when your plugin stops |
| `memory` | | `[{ recordId, revisionId, kind, text }]` |
| `tasks` | | `[{ taskId, title, summary? }]` |
| `brief` | | The person's brief, verbatim |
| `ledger` | | `dismissedKeys`, `snoozedKeys`, `suppressedKeys`, `recentKeys`, `mutedCategories`, `excludedBasis`, `boostedKeys`, `boostedCategories`, `examples`, `active`, and `categoryPriors` (per section, how much its ideas were taken up over 30 days: tried +1, edited before sending +0.5, done +2; absent from an older store) |

## What you answer

You answer `{ ideas: [{ idea, score }] }`. `score` runs from 0 to 1, higher first. An `idea` has these fields:

| Field | Rule |
|---|---|
| `key` | `<section>.<name>[:<subject>]`, lower case. Stable for the same offer, because dismissals are by key. It starts with its `category`. |
| `category` | `productivity`, `work`, `learning`, `health-home`, `travel`, `shopping`, `people` |
| `icon` | One emoji from `IDEA_ICONS` |
| `title` | ≤ 80 characters, one line, a first-person offer ("I can …") |
| `pitch` | ≤ 320 characters |
| `label` | ≤ 40 characters, one line: the chip's text |
| `prompt` | ≤ 600 characters: what goes in the composer. Nothing is sent without the person. |
| `basis` | 1–4 of `{ kind, ref }`: `memory` with a `recordId` you were given, `task` with a `taskId` you were given, `brief` with ref `brief`, or `general` (nothing personal) with your `templateId` as its ref, or `general` |
| `uses` | 1–6 of `{ capability, approval }`: what it will use |
| `templateId`, `recurring` | Optional: your own template id, and `{ cadence: "daily" \| "weekly" \| "monthly" }` to offer *Make it recurring* |

The host validates each answer and **drops** (counts, never repairs) an idea that:
- is outside these rules, including control or bidirectional characters in its text;
- uses a capability the census lacks;
- cites a source you weren't given, or one the person excluded;
- repeats a key, or has a score that isn't a number.

The host also rewrites every basis excerpt from the source itself, so you can't put words in the person's mouth. And it marks `approval: true` on any capability that acts on the person's behalf (`browser`, `files`, `mailbox`, `messaging`, `home`), whatever you said.

The store then refuses what the ledger rules out:
- dismissed or snoozed keys;
- keys ignored after three offers;
- keys tried within the week;
- ideas in a muted section, or resting on an excluded source.

It keeps the best 12 active. Leaving those out yourself only saves you work.

Throw `IdeasProviderError` from the context with `"transport"`, `"invalid"` or `"budget"` to say why you failed. Any other throw counts as `transport`. The run is recorded as failed, and the ideas already shown stay.

## Prepared first steps

Once a day Tavi may run the first step of up to two offered ideas ahead of time, read-only and unattended. Your ideas qualify when your `receives` is `["ledger"]` alone, or, for a provider that reads the person's memory, tasks or brief (it could have put them in a `general` idea, whose words the run's searches then carry), once the operator turns that on with `tavi ideas prepare on` (off by default; a page cannot change it), and:
- every `basis` is `general`, so the prompt carries nothing of the person's;
- the `prompt` has no `[part]` left to fill;
- every use is `web`, `places`, `trends`, `jobs` or `travel`, and none asks first.

You don't call anything for this, and your provider is not told. The run is offered only the read-only tools those uses prove, and its answer goes, as untrusted data, to the first turn of the chat *Try it* starts. An answer is kept only while the idea's `prompt` and `uses` are those its step ran for. The built-in provider's read-only templates all have a `[part]`, so today only a plugin's ideas can be prepared: one that receives only `ledger`, or any once `tavi ideas prepare on`.

## Testing

Run the conformance suite against your provider. It is the same one the built-in provider passes. `@tavi/plugin-kit` is private to this repository, so the suite runs inside a Tavi checkout, as the heartbeat suite (`@tavi/plugin-kit/heartbeat/conformance`) does.

```ts
import { describeIdeasProviderConformance } from "@tavi/plugin-kit/ideas/conformance";
import plugin from "./index.mjs";

let provider;
plugin.register({ provideIdeas: (given) => { provider = given; } });
describeIdeasProviderConformance("acme.ideas", () => provider);
```

## Selecting it

Once the plugin is approved and running, select it for a workspace:

```bash
tavi ideas provider acme.ideas
```

`tavi ideas provider` lists the installed providers, marks the one in use, and shows what each receives. Switching retires the old provider's unpinned ideas. If your plugin stops, the workspace's runs are recorded as skipped ("not installed or not running") until it runs again or the person switches back to `tavi.ideasagent`.

## Architecture

Ideas providers share contracts, the 65-item starter catalogue, and conformance tooling across `@tavi/plugin-kit/ideas`, `@tavi/agent-host`, and `@tavi/plugin-defaults`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **SDK, Catalogue & Conformance** | `packages/plugin-kit/src/ideas/*` (`@tavi/plugin-kit/ideas`, `@tavi/plugin-kit/ideas/conformance`) | `IDEA_CATALOGUE` (`packages/plugin-kit/src/ideas/catalogue.ts`), provider helpers, and `describeIdeasProviderConformance`. |
| **Host & Built-in Provider** | `packages/agent-host/src/hosts/ideas-host.ts`, `packages/builtin/defaults/src/ideas.ts` (`@tavi/plugin-defaults`) | Enforces egress switches (`context`, `memory`, `conversations`, `tools`), normalizes and deduplicates suggested ideas, and runs the built-in `tavi.ideasagent` provider. |

See [IDEAS.md#architecture](IDEAS.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for the complete Ideas subsystem layout.
