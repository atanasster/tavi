/**
 * The built-in plugin-authoring skill: what Tavi's
 * own agent reads, through `plugins.authoring_guide`, before it writes a
 * plugin for the person. Every rule here is one the owner enforces —
 * `tavi plugins validate` and install refuse what breaks it. Its own example
 * is validated and its test run by `apps/cli/test/plugins/authoring-tools.test.ts`.
 */
export const PLUGIN_AUTHORING_GUIDE_VERSION = "5";

// `\u0069mport` in the test example below is the word `import`, escaped so that a line of this text in the
// built bundle is not read as an import statement by the build's import-graph checks (tests/support/imports.ts).
export const PLUGIN_AUTHORING_GUIDE = `# Writing a Tavi plugin (a "mod")

A plugin is a folder with two or more files: \`tavi-plugin.json\` (the manifest the person approves) and an ES module entry (\`index.mjs\`). It runs inside the owner with its privileges once the person installs, approves and enables it. You write it; you never install it — the person does, with the commands at the end.

## Steps

1. Ask what it should do, if that is unclear: which event (below), which tools it concerns, what it should answer, and what it shows the person.
2. Pick a folder in your working folder (or in an attached folder you may write), such as \`tavi-plugins/<name>/\`; a relative path is in your working folder. Write the files with \`fs.write\`: \`tavi-plugin.json\`, \`index.mjs\`, and \`index.test.mjs\`.
3. Call \`plugins.validate\` with the folder. Fix every error and re-run until it reports \`valid\`. Fix the warnings too, unless the person chose otherwise (say so). When it answers \`checked: "manifest only"\`, \`register\` was not run (only macOS runs it): say that the code itself was not checked. It also answers \`folder\`, the absolute path to give the person.
4. If you can run commands, run \`node --test index.test.mjs\` in the folder; otherwise give the person that command.
5. Finish with the install commands (below) naming that absolute \`folder\`, what the plugin does, what each hook can read (its \`disclosure\`), and that approving it lets the code run in the owner.

## Rules the owner enforces

- The entry and every file it imports are \`.mjs\`. Import only \`node:\` built-ins and relative \`./x.mjs\` files in the folder: no packages (use the \`z\` the context passes in), no computed \`import()\`, no CommonJS, no symbolic links.
- The id is \`<owner>.<name>\`, lower-case (\`acme.guard\`); never \`tavi.…\`. The version is semver; an installed version is immutable, so a change needs a new version.
- Everything the code registers is declared in the manifest first: each tool, hook and command. A hook registered with a wider \`match\` than declared, or one not declared, fails the plugin's load.
- \`register\` adds hooks, tools and commands; nothing can be added after it returns.
- Hooks can only make things stricter: allow → ask → deny, never back.

## The manifest

\`\`\`json
{
  "schemaVersion": 2,
  "abi": "tavi.providers/1",
  "provenance": { "format": "bundled-esm", "packages": [] },
  "id": "acme.guard",
  "version": "0.1.0",
  "name": "Guard",
  "description": "Asks before shell commands that delete files.",
  "entry": "index.mjs",
  "mods": {
    "abi": "tavi.mods/1",
    "hooks": [
      { "event": "tool.check", "match": { "tools": ["sandbox.run"] }, "onFailure": "ask",
        "disclosure": "Reads each shell command before it runs, and asks before one that deletes files." }
    ],
    "commands": [ { "name": "tally", "description": "How many commands it asked about." } ]
  }
}
\`\`\`

- \`tools\`: \`[{ "name": "lookup", "effect": "read-only" | "mutating" | "external", "description": "…" }]\` for tools the model can call (\`<id>.<name>\`). \`mutating\` and \`external\` tools need the person's approval on each call. A tool's output is untrusted (it taints the chat) unless it declares \`"untrustedOutput": false\`, which the person sees as *trusted output* at approval; declare it only when the tool returns the plugin's own data, never text from a page, a message or another service.
- \`config\`: \`{ "city": { "type": "string" | "number" | "boolean" | "credential", "description": "…", "required": true } }\`. A \`credential\` is read with \`await secret("key")\`; the person stores it with \`tavi credentials set plugins.<id>.<key>\`.
- A hook's \`match\` narrows it: \`tools\` (tool ids such as \`sandbox.run\`, \`fs.write\`, \`browser.act\`; only on tool events), \`sources\` (\`cli\`, \`ipc\`, \`messaging\`, \`schedule\`, \`agent\`, \`reminder\`, \`web\`, \`heartbeat\`, \`routine\`; a heartbeat provider's own hooks must name their \`sources\` and leave out \`heartbeat\`), \`channels\` (messaging connection ids).
- \`disclosure\` (required, ≤300 characters): what the hook does, in plain words. The person reads it before approving.
- \`onFailure\`: what a hook that throws, takes over 5 s or answers a wrong shape stands for. \`tool.check\`: \`ask\` (default) or \`deny\`; \`tool.call\`: \`skip\` (default) or \`deny\`; \`prompt.submit\`: \`skip\` (default) or \`drop\`; \`tool.result\`: \`withhold\`; the observers \`turn.start\`, \`model.step\` and \`turn.complete\`: \`skip\`. State it for a hook that can fail more than one way.
- \`contextTrusted: true\` (only on \`prompt.submit\`): the blocks it adds are the plugin's own data, not text it read from a page, a message or another service. Without it every block is untrusted and taints the turn, so the chat's later sends and writes ask once. The person sees *trusted context* at approval; declare it only when it is true.
- Commands: up to 8, names lower-case letters, digits and dashes. \`run({ envelope, args, signal })\` answers \`{ text }\`; stop when \`signal\` fires (its 5 s deadline, or the plugin stopping).

## The module

\`\`\`js
export default {
  register({ hooks, ui, commands, state, log, z, registerTool, secret, config }) {
    let asked = 0;
    hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
      const verdict = await next(e);              // what the hooks beneath and core answer
      // sandbox.run takes a program and its args; a shell line arrives as sh with ["-c", line]. Read them together.
      const line = [e.input?.command, ...(e.input?.args ?? [])].map(String).join(" ");
      // rm with a recursive flag, however spelt: -rf, -fr, -r -f, -R, --recursive.
      if (!/\\brm\\b[^;&|]*\\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b/.test(line)) return verdict;
      asked += 1;
      // Nobody can approve an unattended run: refuse rather than ask.
      return e.envelope.attended ? { decision: "ask", reason: "Deletes files." } : { decision: "deny", reason: "Deletes files, and nobody can approve it." };
    });
    commands.register({ name: "tally", run: () => ({ text: \`Asked about \${asked} commands.\` }) });
  },
};
\`\`\`

This example is small on purpose; the built-in \`tavi.guard\` covers more (\`git reset --hard\`, \`DROP TABLE\`, quoting). A hook is \`async (e, next) => …\`: \`await next(e)\` is the answer of the hooks beneath and core; return it, or a stricter one. Every \`e\` carries \`e.envelope\`: \`{ workspaceId, principalId, taskId, runId, source, frontEnd?, channel?, chatKind?, attended }\`.

| Event | \`e\` has | Answer |
| --- | --- | --- |
| \`turn.start\` | \`kind\` | nothing (observer) |
| \`prompt.submit\` | \`prompt\`, \`steer\` | \`{ context: ["…"] }\` (≤4 blocks of ≤4,000 chars, added after the prompt as data) or \`{ drop: "why" }\` (no turn runs; a steer is never dropped) |
| \`model.step\` | \`step\`, \`model\` | nothing (observer) |
| \`tool.check\` | \`tool\`, \`callId\`, \`input\`, \`verdict\` | \`{ decision: "allow" \\| "ask" \\| "deny", reason }\` |
| \`tool.call\` | \`tool\`, \`callId\`, \`input\` | \`{}\` or \`{ deny: "why" }\` |
| \`tool.result\` | \`tool\`, \`input\`, \`output\` (already masked), \`isError\`, \`truncated\` | \`{ output }\` (same shape, only string values changed) or \`{ withhold: "why" }\` |
| \`turn.complete\` | \`outcome\`, \`usage\`, \`toolCalls\` | \`{ suggestions: ["…"] }\` (≤3 next prompts of ≤120 chars) |

A sensitive call's \`input\` and \`output\` are never shown to a hook. Return \`next(e)\`'s answer when you have nothing to add. \`e\` is frozen: never write to it, and never pass a changed copy to \`next\` — the hooks beneath always see the original. Put a change in your answer instead.

The context also has:
- \`ui.status(e.envelope, text)\` (a line on the chat's status row; no text clears it), \`ui.notice(e.envelope, text)\`, \`ui.publish(e.envelope, key, jsonValue)\` (for the plugin's own canvas pane): only an envelope a hook was handed, at most 4 a second.
- \`state.load()\` and \`await state.put(namespace, jsonValue)\`: kept across restarts (16 namespaces, 256 KiB).
- \`log.info|warn|error(message, fields)\`, \`signal\` (aborted when the plugin stops), \`scope.defer(fn)\` for cleanup, \`config\` (its settings).
- \`registerTool({ name, inputSchema: z.object({…}), handler: async (input, { signal }) => result })\` for a declared tool.

## A tool's description and input

A model reads a tool's manifest \`description\` and input schema on every turn it is offered the tool, to choose it and to call it. Every word is paid for each turn, so keep both short.

- Say what it does, then what it is not for, naming the tool that is: "Not for a page's text (browser.read)." Name only tools that exist. Built-in look-alikes to tell apart: \`reminders.create\` (tells the person at a time), \`schedules.create\` (runs a prompt at set times), \`routines.create\` (research that publishes a report), \`todos.add\` (a thing to do); \`fs.write\` (a whole file) and \`fs.edit\` (part of one); \`web_search\` (find pages) and \`web_fetch\` (read one).
- A tool whose input is hard to get right ends its description with one to three compact calls its schema accepts: \`Example: {"op":"add","topic":{"label":"Batteries"}}.\`, several as \`Examples: {…}; {…}.\` A tool with plain inputs needs none.
- A tool with an \`op\` or \`action\` takes one object per op, each holding only what that op takes: \`z.discriminatedUnion("op", [z.strictObject({ op: z.literal("add"), topic }), z.strictObject({ op: z.literal("pause"), topicId })])\`. A field an op does not take is then refused by the schema, not by your handler; \`z.literal("update").describe("…")\` labels a form. The model is sent one object whose \`op\` lists every form, each form's fields said in words.
- A changed input still takes the old shape for one release: in a worker plugin, \`z.preprocess(fromOld, schema)\`, never a looser schema. A plugin approved to run in-process cannot register a schema with a transform (the registry refuses a pipe), so there keep the old fields optional on their forms for the release instead.

## The test

Test \`register\` against a context that records what it is handed, with Node's own runner:

\`\`\`js
// index.test.mjs — run with: node --test index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
\u0069mport plugin from "./index.mjs";

function recording() {
  const hooks = [], commands = [];
  const ctx = {
    hooks: { on: (event, matchOrHook, hook) => hooks.push({ event, hook: hook ?? matchOrHook }) },
    commands: { register: (command) => commands.push(command) },
    ui: { status() {}, notice() {}, publish() {} },
    state: { load: async () => ({}), put: async () => {} },
    log: { info() {}, warn() {}, error() {} },
  };
  return { ctx, hooks, commands };
}
const envelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };

test("asks before rm -rf, and passes ls through", async () => {
  const { ctx, hooks } = recording();
  plugin.register(ctx);
  const check = hooks.find((h) => h.event === "tool.check").hook;
  const allow = async () => ({ decision: "allow" });
  assert.deepEqual(await check({ envelope, tool: "sandbox.run", callId: "c", input: { command: "rm -rf build" } }, allow), { decision: "ask", reason: "Deletes files." });
  assert.deepEqual(await check({ envelope, tool: "sandbox.run", callId: "c", input: { command: "rm", args: ["-r", "-f", "build"] } }, allow), { decision: "ask", reason: "Deletes files." });
  assert.deepEqual(await check({ envelope, tool: "sandbox.run", callId: "c", input: { command: "sh", args: ["-c", "cd out && rm -fr build"] } }, allow), { decision: "ask", reason: "Deletes files." });
  assert.deepEqual(await check({ envelope, tool: "sandbox.run", callId: "c", input: { command: "ls" } }, allow), { decision: "allow" });
});
\`\`\`

## A heartbeat provider

A plugin can decide what the person's heartbeat tells them, in place of the built-in one (\`provides: ["heartbeat"]\`, \`provideHeartbeat({ tick })\`), or add things for it to watch (\`provides: ["heartbeat-signals"]\`, \`provideSignals({ id, collect })\` for each id its \`heartbeatSignals.sources\` lists). A provider receives only what its \`receives\` lists *and* the person switches on — \`instructions\`, \`signals\`, \`ledger\` (what it told lately, with their feedback), \`memory\` — and never sends anything: it answers items, and Tavi validates and delivers them. With \`usesTurns: true\` its tick may call \`host.runTurn({ prompt, tools })\` for a short, metered, read-only model turn. Stop when the tick's \`signal\` fires. The whole contract is in docs/HEARTBEAT-PLUGINS.md.

\`\`\`json
{
  "schemaVersion": 2,
  "abi": "tavi.providers/1",
  "provenance": { "format": "bundled-esm", "packages": [] },
  "id": "acme.watch",
  "version": "0.1.0",
  "name": "Watch",
  "description": "Tells you about a new signal that matches one of your heartbeat instructions, with no model.",
  "entry": "index.mjs",
  "provides": ["heartbeat"],
  "heartbeat": { "abi": "tavi.heartbeat/1", "receives": ["instructions", "signals"], "usesTurns": false, "maxTickSeconds": 10 }
}
\`\`\`

\`\`\`js
export default {
  register({ provideHeartbeat }) {
    provideHeartbeat({
      async tick({ instructions = "", signals, signal }) {
        signal.throwIfAborted();
        // Words of four letters or more from each instruction line; a signal whose title has one is told now.
        const lines = instructions.split("\\n").map((line) => line.toLowerCase().split(/\\W+/).filter((word) => word.length >= 4));
        const items = signals
          .filter((s) => lines.some((words) => words.some((word) => s.title.toLowerCase().includes(word))))
          .slice(0, 10)
          .map((s) => ({ key: \`watch:\${s.key}\`, signalKeys: [s.key], urgency: "now", title: s.title.slice(0, 120), sources: [{ label: s.source, ref: s.key }] }));
        return { items };
      },
    });
  },
};
\`\`\`

An item is \`{ key, urgency: "now" | "later", title (≤120), sources: [{ label, ref? }], body? (≤1,000), signalKeys?, instructionLine?, proposedAction? }\`, at most 10 a tick; the key is stable for the same thing, so it is not told twice. An item with any other field is dropped. Test it as the plugin above:

\`\`\`js
// index.test.mjs — run with: node --test index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
\u0069mport plugin from "./index.mjs";

test("tells a signal that matches an instruction line, and nothing else", async () => {
  let provider;
  plugin.register({ provideHeartbeat: (given) => { provider = given; } });
  const at = "2026-10-11T09:00:00.000Z";
  const signals = [
    { key: "jobs:1", hash: "a", title: "Nightly backup failed", at, source: "Jobs" },
    { key: "jobs:2", hash: "b", title: "Weekly report is ready", at, source: "Jobs" },
  ];
  const { items } = await provider.tick({ instructions: "Tell me if the backup fails", signals, signal: new AbortController().signal });
  assert.deepEqual(items.map((item) => item.key), ["watch:jobs:1"]);
});
\`\`\`

## A memory provider

A plugin can rank what memory recalls, and draft proposals from chats, in place of the built-in one (\`provides: ["memory"]\`, \`provideMemory({ recall, capture?, consolidate?, sync?, status? })\`). The person picks it per workspace (\`tavi memory set-provider <id>\`). It answers ids, never text: Tavi re-checks every id against what the person may read and renders from its own rows, so an id it invents never shows. Its \`receives\` (\`records\`, \`conversation\`) reach it only when the person also switches each on: without \`conversation\` it is never asked to recall or capture (the built-in serves), without \`records\` it is given no memory text, personal memory needs a third switch, and sensitive memory never reaches it. With \`index: "host"\` it ranks the \`candidates\` it is given (or \`host.lexical\`'s ids); with \`index: "own"\` it keeps an index through \`sync\` and must honour every removal. \`capture\` and \`consolidate\` only when \`capabilities\` lists them. Stop when the request's \`signal\` fires. The whole contract is in docs/MEMORY-PLUGINS.md.

\`\`\`json
{
  "schemaVersion": 2,
  "abi": "tavi.providers/1",
  "provenance": { "format": "bundled-esm", "packages": [] },
  "id": "acme.keywords",
  "version": "0.1.0",
  "name": "Keyword memory",
  "description": "Ranks the memories Tavi hands it by the words they share with the query, with no model.",
  "entry": "index.mjs",
  "provides": ["memory"],
  "memory": { "abi": "tavi.memory/1", "capabilities": ["recall"], "index": "host", "receives": ["records", "conversation"] }
}
\`\`\`

\`\`\`js
const words = (text) => new Set(text.toLowerCase().split(/[^\\p{L}\\p{N}]+/u).filter((word) => word.length >= 3));

export default {
  register({ provideMemory }) {
    provideMemory({
      async recall({ query, candidates, limit, host, signal }) {
        signal.throwIfAborted();
        // Without records switched on there are no candidates: rank the host's own search instead.
        if (candidates === undefined) return { hits: (await host.lexical(query, limit)).slice(0, limit) };
        const asked = words(query);
        const hits = candidates
          .map((record) => ({ recordId: record.recordId, revisionId: record.revisionId, score: [...words(\`\${record.title ?? ""} \${record.body}\`)].filter((word) => asked.has(word)).length }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || a.recordId.localeCompare(b.recordId))
          .slice(0, limit);
        return { hits };
      },
    });
  },
};
\`\`\`

A hit is \`{ recordId, revisionId, score }\` and nothing else, at most \`limit\` (≤ 50); a recall on a turn has 1.5 s. Test it as the plugin above:

\`\`\`js
// index.test.mjs — run with: node --test index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
\u0069mport plugin from "./index.mjs";

test("ranks the candidates that share the query's words, and nothing else", async () => {
  let provider;
  plugin.register({ provideMemory: (given) => { provider = given; } });
  const at = "2026-10-11T09:00:00.000Z";
  const candidates = [
    { recordId: "mem-1", revisionId: "rev-1", scopeKey: "personal|p=alice", kind: "fact", body: "Keeps a vegetable garden", recordedAt: at },
    { recordId: "mem-2", revisionId: "rev-2", scopeKey: "personal|p=alice", kind: "fact", body: "Moved to Lisbon", recordedAt: at },
  ];
  const { hits } = await provider.recall({ query: "what grows in the garden", purpose: "turn", scopeKeys: [], candidates, limit: 10, host: { lexical: async () => [] }, signal: new AbortController().signal });
  assert.deepEqual(hits.map((hit) => hit.recordId), ["mem-1"]);
});
\`\`\`

## An ideas provider

A plugin can write a workspace's Ideas — the offers on the Ideas tab and the empty chat's suggested prompts — in place of the built-in one (\`provides: ["ideas"]\`, \`ideas: { abi: "tavi.ideas/1", receives, maxRunSeconds }\`, \`provideIdeas({ generate, status? })\`, approved \`--in-process\`). The person picks it per workspace (\`tavi ideas provider <id>\`). \`generate\` gets the capability census, the limits and only what its \`receives\` lists *and* the person allows (\`memory\`, \`tasks\`, \`brief\`, \`ledger\`), and answers \`{ ideas: [{ idea, score }] }\`; it never stores or sends anything. Tavi drops an idea outside the contract, using a capability the census lacks, or citing a source it was not given, and rewrites every excerpt from the source itself. Test it with \`describeIdeasProviderConformance\` from \`@tavi/plugin-kit/ideas/conformance\`. The whole contract, with an example, is in docs/IDEAS-PLUGINS.md.

A plugin can replace setup's flow — which steps \`tavi onboard\` and the canvas's Welcome walk, in what order, and their words — in place of the built-in one (\`provides: ["onboarding"]\`, \`onboarding: { abi: "tavi.onboarding/1", disclosure? }\`, \`provideOnboarding({ flow })\`, approved \`--in-process\`). The person picks it with \`tavi onboard provider <id>\`. \`flow\` gets the status, the capability census and the *ids* of the presets, channels and apps available, never memory, chats or values, and answers the steps and their copy; Tavi always keeps the model step, drops what is unavailable, falls back to the built-in when it throws or its plugin stops, and makes every change itself. Test it with \`describeOnboardingProviderConformance\` from \`@tavi/plugin-kit/onboarding/conformance\`. The whole contract, with an example, is in docs/ONBOARDING-PLUGINS.md.

## Handing it over

Never install, approve or enable it yourself, not even through a shell: approving is the person's trust decision, and no tool of yours offers it. End with:

\`\`\`bash
tavi plugins install <folder>
tavi plugins show <id>            # read what it declares
tavi plugins approve <id> <version>
tavi plugins enable <id>          # then restart tavi serve
\`\`\`

To try it before installing: \`tavi serve --dev-plugin <folder>\` runs it from the folder for that owner run and reloads it after each save. While it runs that way the folder is read-only to you: the person edits it, or you write it before they start the owner with it.
`;
