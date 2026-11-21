# Onboarding plugins

This guide explains how to replace setup's **flow** with your own: which steps `tavi onboard`, `tavi setup` and the canvas's Welcome walk, in what order, and in whose words. What a person sees is in [ONBOARDING.md](ONBOARDING.md). Plugin basics are in [PLUGINS.md](PLUGINS.md).

One flow runs per install. The built-in one, `tavi.onboarding`, walks the model, about you, apps, tasks, channels, voice messages, search, the service and first ideas. Yours might put a company's channel first, leave a step out, or say things in your own words.

You choose steps and words. Tavi does everything else:
- **Readiness.** Whether each step is done comes from live state, never from your flow.
- **Validation.** Your flow is checked against the contract and repaired where it must be (see [What the host does with it](#what-the-host-does-with-it)).
- **Every write.** Keys, connections, pairings and settings go through Tavi's own commands. Your flow never touches them.
- **Fallback.** A flow that throws, is slow or does not validate is replaced by the built-in one for that read, and the person is told why.

Your flow never stores, sends or runs anything. That is what makes it safe to install and safe to swap.

## Step 1: the manifest

```json
{
  "schemaVersion": 2,
  "abi": "tavi.providers/1",
  "provenance": { "format": "bundled-esm", "packages": [] },
  "id": "acme.onboarding",
  "version": "1.0.0",
  "name": "ACME setup",
  "description": "Slack first, the company key, no Telegram.",
  "entry": "index.mjs",
  "isolation": "in-process",
  "provides": ["onboarding"],
  "onboarding": { "abi": "tavi.onboarding/1", "disclosure": "Puts ACME's Slack first and leaves Telegram out." }
}
```

- **`provides` and `onboarding.abi`.** Together they say the plugin supplies a flow built for contract `tavi.onboarding/1`. A plugin built for another contract is refused before any of its code runs, and each needs the other.
- **`disclosure`** is shown when the person reviews the plugin (`tavi plugins show`, Settings → Plugins), after Tavi's own sentence: the flow receives setup's checklist, what Tavi can do here and the ids of what is available, nothing of the person's.
- **`receives`** (optional): `["status-detail"]` asks for each step's words as Tavi shows them (a provider and model name, an account label, when it was verified, its rows). The review says so, and only with it approved does the flow get them; without it, `status` carries each step's kind and state alone.

**Offline.** A plugin's flow runs in a running owner (`tavi serve`) only: plain `tavi onboard` with no owner never loads plugin code, so it walks the built-in flow and says so in the status (`flowFallback`).
- **`isolation: "in-process"`.** A flow is a live object the owner calls, so it can't run as a confined worker. Approve the plugin with `--in-process`.

## Step 2: register the flow

Call `provideOnboarding` once, in `register`. Tavi takes your `flow` function at that moment, so changing the object later changes nothing. It answers only while the plugin runs; once the plugin stops, setup falls back to the built-in flow. The worked example, "ACME: Slack first, no Telegram":

```js
import { availableFor, defineOnboardingFlow, withAvailableFeatured } from "@tavi/plugin-kit/onboarding";

const acmeOnboarding = {
  async flow(request) {
    request.signal.throwIfAborted();
    const steps = [
      { id: "model", kind: "model", title: "Pick the model ACME pays for", body: "Use the company OpenRouter key from the ACME wiki.", optional: false, featured: ["openrouter"], recommended: "openrouter" },
      { id: "slack", kind: "channels", title: "Message Tavi from Slack", body: "Pair yourself in #tavi. Telegram is not used at ACME.", optional: true, featured: ["slack"] },
      { id: "about", kind: "about", title: "About you", body: "Your name and time zone.", optional: true, about: { fields: ["name", "timezone"] } },
      { id: "service", kind: "service", title: "Keep Tavi running", body: "Start it with your computer.", optional: true, surfaces: ["cli"] },
      { id: "ideas", kind: "ideas", title: "Try something", body: "A few things Tavi can do for you now.", optional: true },
    ];
    return defineOnboardingFlow({
      abi: "tavi.onboarding/1",
      version: 1,
      title: "Welcome to Tavi at ACME",
      steps: steps.map((step) => withAvailableFeatured(step, availableFor(step.kind, request))),
      done: { title: "You're set up", body: "Questions? #tavi-help." },
    });
  },
};

export default {
  register({ provideOnboarding }) {
    provideOnboarding(acmeOnboarding);
  },
};
```

With it, the canvas walks model → Slack → about you → first ideas, and the terminal adds the service step before the ideas. No Telegram is offered anywhere. Slack is featured only where a Slack channel plugin is installed; elsewhere the channels step says no channel it offers is installed.

The canvas shows every step's own words. The terminal takes the flow's order and title, the model step's featured presets, and the channels step's featured kinds: it adds and pairs the first of those that is set up with secrets alone, in that channel's own words, and otherwise names `tavi channels add <kind>`. Its other questions are its own.

## What you are given

`flow(request)` gets its own deep-frozen copy:
- **`surface`**: `cli` or `web`, the one asking.
- **`status`**: setup's checklist, each step's kind and state (`done`, `todo`, `skipped`, `blocked`, `unavailable`), with no details: no names, models, endpoints or account labels — unless the manifest's `receives` names `status-detail` and the approval granted it, when each step also carries its `detail`, `verifiedAt` and `items` (never what the flow created, nor the card's or the funnel's records).
- **`census`**: what Tavi can do here (the Ideas capability census).
- **`presets`, `channels`, `apps`**: the *ids* of the model providers, channel kinds and apps available now.
- **`detected`**: the model presets detection found (a key's *name* in the owner's environment, or a local server running), never a value.
- **`signal`**: aborted when the deadline passes or the plugin stops.

Nothing else: no memory, chats, settings values or keys.

## What you answer

A flow (`OnboardingFlowSchema`): `abi`, a `version` you bump when you add steps, a `title`, the `steps` in order, and the `done` screen's `title` and `body`. Each step has:
- `id` (the address `/welcome/<id>` uses), `kind` (`model`, `about`, `search`, `apps`, `tasks`, `channels`, `voice`, `service`, `ideas`, `info`), `title`, `body`, `optional`; each kind at most once, so at most 10 steps;
- `featured`: up to 4 ids to offer first (presets for the model, channel kinds, app ids), and `recommended`, one of them;
- `surfaces`: `["cli"]`, `["web"]` or both (the default);
- `about.fields` for an about step; `prompts` (up to 3, each a `label` and a `prompt`) for an ideas step.

Every string is plain text: no markup, no links that run code.

### An info step with a page of your own

An `info` step can show a page of your plugin under its words on the canvas (`frame: "<contribution id>"`). Declare the page as a UI contribution placed in the `onboarding.step` slot, with no `channels`:

```json
"ui": { "abi": "tavi.ui/1", "contributions": [{ "id": "intro", "title": "About ACME's setup", "document": "intro.html", "placements": [{ "slot": "onboarding.step" }] }] }
```

It runs like every UI plugin page: in a sandboxed iframe with an opaque origin, `connect-src 'none'` (no network), and only the `tavi.ui/1` messages. A contribution in this slot may receive no channel, so no data or secret reaches it. Only your own flow's frame is shown, never another plugin's. A step with a frame is the canvas's alone: the terminal never shows it. *Got it* marks the step seen.

## What the host does with it

Every read of your flow is checked, and repaired where the rules say so:
- **The model step is always there.** It is forced to be required, added if you left it out, and moved first while the model is not set up, on every surface whatever its `surfaces` said.
- **Only what is available is featured.** An id the request did not list is dropped.
- **The service step is the terminal's.** The canvas never shows it.
- **An ideas step with no prompts** gets Tavi's own fallback prompts, the host's and not any provider's, so they are the same whichever flow is chosen.
- **Ollama.** When Ollama runs with a model that can use tools, it is featured and recommended on the model step.
- **A flow that fails** is replaced by the built-in flow for that read. That covers a throw, no answer within 5 seconds, a flow outside the contract, and one with no step on the surface. The person sees why (`status.flowFallback`, without your error's text).

Bumping `version` brings a dismissed Home checklist back once, but only when an open step is of a kind your previous version did not have. A bump that adds no step brings nothing back.

## Testing

Run the conformance suite against your flow. It is the same one the built-in flow passes. It checks that the flow validates within the deadline on each surface, keeps the model step first while it is open, features only what is available, and stops on an aborted signal. `@tavi/plugin-kit/onboarding` is not published yet, so for now the suite runs inside a Tavi checkout. The ACME example above is tested there (`packages/agent-host/test/onboarding-acme-example.test.ts`).

```ts
import { describeOnboardingProviderConformance } from "@tavi/plugin-kit/onboarding/conformance";
import plugin from "./index.mjs";

let provider;
plugin.register({ provideOnboarding: (given) => { provider = given; } });
describeOnboardingProviderConformance("acme.onboarding", () => provider);
```

`tavi plugins validate <dir>` also checks that `register` supplies the flow the manifest declares, and that its `flow` is a function.

## Selecting it

Once the plugin is approved and running, select it for the install:

```bash
tavi onboard provider acme.onboarding
```

`tavi onboard provider` lists the installed flows and marks the one in use; `tavi onboard provider tavi.onboarding` goes back to the built-in one. The canvas cannot switch flows. If your plugin stops, setup uses the built-in flow until it runs again. With `tavi.onboarding` disabled and no plugin, setup keeps its checklist and the host's own plain flow.

## Architecture

Onboarding flow plugins share contracts and conformance tooling across `@tavi/plugin-kit/onboarding`, `@tavi/agent-host`, and `@tavi/plugin-defaults`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **SDK & Conformance** | `packages/plugin-kit/src/onboarding/*` (`@tavi/plugin-kit/onboarding`, `@tavi/plugin-kit/onboarding/conformance`) | Flow step types, copy/order validation, and `describeOnboardingProviderConformance`. |
| **Host & Built-in Flow** | `packages/agent-host/src/hosts/onboarding-host.ts`, `packages/builtin/defaults/src/onboarding.ts` (`@tavi/plugin-defaults`) | Evaluates workspace readiness independently of plugin step ordering, validates plugin-supplied steps, and runs the built-in `tavi.onboarding` flow. |

See [ONBOARDING.md#architecture](ONBOARDING.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for the complete onboarding subsystem layout.
