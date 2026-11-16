import { ToolSinkSchema, evaluateGate, untrustedLabel, type Confidentiality, type SourceKind } from "@tavi/contracts";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { findFfmpeg } from "@tavi/plugin-video";
import type { ExternalToolRegistration, ToolRegistration } from "@tavi/runtime";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { z } from "zod";

import { SINKS } from "../../../../evals/injection/schema.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { declaredToolSinks } from "../support/tool-sinks.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/**
 * The sink meta-test: every
 * tool the owner registers declares its sink, and the declared sinks are the
 * census — this table, row by row. A tool added without a sink is
 * refused by the registry at start; one added with a sink fails here until
 * the census (and this table) names it.
 */

/** The census: `[sink, urlOnly]`, `urlOnly` stated only where the census says so. */
/** The video tools are registered only where the person's FFmpeg is found: so are their rows. */
function VIDEO_ONLY_WHERE_FFMPEG<T>(rows: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return "missing" in findFfmpeg() ? {} : rows;
}

const CENSUS: Readonly<Record<string, readonly [z.infer<typeof ToolSinkSchema>, boolean?]>> = {
  // none — files
  "fs.read": ["none"],
  "fs.list": ["none"],
  "fs.glob": ["none"],
  "fs.grep": ["none"],
  "sandbox.run": ["none"],
  // none — browser reads
  "browser.read": ["none"],
  "browser.extract": ["none"],
  "browser.find": ["none"],
  "browser.observe": ["none"],
  "browser.structured": ["none"],
  "browser.capture": ["none"],
  "browser.close": ["none"],
  "browser.request_handoff": ["none"],
  // none — memory and records
  "memory.list": ["none"],
  "memory.search": ["none"],
  "memory.get": ["none"],
  "sessions.search": ["none"],
  "agents.read_payload": ["none"],
  "artifacts.read": ["none"],
  "math.eval": ["none"],
  "skills.read": ["none"],
  "skills.search": ["none"],
  "artifacts.view_image": ["none"],
  "projects.get": ["none"],
  "collect.daily": ["none"],
  "reports.history": ["none"],
  "reports.generate": ["none"],
  // none — business collectors
  "ga4.report": ["none"],
  "gsc.query": ["none"],
  "gcp.billing": ["none"],
  "stripe.subscriptions": ["none"],
  // none — task state and agents
  "findings.add": ["none"],
  "findings.check": ["none"],
  "findings.list": ["none"],
  "plan.update": ["none"],
  "agents.spawn": ["none"],
  "agents.send": ["none"],
  "agents.request": ["none"],
  "agents.reply": ["none"],
  "agents.wait": ["none"],
  "agents.status": ["none"],
  "agents.cancel": ["none"],
  // none — other
  "operator.ask_user": ["none"],
  "messaging.channels": ["none"],
  "messaging.poll_results": ["none"],
  "messaging.recent": ["none"],
  "heartbeat.status": ["none"],
  "reminders.list": ["none"],
  "todos.list": ["none"],
  "schedules.list": ["none"],
  "schedules.history": ["none"],
  "reminders.snooze": ["none"],
  "routines.get": ["none"],
  "routines.list": ["none"],
  "routines.history": ["none"],
  "routines.inspect": ["none"],
  "routines.targets": ["none"],
  "routines.preview": ["none"],
  "routines.pause": ["none"],
  "routines.revoke_grant": ["none"],
  "routines.archive": ["none"],
  "routines.cancel_run": ["none"],
  "plugins.authoring_guide": ["none"],
  "fixture.capture": ["none"],
  "fixture.echo": ["none"],
  "pdf.read": ["none"],
  "pdf.view": ["none"],
  "pdf.fields": ["none"],
  "pdf.render": ["none"],
  // the video tools: read-only, raised per call to network only for a remote analyser
  ...VIDEO_ONLY_WHERE_FFMPEG({
    "video.info": ["none"],
    "video.frames": ["none"],
    "video.view": ["none"],
    "video.pose": ["none"],
    "video.transcribe": ["none"],
  }),
  // reply
  "messaging.send": ["reply"],
  "heartbeat.report": ["reply"],
  // network, urlOnly
  web_fetch: ["network", true],
  "browser.create_session": ["network", true],
  "browser.navigate": ["network", true],
  "heartbeat.fetch": ["network", true],
  // network with payload
  "http.request": ["network", false],
  "browser.act": ["network", false],
  "browser.batch": ["network", false],
  "browser.vision_act": ["network", false],
  // search (news.search: narrowed to none per call, its query being the project's configured keywords)
  web_search: ["search"],
  "news.search": ["search"],
  "travel.flights_search": ["search"],
  // message
  "messaging.send_to": ["message"],
  "routines.run": ["message"],
  "schedules.run_now": ["message"],
  "routines.retry_delivery": ["message"],
  "routines.resume_delivery": ["message"],
  // the group tools: what the task's own room sees
  "messaging.create_poll": ["message"],
  "messaging.end_poll": ["message"],
  "messaging.create_event": ["message"],
  // persist (fs.write/fs.edit: the static sink; inside the managed folder the per-call assessment narrows to none)
  "memory.propose": ["persist"],
  "memory.forget": ["persist"],
  "skills.propose": ["persist"],
  "reminders.create": ["persist"],
  "reminders.update": ["persist"],
  "reminders.cancel": ["persist"],
  "todos.add": ["persist"],
  "todos.complete": ["persist"],
  "todos.update": ["persist"],
  "todos.remove": ["persist"],
  "schedules.create": ["persist"],
  "schedules.update": ["persist"],
  "schedules.pause": ["persist"],
  "schedules.resume": ["persist"],
  "schedules.cancel": ["persist"],
  "routines.create": ["persist"],
  "routines.update": ["persist"],
  "routines.undo": ["persist"],
  "routines.resume": ["persist"],
  "routines.reevaluate": ["persist"],
  "routines.add_target": ["persist"],
  "heartbeat.propose": ["persist"],
  "fs.write": ["persist"],
  "fs.edit": ["persist"],
  "plugins.validate": ["persist"],
  // pdf.fill: a new copy; narrowed to none per call inside the chat's managed folder
  "pdf.fill": ["persist"],
  // pdf.overlay: the same write, over a flat form's entry boxes
  "pdf.overlay": ["persist"],
};

/**
 * The output labels: `[untrustedOutput, outputSource, outputConfidentiality]`
 * as each built-in declares them. A tool not listed declares none of the three:
 * its output is trusted and public, unless a result's own label raises it
 * (`TOOL_UNTRUSTED_KEY`, `TOOL_LABEL_KEY`). `outputSource` on a trusted tool is
 * the source a result it marks untrusted names (a read of `downloads/`).
 */
const OUTPUT_LABELS: Readonly<Record<string, readonly [boolean | undefined, SourceKind | undefined, Confidentiality | undefined]>> = {
  // web: pages and remote bodies; every browser read is personal (the persistent profile holds the person's cookies)
  web_fetch: [true, "web", undefined],
  "heartbeat.fetch": [true, "heartbeat", undefined],
  "http.request": [true, "web", undefined], // personal per call when credentialed
  "browser.act": [true, "web", "personal"],
  "browser.batch": [true, "web", "personal"],
  "browser.capture": [true, "web", "personal"],
  "browser.create_session": [true, "web", "personal"],
  "browser.extract": [true, "web", "personal"],
  "browser.find": [true, "web", "personal"],
  "browser.navigate": [true, "web", "personal"],
  "browser.observe": [true, "web", "personal"],
  "browser.read": [true, "web", "personal"],
  "browser.structured": [true, "web", "personal"],
  "browser.request_handoff": [true, "web", "personal"],
  "browser.vision_act": [true, "web", "personal"],
  // search
  web_search: [true, "search", undefined],
  "news.search": [true, "search", undefined],
  "travel.flights_search": [true, "search", undefined],
  // agents, past chats, routine output, artifacts
  // agents.wait: labelled per result by its sender's label, an unlabelled one an agent's
  "agents.wait": [undefined, "agent", undefined],
  "agents.status": [undefined, "agent", undefined],
  "agents.spawn": [undefined, "agent", undefined],
  "agents.read_payload": [undefined, "agent", undefined],
  "artifacts.read": [undefined, "attachment", undefined],
  "artifacts.view_image": [undefined, "attachment", undefined],
  // untrusted and personal per result: a search that read no chat marks nothing
  "sessions.search": [undefined, "past-chat", undefined],
  // a poll's votes are the room's members'
  "messaging.poll_results": [true, "chat-other", undefined],
  "messaging.recent": [true, "chat-other", undefined],
  "findings.check": [true, "routine-output", undefined],
  "findings.list": [true, "routine-output", undefined],
  // a run's output; every other routine answer is untrusted per result when the revision it shows carries provenance
  "reports.history": [true, "routine-output", undefined],
  "routines.inspect": [true, "routine-output", undefined],
  "routines.run": [true, "routine-output", undefined],
  "routines.preview": [true, "routine-output", undefined],
  "routines.cancel_run": [true, "routine-output", undefined],
  // trusted but personal: memory, business collectors; `memory.search` and `memory.list` are personal per result, when they read a record
  "memory.get": [undefined, undefined, "personal"],
  "ga4.report": [undefined, undefined, "personal"],
  "gsc.query": [undefined, undefined, "personal"],
  "gcp.billing": [undefined, undefined, "personal"],
  "stripe.subscriptions": [undefined, undefined, "personal"],
  // routine output: the daily collection carries feed and search headlines
  "collect.daily": [true, "routine-output", "personal"],
  // trusted, untrusted per call: a read of downloads/ or of a tainted chat's folder (and personal per call in a host folder); the shell while downloads/ holds a file or a folder it reaches is a tainted chat's
  "fs.read": [undefined, "download", undefined],
  "fs.list": [undefined, "download", undefined],
  "fs.glob": [undefined, "download", undefined],
  "fs.grep": [undefined, "download", undefined],
  "sandbox.run": [undefined, "sandbox", undefined],
  // a PDF: labelled per result by its source (an attachment's stored label, a folder file's read label)
  "pdf.read": [undefined, "attachment", undefined],
  "pdf.view": [undefined, "attachment", undefined],
  "pdf.fields": [undefined, "attachment", undefined],
  "pdf.render": [undefined, "attachment", undefined],
  // a video: labelled per result by its source, as a PDF is
  ...VIDEO_ONLY_WHERE_FFMPEG({
    "video.info": [undefined, "attachment", undefined],
    "video.frames": [undefined, "attachment", undefined],
    "video.view": [undefined, "attachment", undefined],
    "video.pose": [undefined, "attachment", undefined],
    "video.transcribe": [undefined, "attachment", undefined],
  }),
};

describe("declared sinks", () => {
  it("every registered tool declares a sink, and the declared sinks are the census", async () => {
    const declared = await declaredToolSinks();
    // The full list, printed for the review of a change that moves one.
    console.info(declared.map(({ id, sink, urlOnly }) => `${id}: ${sink}${urlOnly === undefined ? "" : ` urlOnly=${urlOnly}`}`).join("\n"));
    expect(declared.filter((tool) => tool.sink === undefined).map((tool) => tool.id)).toEqual([]);
    const expected = Object.entries(CENSUS)
      .map(([id, [sink, urlOnly]]) => ({ id, sink, urlOnly }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(declared.map(({ id, sink, urlOnly }) => ({ id, sink, urlOnly }))).toEqual(expected);
  }, 60_000);

  it("every registered tool's output label is the table's", async () => {
    const declared = await declaredToolSinks();
    const actual = declared.map(({ id, untrustedOutput, outputSource, outputConfidentiality }) => ({
      id,
      label: [untrustedOutput, outputSource, outputConfidentiality],
    }));
    const expected = declared.map(({ id }) => ({ id, label: [...(OUTPUT_LABELS[id] ?? [undefined, undefined, undefined])] }));
    expect(actual).toEqual(expected);
    // The table names only registered tools.
    expect(Object.keys(OUTPUT_LABELS).filter((id) => !declared.some((tool) => tool.id === id))).toEqual([]);
  }, 60_000);

  it("the eval's sink vocabulary is the contract's", () => {
    expect([...SINKS]).toEqual(ToolSinkSchema.options);
  });

  it("narrows news.search to none per call: its only input is a configured project id, so a search under [A]∧[B] does not ask", async () => {
    const data = directories.create("tavi-sinks-news-");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { scheduleSweepEnabled: false, approvalRequiredFor: [] }), {
      modelOverride: createFixtureModel({ turns: [] }),
    });
    try {
      const definition = runtime.tools.get("news.search");
      const assessment = definition?.assess?.(
        { projectId: "acme" },
        { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" },
      );
      expect(assessment?.sink).toBe("none");
      const verdict = evaluateGate({
        toolId: "news.search",
        effect: "read-only",
        sink: "search",
        ...(assessment === undefined ? {} : { assessment }),
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(),
        tainted: true,
        label: untrustedLabel("web", { confidentiality: "personal" }),
      });
      expect(verdict.gateReason).toBeUndefined();
      expect(verdict.decision).toBe("allow");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("a built-in registered later without a sink is refused at start", async () => {
    const data = directories.create("tavi-sinks-late-");
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { scheduleSweepEnabled: false, approvalRequiredFor: [] }), {
      modelOverride: createFixtureModel({ turns: [] }),
    });
    try {
      // The compiler refuses a built-in without a sink; this stands for a caller it never saw (plain JavaScript).
      const late: ExternalToolRegistration = {
        id: "fixture.late",
        version: "1",
        description: "A tool with no sink",
        effect: "read-only",
        requiredPermissions: [],
        inputSchema: z.object({}),
        handler: async () => ({}),
      };
      expect(() => runtime.tools.register(late as ToolRegistration)).toThrowError(/Built-in tool fixture\.late declares no sink/);
      expect(runtime.tools.has("fixture.late")).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
