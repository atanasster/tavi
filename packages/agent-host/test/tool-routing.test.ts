import { describe, expect, it } from "vitest";
import { MAX_MODEL_TOOLS, type ToolDefinition } from "@tavi/contracts";
import {
  appendDiscovered,
  deferAttendedFamilies,
  deferredFamilyLines,
  discoverTools,
  toolSearchTerms,
  documentTools,
  namedTools,
  fitToolList,
  routedToolIdsOf,
  routedToolList,
  mentionsPdf,
  mentionsReminder,
  mentionsAudio,
  mentionsVideo,
  shortlistTools,
  toolAdviceCandidates,
  toolRevision,
  toolSearchDefinition,
  toolSearchDefinitionFor,
  toolSearchDescriptorFor,
} from "../src/tools/tool-routing.js";
const tools: ToolDefinition[] = Array.from({ length: 90 }, (_, index) => ({
  id: `fixture.t${index}`,
  version: "1",
  description: `Tool number ${index}`,
  effect: "read-only",
  requiredPermissions: [],
}));
describe("bounded tool projection", () => {
  it("keeps protected controls, discoveries and a stable optional shortlist under the descriptor bound", () => {
    const selected = shortlistTools([...tools, toolSearchDefinition], "number", tools.map((tool) => tool.id).reverse(), [
      "fixture.t0",
      "fixture.t1",
    ]);
    expect(selected).toHaveLength(15);
    expect(selected[0]?.id).toBe("fixture.t0");
    expect(selected.at(-1)?.id).toBe("tools.search");
    expect(selected.filter((tool) => tool.id !== "tools.search").map((tool) => Number(tool.id.slice(9)))).toEqual([
      0, 1, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    ]);
  });
  it("offers the browser when the prompt names a site, whose words match no tool", () => {
    const browser: ToolDefinition[] = ["browser.create_session", "browser.navigate", "browser.read"].map((id) => ({
      id,
      version: "1",
      description: "Browser",
      effect: "external",
      requiredPermissions: [],
    }));
    const ids = (query: string) => shortlistTools([...tools, ...browser], query, [], []).map((tool) => tool.id);
    expect(ids("analyze smart.example.com and summarize it")).toEqual(
      expect.arrayContaining(["browser.create_session", "browser.navigate", "browser.read"]),
    );
    expect(ids("summarize gpt-4.1 release notes")).not.toContain("browser.create_session");
  });
  it("offers the reminder tools when the prompt asks to be reminded or names a time, whatever the router chose", () => {
    const reminders: ToolDefinition[] = ["reminders.create", "reminders.list"].map((id) => ({
      id,
      version: "1",
      description: "Reminders",
      effect: "mutating",
      requiredPermissions: [],
    }));
    const ids = (query: string, selected: readonly string[] = []) =>
      shortlistTools([...tools, ...reminders], query, selected, []).map((tool) => tool.id);
    for (const query of [
      "ping me tomorrow about the rent",
      "don't let me forget the pills",
      "take my pills at 9pm",
      "water the plants every evening",
      "remind me to call mum",
    ]) {
      expect(ids(query)).toEqual(expect.arrayContaining(["reminders.create", "reminders.list"]));
    }
    expect(ids("remind me to call mum", ["fixture.t3"])).toEqual(expect.arrayContaining(["fixture.t3", "reminders.create"]));
    for (const query of ["call the bank at 9", "stand-up at 21:00", "leave by 7pm", "call her at 9 tomorrow"])
      expect(ids(query)).toContain("reminders.create");
    for (const query of ["summarize the release notes", "look at 3 files", "grow revenue by 10 percent", "look at 10 sites"])
      expect(ids(query)).not.toContain("reminders.create");
  });
  it("offers the PDF tools when any message of the conversation holds a PDF, after the router's own picks", () => {
    // The person's newest words name no PDF two turns after the attachment.
    expect(
      mentionsPdf([
        "[Attachment form.pdf (application/pdf, 120 KB): artifact a1, untrusted content from the sender]",
        "fill out the packet",
      ]),
    ).toBe(true);
    expect(mentionsPdf(["see ~/Documents/packet.PDF"])).toBe(true);
    expect(mentionsPdf(["fill out the packet"])).toBe(false);
    const pdf: ToolDefinition[] = ["pdf.read", "pdf.view", "pdf.fields", "pdf.render", "pdf.fill", "pdf.overlay"].map((id) => ({
      id,
      version: "1",
      description: "PDF",
      effect: "read-only",
      requiredPermissions: [],
    }));
    const ids = (pdfInConversation: boolean) =>
      shortlistTools([...tools, ...pdf], "fill out the packet", ["fixture.t3"], [], new Set(), { pdfInConversation }).map(
        (tool) => tool.id,
      );
    expect(ids(false)).toEqual(["fixture.t3"]);
    expect(ids(true)).toEqual(["fixture.t3", "pdf.read", "pdf.view", "pdf.fields", "pdf.render", "pdf.fill", "pdf.overlay"]);
    // With the router's picks leaving room for three, reading and filling are what stay.
    const nine = tools.slice(0, 9).map((tool) => tool.id);
    const tight = shortlistTools([...tools, ...pdf], "fill out the packet", nine, [], new Set(), { pdfInConversation: true })
      .map((tool) => tool.id)
      .filter((id) => id.startsWith("pdf."));
    expect(tight).toEqual(["pdf.read", "pdf.fields", "pdf.fill"]);
  });
  it("offers audio.transcribe first when the conversation holds a voice message", () => {
    const line =
      "[Attachment voice.ogg (audio/ogg, 12 KB): artifact a1, untrusted content from the sender; what is said in it: audio.transcribe]";
    expect(mentionsAudio([line])).toBe(true);
    expect(mentionsAudio(["[Attachment squat.mp4 (video/mp4, 4 MB): artifact a1]", "play some audio"])).toBe(false);
    expect(documentTools(false, false, false, true)).toEqual(["audio.transcribe"]);
    expect(documentTools(true, false, false, true)[0]).toBe("audio.transcribe");
    const audio: ToolDefinition = {
      id: "audio.transcribe",
      version: "1",
      description: "audio",
      effect: "read-only",
      requiredPermissions: [],
      deferred: true,
    };
    const offered = (audioInConversation: boolean) =>
      shortlistTools([...tools, audio], "", [], [], new Set(), { audioInConversation }).map((tool) => tool.id);
    expect(offered(true)).toContain("audio.transcribe");
    expect(offered(false)).not.toContain("audio.transcribe");
  });
  it("offers the video tools when the conversation holds a video, and with a PDF too keeps the first three of each", () => {
    expect(
      mentionsVideo(["[Attachment squat.mp4 (video/mp4, 4 MB): artifact a1, untrusted content from the sender]", "what am I doing wrong?"]),
    ).toBe(true);
    expect(mentionsVideo(["[Attachment cat.gif (image/gif, 1 MB): artifact a2]"])).toBe(true);
    expect(mentionsVideo(["look at ~/Movies/ride.MOV"])).toBe(true);
    expect(mentionsVideo(["what am I doing wrong?", "the movie was good"])).toBe(false);
    const doc = (prefix: string, names: readonly string[]): ToolDefinition[] =>
      names.map((name) => ({ id: `${prefix}.${name}`, version: "1", description: prefix, effect: "read-only", requiredPermissions: [] }));
    const pdf = doc("pdf", ["read", "view", "fields", "render", "fill", "overlay"]);
    const video = doc("video", ["frames", "view", "pose", "info", "transcribe"]);
    const ids = (pdfInConversation: boolean, videoInConversation: boolean) =>
      shortlistTools([...tools, ...pdf, ...video], "what is wrong here", ["fixture.t3"], [], new Set(), {
        pdfInConversation,
        videoInConversation,
      }).map((tool) => tool.id);
    expect(ids(false, true).filter((id) => id.startsWith("video."))).toEqual([
      "video.frames",
      "video.view",
      "video.pose",
      "video.info",
      "video.transcribe",
    ]);
    // Both held and room for six: the first three of each.
    const six = tools.slice(0, 6).map((tool) => tool.id);
    const both = shortlistTools([...tools, ...pdf, ...video], "what is wrong here", six, [], new Set(), {
      pdfInConversation: true,
      videoInConversation: true,
    })
      .map((tool) => tool.id)
      .filter((id) => id.startsWith("pdf.") || id.startsWith("video."));
    expect(both).toEqual(["pdf.read", "pdf.fields", "pdf.fill", "video.frames", "video.view", "video.pose"]);
  });
  it("never displaces the router's own picks with the reminder tools, and adds them only in the room left", () => {
    const reminders: ToolDefinition[] = ["reminders.create", "reminders.list"].map((id) => ({
      id,
      version: "1",
      description: "Reminders",
      effect: "mutating",
      requiredPermissions: [],
    }));
    const ids = (selected: readonly string[]) =>
      shortlistTools([...tools, ...reminders], "remind me tomorrow", selected, []).map((tool) => tool.id);
    const twelve = tools.slice(0, 12).map((tool) => tool.id);
    expect(ids(twelve)).toEqual(twelve);
    expect(ids(twelve.slice(0, 10))).toEqual([...twelve.slice(0, 10), "reminders.create", "reminders.list"]);
  });
  it("fails clearly when protected controls alone exceed the model contract's tools", () => {
    const many: ToolDefinition[] = Array.from({ length: MAX_MODEL_TOOLS + 1 }, (_, index) => ({
      id: `fixture.p${index}`,
      version: "1",
      description: `Protected ${index}`,
      effect: "read-only",
      requiredPermissions: [],
    }));
    expect(() => shortlistTools(many, "", [], [], new Set(many.map((tool) => tool.id)))).toThrow(`${MAX_MODEL_TOOLS}-descriptor`);
  });
  it("splits ids on dots, underscores and hyphens, drops stop words and plural s, and ranks an id match first", () => {
    expect(toolSearchTerms("Remind me about the reminders.create_now tool")).toEqual(["remind", "about", "reminder", "create", "now"]);
    expect(toolSearchTerms("memories searches boxes status access")).toEqual(["memory", "search", "box", "status", "access"]);
    const pick = (id: string, description: string): ToolDefinition => ({
      id,
      version: "1",
      description,
      effect: "read-only",
      requiredPermissions: [],
    });
    const catalog = [
      pick("notes.write", "Write a note; it can mention a reminder in passing"),
      pick("reminders.cancel", "Stop one"),
      pick("reminders.list", "What is set"),
    ];
    expect(discoverTools("cancel my reminder", catalog, 8).map((tool) => tool.id)).toEqual([
      "reminders.cancel",
      "reminders.list",
      "notes.write",
    ]);
    // A tool the turn already offers is not found again.
    expect(discoverTools("cancel my reminder", catalog, 8, new Set(["reminders.cancel"])).map((tool) => tool.id)).not.toContain(
      "reminders.cancel",
    );
  });

  it("answers a family's name with the whole family, and select: with exactly the tools named", () => {
    const pick = (id: string): ToolDefinition => ({ id, version: "1", description: id, effect: "read-only", requiredPermissions: [] });
    const catalog = [pick("pdf.read"), pick("pdf.fill"), pick("notes.write"), pick("reminders.cancel")];
    expect(discoverTools("pdf", catalog, 8).map((tool) => tool.id)).toEqual(["pdf.read", "pdf.fill"]);
    expect(discoverTools("pdf.*", catalog, 8, new Set(["pdf.read"])).map((tool) => tool.id)).toEqual(["pdf.fill"]);
    expect(discoverTools("select:reminders.cancel, notes.write", catalog, 8).map((tool) => tool.id)).toEqual([
      "reminders.cancel",
      "notes.write",
    ]);
    expect(discoverTools("select:nothing.here", catalog, 8)).toEqual([]);
  });

  it("brings a reminder turn's deferred reminder tools in, as a PDF's words do the PDF tools", () => {
    expect(mentionsReminder(["remind me to call Ana tomorrow"])).toBe(true);
    expect(mentionsReminder(["what is 17% of 2340"])).toBe(false);
    expect(documentTools(false, false, true)).toEqual([
      "reminders.update",
      "reminders.cancel",
      "reminders.snooze",
      "schedules.create",
      "schedules.list",
      "schedules.update",
      "schedules.pause",
    ]);
    expect(documentTools(false, false)).toEqual([]);
  });

  it("bounds discovery and returns no unrelated result on no match", () => {
    expect(discoverTools("number", tools, 100)).toHaveLength(8);
    expect(discoverTools("zebra", tools, 8)).toEqual([]);
    expect(shortlistTools(tools, "zebra", [], [])).toHaveLength(12);
  });
});

describe("deferred tools and the MCP budget guard", () => {
  const tool = (id: string, deferred = false) => ({
    id,
    version: "1",
    description: id,
    effect: "read-only" as const,
    requiredPermissions: [],
    ...(deferred ? { deferred: true } : {}),
  });
  it("leaves a deferred tool out until search finds it, offering tools.search meanwhile", () => {
    const tools = [tool("files.read"), tool("mcp.docs.search", true)];
    expect(fitToolList(tools, [], true).map((entry) => entry.id)).toEqual(["files.read", "tools.search"]);
    expect(fitToolList(tools, ["mcp.docs.search"], true).map((entry) => entry.id)).toEqual(["files.read", "mcp.docs.search"]);
    expect(fitToolList(tools, [], false).map((entry) => entry.id)).toEqual(["files.read"]);
  });

  it("never fails a turn: past 128, MCP tools go from the end", () => {
    const tools = [
      ...Array.from({ length: 100 }, (_, index) => tool(`core.t${String(index)}`)),
      ...Array.from({ length: 40 }, (_, index) => tool(`mcp.big.t${String(index)}`)),
    ];
    const fitted = fitToolList(tools, [], true);
    expect(fitted).toHaveLength(128);
    expect(fitted.filter((entry) => entry.id.startsWith("core.")).length).toBe(100);
    expect(fitted.at(-1)?.id).toBe("mcp.big.t27");
  });

  it("tools.search carries a line per server behind it, and a changed line is a changed revision", () => {
    expect(toolSearchDefinitionFor([])).toBe(toolSearchDefinition);
    const withLines = toolSearchDefinitionFor(["big: 40 tools (a, b, …)", "Calendar — my work calendar"]);
    expect(withLines.description).toBe(
      `${toolSearchDefinition.description}\nTools that wait behind this search:\n- big: 40 tools (a, b, …)\n- Calendar — my work calendar`,
    );
    expect(toolSearchDescriptorFor(withLines)).toMatchObject({
      id: "tools.search",
      name: "tools_search",
      description: withLines.description,
    });
    const registry = { inputJsonSchemaOf: () => ({}), modelNameOf: (id: string) => id } as never;
    expect(toolRevision(registry, withLines)).not.toBe(toolRevision(registry, toolSearchDefinitionFor(["big: 41 tools"])));
    // The search offered with deferred tools left out is this turn's.
    expect(fitToolList([tool("files.read"), tool("mcp.big.a", true)], [], true, { search: withLines }).at(-1)).toBe(withLines);
  });

  it("a tool a task's allowlist names is offered directly, deferred or not", () => {
    const tools = [tool("files.read"), tool("mcp.big.a", true), tool("mcp.big.b", true)];
    expect(fitToolList(tools, [], false, { named: new Set(["mcp.big.a"]) }).map((entry) => entry.id)).toEqual(["files.read", "mcp.big.a"]);
  });

  it("an allowlist's pattern names the deferred tools it matches; `*` alone names none", () => {
    const tools = [tool("files.read"), tool("mcp.big.a", true), tool("mcp.big.b", true), tool("mcp.other.a", true)];
    expect([...namedTools(tools, ["mcp.big.*", "files.read"])]).toEqual(["mcp.big.a", "mcp.big.b"]);
    expect([...namedTools(tools, ["*"])]).toEqual([]);
    expect(fitToolList(tools, [], false, { named: namedTools(tools, ["mcp.big.*"]) }).map((entry) => entry.id)).toEqual([
      "files.read",
      "mcp.big.a",
      "mcp.big.b",
    ]);
  });

  it("defers an attended chat's rarely used built-in families, with a search line for each one offered", () => {
    const deferred = deferAttendedFamilies([
      tool("fs.read"),
      tool("routines.create"),
      tool("pdf.read"),
      tool("heartbeat.status"),
      tool("heartbeat.tick"),
    ]);
    expect(deferred.filter((entry) => entry.deferred === true).map((entry) => entry.id)).toEqual([
      "routines.create",
      "pdf.read",
      "heartbeat.status",
    ]);
    expect(deferredFamilyLines(deferred.filter((entry) => entry.deferred === true))).toEqual([
      "routines.*: create, change, run, pause and inspect routines",
      "heartbeat.status, heartbeat.propose: read or propose the heartbeat's settings",
      "pdf.*: read, fill, overlay and render PDF files",
    ]);
    // A PDF in the conversation brings its tools in as found, never by rank.
    const found = documentTools(true, false);
    expect(fitToolList(deferred, found, true).map((entry) => entry.id)).toEqual(["fs.read", "pdf.read", "heartbeat.tick", "tools.search"]);
    // Under v2 they are appended where a discovery is, after an earlier search's find.
    expect(
      fitToolList(deferred, appendDiscovered(["routines.create"], found), true, { appendDiscovered: true }).map((entry) => entry.id),
    ).toEqual(["fs.read", "heartbeat.tick", "routines.create", "pdf.read", "tools.search"]);
  });

  it("keeps adding, listing and ticking off to-dos listed, and defers changing and removing one", () => {
    const deferred = deferAttendedFamilies(
      ["todos.add", "todos.list", "todos.complete", "todos.update", "todos.remove"].map((id) => tool(id)),
    );
    expect(deferred.filter((entry) => entry.deferred === true).map((entry) => entry.id)).toEqual(["todos.update", "todos.remove"]);
    expect(deferredFamilyLines(deferred)).toEqual(["todos.update, todos.remove: change or remove a to-do"]);
  });

  it("a routed shortlist offers every document tool a held PDF and video call for, past the eight expansions", () => {
    const deferred = deferAttendedFamilies([...documentTools(true, true).map((id) => tool(id)), tool("fs.read"), toolSearchDefinition]);
    const shortlist = shortlistTools(deferred, "what is in these", [], documentTools(true, true), undefined, {
      pdfInConversation: true,
      videoInConversation: true,
    }).map((entry) => entry.id);
    expect(shortlist).toEqual(expect.arrayContaining([...documentTools(true, true)]));
  });

  it("a deferred tool is never ranked or advised in; only search brings it", () => {
    const listed = [tool("files.read"), tool("mcp.docs.search", true), toolSearchDefinition];
    expect(shortlistTools(listed, "docs search", [], []).map((entry) => entry.id)).toEqual(["files.read", "tools.search"]);
    expect(shortlistTools(listed, "docs search", [], ["mcp.docs.search"]).map((entry) => entry.id)).toContain("mcp.docs.search");
    expect(
      toolAdviceCandidates({ inputJsonSchemaOf: () => ({}), modelNameOf: (id: string) => id } as never, listed).map((entry) => entry.id),
    ).toEqual(["files.read"]);
  });
});

describe("models.promptLayout v2's stable tool lists", () => {
  const tool = (id: string, deferred = false): ToolDefinition => ({
    id,
    version: "1",
    description: id,
    effect: "read-only",
    requiredPermissions: [],
    ...(deferred ? { deferred: true } : {}),
  });

  it("appends discoveries in the order found, leaving earlier ones where they were", () => {
    expect(appendDiscovered(["a", "b"], ["c", "a", "d", "c"])).toEqual(["a", "b", "c", "d"]);
    const many = Array.from({ length: 40 }, (_, index) => `t${index}`);
    expect(appendDiscovered([], many)).toEqual(many.slice(-32));
  });

  it("lists discovered tools after the rest, in the order found, instead of at their registry position", () => {
    const registry = [tool("a.read"), tool("b.archive", true), tool("c.write"), tool("d.export", true)];
    expect(fitToolList(registry, ["d.export", "b.archive"], true, { appendDiscovered: true }).map((entry) => entry.id)).toEqual([
      "a.read",
      "c.write",
      "d.export",
      "b.archive",
    ]);
    expect(fitToolList(registry, ["d.export", "b.archive"], true).map((entry) => entry.id)).toEqual([
      "a.read",
      "b.archive",
      "c.write",
      "d.export",
    ]);
  });

  it("keeps the epoch's routed tools first, in the order first offered, and appends what a turn adds", () => {
    const registry = [tool("a"), tool("b"), tool("c"), tool("d")];
    const list = routedToolList(registry, ["c", "a"], [registry[1]!, registry[3]!]);
    expect(routedToolIdsOf(list)).toEqual(["c", "a", "b", "d"]);
    // A routed tool no longer authorized is left out.
    expect(routedToolIdsOf(routedToolList(registry.slice(0, 2), ["c", "a"], [registry[1]!]))).toEqual(["a", "b"]);
    // One the turn's shortlist picks again keeps its place: the array only grows.
    expect(routedToolIdsOf(routedToolList(registry, ["c", "a", "b", "d"], [registry[0]!, registry[1]!]))).toEqual(["c", "a", "b", "d"]);
  });

  it("drops the oldest earlier routed tools past the descriptor bound, never one this turn chose", () => {
    const registry = Array.from({ length: MAX_MODEL_TOOLS + 10 }, (_, index) => tool(`t${String(index).padStart(3, "0")}`));
    const earlier = registry.slice(0, MAX_MODEL_TOOLS).map((entry) => entry.id);
    const chosen = registry.slice(MAX_MODEL_TOOLS);
    const list = routedToolList(registry, earlier, chosen, new Set());
    expect(list).toHaveLength(MAX_MODEL_TOOLS);
    expect(list.slice(-10).map((entry) => entry.id)).toEqual(chosen.map((entry) => entry.id));
    expect(list[0]?.id).toBe("t010");
  });

  it("trims the other MCP tools before an appended discovery past the bound, then the oldest discovery", () => {
    const listed = Array.from({ length: MAX_MODEL_TOOLS }, (_, index) => tool(`mcp.s${String(index).padStart(3, "0")}`));
    const found = [tool("mcp.found.a", true), tool("mcp.found.b", true)];
    const fitted = fitToolList([...listed, ...found], ["mcp.found.a", "mcp.found.b"], false, { appendDiscovered: true });
    expect(fitted).toHaveLength(MAX_MODEL_TOOLS);
    expect(fitted.slice(-2).map((entry) => entry.id)).toEqual(["mcp.found.a", "mcp.found.b"]);
    const onlyFound = Array.from({ length: MAX_MODEL_TOOLS + 1 }, (_, index) => tool(`mcp.f${String(index).padStart(3, "0")}`, true));
    const ids = onlyFound.map((entry) => entry.id);
    expect(fitToolList(onlyFound, ids, false, { appendDiscovered: true }).map((entry) => entry.id)).toEqual(ids.slice(1));
  });
});
