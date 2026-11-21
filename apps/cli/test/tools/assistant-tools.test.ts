import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { join } from "node:path";

import {
  SHIPPED_TOOL_RULES,
  TOOL_LABEL_KEY,
  TOOL_MEDIA_KEY,
  TRUSTED_PUBLIC,
  evaluateGate,
  isUntrusted,
  isTrustedPublic,
  labelledResult,
  toolResultLabel,
  untrustedLabel,
  planLines,
  topicConversationKey,
  type AgentCommunicationServicePort,
  type ContentLabel,
  type InvocationContext,
} from "@tavi/contracts";
import { toSdkMessages } from "@tavi/agent-host/models";
import { ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories, partialFake } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_READ_PAGE_BYTES,
  imageDimensionsOf,
  pastChatSearchTerms,
  registerAssistantTools,
} from "../../src/features/tools/assistant.js";
import { agentActorFrom, registerAgentTools } from "../../src/features/agents/tools.js";
import { assessHttpRequest, assessSandboxRun } from "../../src/features/approvals/call-assessors.js";
import { delegationRootOrigin, heldChannelOf, heldConnectionOf, memoryReachOf, turnChannelOf } from "../../src/runtime/chat-scope.js";
import { messagingProfileRules } from "../../src/runtime/messaging-rules.js";

/** The working tools and the messaging profile. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const context: InvocationContext = { workspaceId: "default", principalId: "alice", runId: "task-now", caller: "test" };

async function openStore(): Promise<SqliteStore> {
  const directory = directories.create("tavi-assistant-");
  return await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

function tools(store: SqliteStore, as: InvocationContext = context) {
  const registry = new ToolRegistry();
  registerAssistantTools(registry, { searchHistory: async (input) => store.searchTaskHistory(input), artifacts: store });
  return (id: string, input: unknown) => {
    const tool = registry.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    return tool.handler({ input, context: as, signal: new AbortController().signal });
  };
}

describe("plan.update", () => {
  it("counts the plan, refuses two steps in progress, and lists it as a checklist", async () => {
    const store = await openStore();
    try {
      const call = tools(store);
      const plan = {
        items: [
          { content: "read", status: "done" },
          { content: "write", status: "in_progress" },
          { content: "test", status: "pending" },
        ],
      };
      expect(await call("plan.update", plan)).toEqual({ steps: 3, done: 1, remaining: 2 });
      await expect(
        call("plan.update", {
          items: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "in_progress" },
          ],
        }),
      ).rejects.toThrow(/at most one/);
      expect(planLines(plan)).toEqual(["☑ read", "◐ write", "☐ test"]);
    } finally {
      store.close();
    }
  });
});

describe("sessions.search", () => {
  it("finds a principal's earlier prompts in its workspace only", async () => {
    const store = await openStore();
    try {
      const admit = async (taskId: string, principalId: string, prompt: string) =>
        await store.asPort().repositories.tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: "default",
          principalId,
          operationKey: `op-${taskId}`,
          kind: "start",
          intent: { prompt },
          checkpointNamespace: "",
          newTaskId: (() => taskId)(),
          newAdmissionId: (() => `adm-${taskId}`)(),
          newThreadId: (() => `thread-${taskId}`)(),
          now: (() => "2026-09-01T00:00:00.000Z")(),
        });
      await admit("t-1", "alice", "Draft the quarterly Stripe revenue memo");
      await admit("t-2", "bob", "Stripe keys rotation for bob");
      await admit("t-3", "alice", "Plan the offsite");
      await admit("t-4", "alice", "Budget: 50% of the ops_cost line, Über-plan");
      const result = (await tools(store)("sessions.search", { query: "stripe" })) as { matches: { taskId: string; excerpt: string }[] };
      expect(result.matches.map((match) => match.taskId)).toEqual(["t-1"]);
      expect(result.matches[0]?.excerpt).toContain("quarterly Stripe revenue memo");
      // `%` and `_` are literal, and a non-ASCII word matches whatever its case.
      const search = async (query: string) =>
        ((await tools(store)("sessions.search", { query })) as { matches: { taskId: string }[] }).matches.map((match) => match.taskId);
      expect(await search("50%")).toEqual(["t-4"]);
      expect(await search("ops_cost")).toEqual(["t-4"]);
      expect(await search("s_cost")).toEqual(["t-4"]);
      expect(await search("o%s")).toEqual([]);
      expect(await search("über")).toEqual(["t-4"]);
    } finally {
      store.close();
    }
  });
});

describe("sessions.search by keywords, cited", () => {
  type Answer = { found: number; matches: { taskId: string; title: string; at: string; excerpt: string }[] };
  const opened = async () => {
    const store = await openStore();
    let second = 0;
    const admit = async (taskId: string, prompt: string) =>
      await store.asPort().repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "alice",
        operationKey: `op-${taskId}`,
        kind: "start",
        intent: { prompt },
        checkpointNamespace: "",
        newTaskId: taskId,
        newAdmissionId: `adm-${taskId}`,
        newThreadId: `thread-${taskId}`,
        now: new Date(Date.UTC(2026, 8, 1) + ++second * 1000).toISOString(),
      });
    return { store, admit };
  };

  it("matches a multi-word query held apart, ranks more matched words first, and cites each chat by id and title", async () => {
    const { store, admit } = await opened();
    try {
      await admit("t-apart", "The ACME renewal came up again. Separately, the travel budget for Lisbon is 4k.");
      await admit("t-one", "ACME renewal call notes");
      await admit("t-none", "Grocery list");
      const answer = (await tools(store)("sessions.search", { query: "ACME Lisbon budget" })) as Answer;
      expect(answer.matches.map((match) => match.taskId)).toEqual(["t-apart", "t-one"]);
      expect(answer.found).toBe(2);
      expect(answer.matches[0]).toMatchObject({
        taskId: "t-apart",
        title: "The ACME renewal came up again. Separately, the travel budget for Lisbon is 4k.",
        at: "2026-09-01T00:00:01.000Z",
      });
      expect(answer.matches[0]!.excerpt).toContain("travel budget for Lisbon");
      // Its keys in that order: `found` and each chat before its excerpt, so a capped preview still cites them;
      // then the result's label, which the dispatcher removes: the chats it hit are its refs.
      expect(Object.keys(answer)).toEqual(["found", "matches", TOOL_LABEL_KEY]);
      expect((answer as unknown as Record<string, unknown>)[TOOL_LABEL_KEY]).toEqual({
        untrusted: true,
        confidentiality: "personal",
        refs: ["t-apart", "t-one"],
      });
      expect(Object.keys(answer.matches[0]!)).toEqual(["taskId", "title", "at", "excerpt"]);
    } finally {
      store.close();
    }
  });

  it("finds a Japanese word inside an unspaced sentence of an earlier chat, through its bigrams", async () => {
    const { store, admit } = await opened();
    try {
      await admit("t-ja", "明日の東京の天気は晴れの予報です");
      await admit("t-other", "大阪で会議があります");
      const answer = (await tools(store)("sessions.search", { query: "天気予報" })) as Answer;
      expect(answer.matches.map((match) => match.taskId)).toEqual(["t-ja"]);
      expect(answer.matches[0]!.title).toBe("明日の東京の天気は晴れの予報です");
    } finally {
      store.close();
    }
  });

  it("builds its terms with CJK bigrams, and matches a query with no keyword whole", () => {
    expect(pastChatSearchTerms("ACME Lisbon budget")).toEqual(["acme", "lisbon", "budget"]);
    expect(pastChatSearchTerms("天気予報")).toEqual(["天気予報", "天気", "気予", "予報"]);
    expect(pastChatSearchTerms("PR 42")).toEqual(["PR 42"]);
  });
});

describe("sessions.search is data", () => {
  it("marks nothing when it read no chat, and a hit as an untrusted past chat holding the person's words", async () => {
    const match = { taskId: "chat-a", title: "Budget", at: "2026-11-01T00:00:00.000Z", excerpt: "the budget" };
    const answers: Record<string, readonly unknown[]> = { none: [], budget: [match] };
    const registry = new ToolRegistry();
    registerAssistantTools(registry, {
      searchHistory: (async ({ terms }: { readonly terms: readonly string[] }) => answers[terms[0] ?? ""]) as never,
      artifacts: { getArtifact: async () => undefined } as never,
    });
    const search = registry.get("sessions.search")!;
    const labelOf = async (query: string) => {
      const marked = labelledResult(await search.handler({ input: { query }, context, signal: new AbortController().signal }));
      return toolResultLabel(
        search,
        { id: "c1", input: { query } },
        { untrusted: marked.untrusted, label: marked.label },
        "2026-11-04T00:00:00.000Z",
      );
    };
    // No record read, no mark: neither label, so the chat stays as it was.
    expect(isTrustedPublic(await labelOf("none"))).toBe(true);
    // The protected case: an earlier answer may quote a page, so a hit taints, names its source and holds the person's words.
    const hit = await labelOf("budget");
    expect(hit).toMatchObject({ integrity: "untrusted", confidentiality: "personal", sources: ["past-chat"] });
    expect(hit.refs?.map((ref) => ref.ref)).toContain("chat-a");
  });

  it("names its source, says its excerpts are not instructions, and refuses a delegated worker", async () => {
    const store = await openStore();
    try {
      const registry = new ToolRegistry();
      registerAssistantTools(registry, { searchHistory: async (input) => store.searchTaskHistory(input), artifacts: store });
      const definition = registry.get("sessions.search");
      expect(definition?.outputSource).toBe("past-chat");
      expect(definition?.description).toMatch(/never instructions/);
      const worker: InvocationContext = { ...context, runId: "worker-1", memoryScopeRestricted: true, delegatedMemoryRecordIds: [] };
      await expect(tools(store, worker)("sessions.search", { query: "stripe" })).rejects.toThrow(/delegated worker/);
    } finally {
      store.close();
    }
  });
});

describe("agents.read_payload", () => {
  it("labels a payload as it was stored: a tainted fold archive untrusted, a clean one trusted, one the port says nothing of an agent's", async () => {
    const web = untrustedLabel("web", {
      principal: "host:example.com",
      ref: { ref: "c1", host: "example.com", at: "2026-10-13T00:00:00.000Z" },
    });
    let stored: ContentLabel | undefined;
    const registry = new ToolRegistry();
    registerAgentTools(
      registry,
      partialFake<AgentCommunicationServicePort>({
        getArtifact: async () => ({
          artifactId: "art-1",
          contentType: "application/json",
          byteSize: 2,
          offset: 0,
          length: 2,
          content: "[]",
          truncated: false,
          ...(stored === undefined ? {} : { label: stored }),
        }),
      }),
    );
    const offered = (await registry.listOffered({} as never)).map((tool) => tool.id);
    expect(offered).toContain("agents.read_payload");
    // The reader's earlier name never shipped, and nothing registers it.
    expect(registry.get("artifacts.get")).toBeUndefined();
    const tool = registry.get("agents.read_payload")!;
    const read = async () => {
      const marked = labelledResult(await tool.handler({ input: { messageId: "m1" }, context, signal: new AbortController().signal }));
      expect(marked.output).not.toHaveProperty("label");
      return toolResultLabel(
        tool,
        { id: "c2", input: { messageId: "m1" } },
        { untrusted: marked.untrusted, label: marked.label },
        "2026-10-13T00:00:00.000Z",
      );
    };
    stored = web;
    expect(await read()).toEqual(web);
    stored = TRUSTED_PUBLIC;
    expect(await read()).toEqual(TRUSTED_PUBLIC);
    stored = undefined;
    expect(await read()).toMatchObject({ integrity: "untrusted", sources: ["agent"] });
  });

  it("agents.status raises a task's ended label into its result's label, never its visible output", async () => {
    const web = untrustedLabel("web", {
      principal: "host:example.com",
      ref: { ref: "c1", host: "example.com", at: "2026-10-13T00:00:00.000Z" },
    });
    let label: ContentLabel | undefined;
    const registry = new ToolRegistry();
    registerAgentTools(
      registry,
      partialFake<AgentCommunicationServicePort>({
        status: async () => ({ taskId: "t-worker", status: "completed", finalText: "found it", ...(label === undefined ? {} : { label }) }),
      }),
    );
    const tool = registry.get("agents.status")!;
    const read = async () => {
      const raw = await tool.handler({ input: { taskId: "t-worker" }, context, signal: new AbortController().signal });
      const marked = labelledResult(raw);
      expect(marked.output).not.toHaveProperty("label");
      expect(marked.output).toMatchObject({ finalText: "found it" });
      return {
        raw,
        label: toolResultLabel(
          tool,
          { id: "c3", input: { taskId: "t-worker" } },
          { untrusted: marked.untrusted, label: marked.label },
          "2026-10-13T00:00:00.000Z",
        ),
      };
    };
    label = web;
    const tainted = await read();
    expect((tainted.raw as Record<string, unknown>)[TOOL_LABEL_KEY]).toEqual({ stored: web });
    expect(tainted.label).toEqual(web);
    label = TRUSTED_PUBLIC;
    expect((await read()).label).toEqual(TRUSTED_PUBLIC);
  });
});

describe("artifacts.read", () => {
  it("points a voice message to audio.transcribe rather than calling it missing: it arrived", async () => {
    const store = await openStore();
    try {
      const call = tools(store);
      // A channel attachment has no run of its own: it is the workspace's, not this chat's archive.
      const voice = await store.putArtifact({
        workspaceId: "default",
        contentType: "audio/ogg",
        body: new TextEncoder().encode("OggS"),
        reviewState: "approved",
      });
      await expect(call("artifacts.read", { artifactId: voice.artifactId })).rejects.toThrow(/audio\.transcribe/);
      await expect(call("artifacts.read", { artifactId: voice.artifactId })).rejects.not.toThrow(/no artifact/);
      // Another chat's voice message: not found, and nothing said of what it is.
      const theirs = await store.putArtifact({
        workspaceId: "default",
        runId: "task-other",
        contentType: "audio/ogg",
        body: new TextEncoder().encode("OggS"),
        reviewState: "approved",
        untrusted: true,
        label: untrustedLabel("attachment"),
      });
      const refused = call("artifacts.read", { artifactId: theirs.artifactId });
      await expect(refused).rejects.toThrow(/no artifact .* in this chat/);
      await expect(refused).rejects.not.toThrow(/audio/);
    } finally {
      store.close();
    }
  });

  it("reads an approved text artifact of this chat a page at a time, labelled as it was stored, and refuses anything else", async () => {
    const store = await openStore();
    try {
      const call = tools(store);
      const own = { workspaceId: "default", runId: context.runId };
      const text = "a".repeat(1_500) + "b".repeat(1_500);
      const archived = await store.putArtifact({
        ...own,
        contentType: "application/json",
        body: new TextEncoder().encode(text),
        reviewState: "approved",
      });
      const first = (await call("artifacts.read", { artifactId: archived.artifactId, maxChars: 1_000 })) as Record<string, unknown>;
      expect(first).toMatchObject({ offset: 0, totalChars: 3_000, nextOffset: 1_000, text: "a".repeat(1_000) });
      const last = (await call("artifacts.read", { artifactId: archived.artifactId, offset: 2_000, maxChars: 1_000 })) as Record<
        string,
        unknown
      >;
      expect(last).toMatchObject({ offset: 2_000, text: "b".repeat(1_000) });
      expect(last).not.toHaveProperty("nextOffset");
      for (const reviewState of ["pending", "rejected"] as const) {
        const held = await store.putArtifact({ ...own, contentType: "text/plain", body: new Uint8Array([65]), reviewState });
        await expect(call("artifacts.read", { artifactId: held.artifactId })).rejects.toThrow(/not approved/);
      }
      // Another workspace's, another chat's (a worker's mailbox payload, another chat's archive) and an internal one: missing.
      for (const where of [
        { workspaceId: "elsewhere", runId: context.runId },
        { workspaceId: "default", runId: "another-chat" },
      ]) {
        const other = await store.putArtifact({ ...where, contentType: "text/plain", body: new Uint8Array([65]), reviewState: "approved" });
        await expect(call("artifacts.read", { artifactId: other.artifactId })).rejects.toThrow(/no artifact/);
      }
      const thumbnail = await store.putArtifact({
        ...own,
        contentType: "text/plain",
        body: new Uint8Array([65]),
        reviewState: "approved",
        purpose: "thumbnail",
      });
      await expect(call("artifacts.read", { artifactId: thumbnail.artifactId })).rejects.toThrow(/no artifact/);
      const image = await store.putArtifact({ ...own, contentType: "image/png", body: new Uint8Array([137]), reviewState: "approved" });
      await expect(call("artifacts.read", { artifactId: image.artifactId })).rejects.toThrow(/artifacts.view_image/);
      // A page of non-Latin text is held to the byte budget.
      const wide = await store.putArtifact({
        ...own,
        contentType: "text/plain",
        body: new TextEncoder().encode("ж".repeat(30_000)),
        reviewState: "approved",
      });
      const page = (await call("artifacts.read", { artifactId: wide.artifactId, maxChars: 24_000 })) as {
        text: string;
        nextOffset: number;
      };
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(ARTIFACT_READ_PAGE_BYTES);
      expect(page.nextOffset).toBe(page.text.length);
      // A web page's archive, read back, carries the web page's label.
      const web = untrustedLabel("web", { principal: "host:example.com" });
      const fromWeb = await store.putArtifact({
        ...own,
        contentType: "application/json",
        body: new TextEncoder().encode("{}"),
        reviewState: "approved",
        label: web,
      });
      const marked = labelledResult(await call("artifacts.read", { artifactId: fromWeb.artifactId }));
      expect(marked.label?.stored).toMatchObject({ integrity: "untrusted", sources: ["web"] });
    } finally {
      store.close();
    }
  });
});

/** A PNG's signature and IHDR, `width`×`height`: all `imageDimensionsOf` reads. `salt` makes two of them differ. */
const pngOf = (width: number, height: number, salt = 0): Uint8Array => {
  const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, salt]);
};
/** A JPEG's start, a JFIF segment, then a baseline frame header `width`×`height`. */
const jpegOf = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    74,
    70,
    73,
    70,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);

describe("imageDimensionsOf", () => {
  it("reads a PNG's, a JPEG's, a GIF's and a WebP's size from its header, and nothing from a damaged one", () => {
    expect(imageDimensionsOf(pngOf(9000, 9000))).toEqual({ width: 9000, height: 9000 });
    expect(imageDimensionsOf(jpegOf(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageDimensionsOf(new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x40, 1, 0xf0, 0]))).toEqual({
      width: 320,
      height: 240,
    });
    const webp = (chunk: string, body: number[]) =>
      new Uint8Array([
        ...new TextEncoder().encode("RIFF"),
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode("WEBP"),
        ...new TextEncoder().encode(chunk),
        ...body,
      ]);
    // VP8X: 24-bit width and height less one, at 24 and 27.
    expect(imageDimensionsOf(webp("VP8X", [10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 1, 0, 0xef, 0, 0]))).toEqual({ width: 320, height: 240 });
    // VP8L: 14-bit width and height less one, packed after the 0x2f signature.
    expect(imageDimensionsOf(webp("VP8L", [0, 0, 0, 0, 0x2f, 0x3f, 0xc1, 0x3b, 0]))).toEqual({ width: 320, height: 240 });
    // VP8: the key frame's 14-bit width and height at 26 and 28.
    expect(imageDimensionsOf(webp("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 1, 0xf0, 0]))).toEqual({ width: 320, height: 240 });
    // The signature, then text (Mac mini adversarial tests): no size, so not a picture to show.
    expect(
      imageDimensionsOf(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new TextEncoder().encode("not really a png at all")])),
    ).toBe(undefined);
    expect(imageDimensionsOf(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(undefined);
  });
});

describe("artifacts.view_image", () => {
  it("names an approved image of this workspace, and refuses anything else", async () => {
    const store = await openStore();
    try {
      const call = tools(store);
      const image = store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/png",
        body: pngOf(1, 1),
        reviewState: "approved",
      });
      const pending = store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/png",
        body: new Uint8Array([1]),
        reviewState: "pending",
      });
      expect(await call("artifacts.view_image", { artifactId: (await image).artifactId })).toMatchObject({
        [TOOL_MEDIA_KEY]: { artifactId: (await image).artifactId, mediaType: "image/png" },
      });
      await expect(call("artifacts.view_image", { artifactId: (await pending).artifactId })).rejects.toThrow(/not approved/);
      await expect(call("artifacts.view_image", { artifactId: "missing" })).rejects.toThrow(/no artifact/);
      // A browser thumbnail is approved, but internal: refused as missing.
      const thumbnail = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/jpeg",
        body: new Uint8Array([0xff, 0xd8, 0xff]),
        reviewState: "approved",
        purpose: "thumbnail",
      });
      await expect(call("artifacts.view_image", { artifactId: thumbnail.artifactId })).rejects.toThrow(/no artifact/);
      // A photo another chat's message carried: that chat's alone.
      const theirs = await store.putArtifact({
        workspaceId: "default",
        runId: "task-other",
        contentType: "image/png",
        body: pngOf(1, 1),
        reviewState: "approved",
        untrusted: true,
        label: untrustedLabel("attachment"),
      });
      await expect(call("artifacts.view_image", { artifactId: theirs.artifactId })).rejects.toThrow(/no artifact .* in this chat/);
    } finally {
      store.close();
    }
  });

  it("looks at a picture in the chat's folders by path, typed by its bytes and stored with its label (Mac mini tests)", async () => {
    const store = await openStore();
    try {
      const jpeg = jpegOf(320, 240);
      const files: Record<string, Uint8Array> = {
        "lisbon.jpg": jpeg,
        "notes.png": new TextEncoder().encode("not a picture"),
        "giant.png": pngOf(9000, 9000),
        "corrupt.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new TextEncoder().encode("only text after the signature")]),
      };
      const asked: number[] = [];
      const registry = new ToolRegistry();
      registerAssistantTools(registry, {
        searchHistory: async () => [],
        artifacts: store,
        folderPicture: async (path, _context, maxBytes) => {
          asked.push(maxBytes);
          const bytes = files[path];
          if (bytes === undefined) throw new Error(`no ${path}`);
          return { bytes, name: path, label: untrustedLabel("download") };
        },
      });
      const view = (input: unknown) =>
        registry.get("artifacts.view_image")!.handler({ input, context, signal: new AbortController().signal });
      const shown = (await view({ path: "lisbon.jpg" })) as Record<string | symbol, unknown>;
      const artifactId = shown["artifactId"] as string;
      expect(shown).toMatchObject({
        path: "lisbon.jpg",
        contentType: "image/jpeg",
        [TOOL_MEDIA_KEY]: { artifactId, mediaType: "image/jpeg" },
      });
      // The copy the model is handed keeps the file's label: a downloaded picture stays untrusted.
      const stored = await store.getArtifact(artifactId);
      expect(stored).toMatchObject({ contentType: "image/jpeg", fileName: "lisbon.jpg", untrusted: true, reviewState: "approved" });
      expect(stored?.label).toEqual(untrustedLabel("download"));
      expect(asked).toEqual([5_000_000]);
      // Named .png, but not a picture: refused by what it is.
      await expect(view({ path: "notes.png" })).rejects.toThrow(/not a png, jpeg, gif or webp picture/);
      // A picture the provider would refuse, refused here instead (Mac mini adversarial tests): it failed the call,
      // and every later one in the chat that still carried it.
      await expect(view({ path: "giant.png" })).rejects.toThrow(/9000×9000 pixels, over the 8000-pixel side/);
      await expect(view({ path: "corrupt.png" })).rejects.toThrow(/damaged or not the picture it starts like/);
      const giant = await store.putArtifact({ ...context, contentType: "image/png", body: pngOf(8001, 10), reviewState: "approved" });
      await expect(view({ artifactId: giant.artifactId })).rejects.toThrow(/8001×10 pixels/);
      // One of the two, never both or neither.
      await expect(view({})).rejects.toThrow(/an artifactId or a path/);
      await expect(view({ path: "lisbon.jpg", artifactId: artifactId })).rejects.toThrow(/an artifactId or a path/);
    } finally {
      store.close();
    }
  });

  it("sends an animated GIF to video.frames where it can read it, and shows it as an image where it cannot", async () => {
    const store = await openStore();
    try {
      // A GIF with two images: header, screen descriptor, then two image descriptors with a one-byte LZW block each.
      const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
      const delay = [0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00];
      const animated = new Uint8Array([
        ...new TextEncoder().encode("GIF89a"),
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        ...delay,
        ...frame,
        ...delay,
        ...frame,
        0x3b,
      ]);
      const still = new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0, ...frame, 0x3b]);
      const gif = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/gif",
        body: animated,
        reviewState: "approved",
      });
      const single = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/gif",
        body: still,
        reviewState: "approved",
      });
      let available = true;
      const registry = new ToolRegistry();
      registerAssistantTools(registry, { searchHistory: async () => [], artifacts: store, videoFramesAvailable: async () => available });
      const view = async (artifactId: string): Promise<unknown> =>
        registry.get("artifacts.view_image")?.handler({ input: { artifactId }, context, signal: new AbortController().signal });
      await expect(view(gif.artifactId)).rejects.toThrow(/animated GIF: look at it with video.frames/);
      expect(await view(single.artifactId)).toMatchObject({ [TOOL_MEDIA_KEY]: { mediaType: "image/gif" } });
      // No video tools here (no FFmpeg, or video.enabled off): its first frame is better than nothing.
      available = false;
      expect(await view(gif.artifactId)).toMatchObject({ [TOOL_MEDIA_KEY]: { mediaType: "image/gif" } });
    } finally {
      store.close();
    }
  });

  it("labels what it shows as the image was stored, and an image stored before labels as untrusted", async () => {
    const store = await openStore();
    try {
      const registry = new ToolRegistry();
      registerAssistantTools(registry, { searchHistory: async () => [], artifacts: store });
      const tool = registry.get("artifacts.view_image")!;
      const labelOf = async (artifactId: string) => {
        const marked = labelledResult(await tool.handler({ input: { artifactId }, context, signal: new AbortController().signal }));
        return toolResultLabel(
          tool,
          { id: "c1", input: { artifactId } },
          { untrusted: marked.untrusted, label: marked.label },
          "2026-10-13T00:00:00.000Z",
        );
      };
      const png = pngOf(1, 1);
      const web = untrustedLabel("web", {
        confidentiality: "personal",
        principal: "host:shop.example",
        ref: { ref: "art-x", host: "shop.example", at: "2026-10-13T00:00:00.000Z" },
      });
      const capture = await store.putArtifact({ workspaceId: "default", runId: "r", contentType: "image/png", body: png, label: web });
      expect(await labelOf(capture.artifactId)).toEqual(web);
      // A chart Tavi drew in a clean chat: trusted, as it was stored.
      const chart = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/png",
        body: pngOf(1, 1, 1),
        label: TRUSTED_PUBLIC,
      });
      expect(isUntrusted(await labelOf(chart.artifactId))).toBe(false);
      const old = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/png",
        body: pngOf(1, 1, 2),
      });
      expect(await labelOf(old.artifactId)).toMatchObject({ integrity: "untrusted", sources: ["unknown-source"] });
      const media = await store.putArtifact({
        workspaceId: "default",
        runId: "r",
        contentType: "image/png",
        body: pngOf(1, 1, 3),
        untrusted: true,
      });
      expect(await labelOf(media.artifactId)).toMatchObject({ integrity: "untrusted", sources: ["attachment"] });
    } finally {
      store.close();
    }
  });

  it("shows an image only for artifacts.view_image's own results", async () => {
    const [message] = await toSdkMessages(
      [
        {
          role: "tool",
          id: "m1",
          text: "",
          createdAt: "2026-09-27T00:00:00.000Z",
          toolResults: [
            {
              toolCallId: "c1",
              toolName: "web_fetch",
              isError: false,
              output: { [TOOL_MEDIA_KEY]: { artifactId: "a1", mediaType: "image/png" } },
            },
          ],
        },
      ],
      new Map(),
      () => ({ mediaType: "image/png", data: new Uint8Array([1]) }),
    );
    expect(message).toMatchObject({ content: [{ output: { type: "json" } }] });
  });

  it("puts the named image in front of the model as a file part, after its tool result", async () => {
    const [message, image] = await toSdkMessages(
      [
        {
          role: "tool",
          id: "m1",
          text: "",
          createdAt: "2026-09-27T00:00:00.000Z",
          toolResults: [
            {
              toolCallId: "c1",
              toolName: "artifacts.view_image",
              isError: false,
              output: { artifactId: "a1", [TOOL_MEDIA_KEY]: { artifactId: "a1", mediaType: "image/png" } },
            },
          ],
        },
      ],
      new Map(),
      (artifactId) => (artifactId === "a1" ? { mediaType: "image/png", data: new Uint8Array([1, 2]) } : undefined),
    );
    // A Chat Completions tool result is text only: the image follows it, as the person's message.
    expect(message).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "json", value: { artifactId: "a1", image: "shown in the next message" } } }],
    });
    expect(image).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "file", mediaType: "image/png" }] });
  });
});

describe("the messaging profile", () => {
  const gate = (
    toolId: string,
    assessment: ReturnType<typeof assessSandboxRun> | undefined,
    origin: string,
    allowed: readonly string[] = [],
  ) =>
    evaluateGate({
      toolId,
      effect: "external",
      ...(assessment === undefined ? {} : { assessment }),
      rules: [...SHIPPED_TOOL_RULES, ...messagingProfileRules(allowed)],
      sessionGrants: [],
      gatedEffects: new Set(["mutating", "external"]),
      tainted: false,
      origin,
    });

  // A command that does more than read: the shipped read-only rule runs `ls` without asking anywhere it is not held.
  it("holds a shell and a credential back from a chat-started task, and from no other", () => {
    expect(gate("sandbox.run", assessSandboxRun({ command: "npm", args: ["test"] }), "messaging").decision).toBe("deny");
    expect(gate("sandbox.run", assessSandboxRun({ command: "npm", args: ["test"] }), "cli").decision).toBe("ask");
    expect(gate("http.request", assessHttpRequest({ url: "https://api.example.com", credentialRef: "k" }), "messaging").decision).toBe(
      "deny",
    );
    expect(gate("http.request", assessHttpRequest({ url: "https://api.example.com" }), "messaging").decision).toBe("ask");
  });

  it("holds plugins.validate back from a chat-started task, as the shell", () => {
    expect(gate("plugins.validate", undefined, "messaging").decision).toBe("deny");
    expect(gate("plugins.validate", undefined, "messaging", ["plugins.validate"]).decision).not.toBe("deny");
  });

  it("lets the owner allow a held tool", () => {
    expect(gate("sandbox.run", assessSandboxRun({ command: "npm", args: ["test"] }), "messaging", ["sandbox.run"]).decision).toBe("ask");
  });

  it("holds a turn sent from a messaging conversation to it, whatever started the chat, and not one from the owner's local connection", () => {
    const telegram = { connectionId: "telegram-main", externalConversationId: "42", externalSenderId: "7" };
    const local = { connectionId: "local-default", externalConversationId: "home:operator", externalSenderId: "operator" };
    expect(turnChannelOf({ messagingReplyTo: telegram })).toBe("messaging");
    expect(turnChannelOf({ messagingReplyTo: local })).toBeUndefined();
    expect(turnChannelOf({})).toBeUndefined();
    const turn = (channel: string | undefined) =>
      evaluateGate({
        toolId: "sandbox.run",
        effect: "external",
        assessment: assessSandboxRun({ command: "npm", args: ["test"] }),
        rules: [...SHIPPED_TOOL_RULES, ...messagingProfileRules([])],
        sessionGrants: [],
        gatedEffects: new Set(["mutating", "external"]),
        tainted: false,
        origin: "web",
        channel,
      }).decision;
    expect(turn(turnChannelOf({ messagingReplyTo: telegram }))).toBe("deny");
    expect(turn(turnChannelOf({ messagingReplyTo: local }))).toBe("ask");
  });

  it("holds a worker to the channel its spawning turn was held to, on any later turn", async () => {
    const rows = new Map([
      ["worker-held", { heldChannel: "messaging" as const }],
      ["worker-free", {}],
    ]);
    const repositories = { agentDelegations: { getByWorkerTaskId: async (taskId: string) => rows.get(taskId) } } as unknown as Parameters<
      typeof heldChannelOf
    >[0];
    // The spawning turn's hold reaches the actor `agents.spawn` records it from.
    expect(
      agentActorFrom({ workspaceId: "ws", principalId: "p", runId: "home", caller: "ipc", heldChannel: "messaging" }).heldChannel,
    ).toBe("messaging");
    expect(agentActorFrom({ workspaceId: "ws", principalId: "p", runId: "home", caller: "ipc" })).not.toHaveProperty("heldChannel");
    expect(await heldChannelOf(repositories, { runId: "worker-held" })).toBe("messaging");
    expect(await heldChannelOf(repositories, { runId: "worker-free" })).toBeUndefined();
    expect(await heldChannelOf(repositories, { runId: "not-a-worker" })).toBeUndefined();
    expect(
      await heldChannelOf(repositories, {
        runId: "not-a-worker",
        messagingReplyTo: { connectionId: "telegram-main", externalConversationId: "42", externalSenderId: "7" },
      }),
    ).toBe("messaging");
  });

  it("names the connection a held turn came in on: its own, else its spawning turn's from the row, never a local one", async () => {
    const rows = new Map([["worker-held", { heldChannel: "messaging" as const, heldConnectionId: "telegram-main" }]]);
    const repositories = { agentDelegations: { getByWorkerTaskId: async (taskId: string) => rows.get(taskId) } } as unknown as Parameters<
      typeof heldConnectionOf
    >[0];
    expect(
      agentActorFrom({
        workspaceId: "ws",
        principalId: "p",
        runId: "home",
        caller: "ipc",
        heldChannel: "messaging",
        heldConnectionId: "telegram-main",
      }).heldConnectionId,
    ).toBe("telegram-main");
    expect(await heldConnectionOf(repositories, { runId: "worker-held" })).toBe("telegram-main");
    expect(
      await heldConnectionOf(repositories, {
        runId: "home",
        messagingReplyTo: { connectionId: "telegram-2", externalConversationId: "42", externalSenderId: "7" },
      }),
    ).toBe("telegram-2");
    expect(
      await heldConnectionOf(repositories, {
        runId: "home",
        messagingReplyTo: { connectionId: "local-default", externalConversationId: "c", externalSenderId: "s" },
      }),
    ).toBeUndefined();
  });
});

describe("a delegated worker's origin", () => {
  it("is its delegation root's, so a chat task's worker keeps the messaging profile", async () => {
    const store = await openStore();
    try {
      const repositories = store.asPort().repositories;
      for (const [taskId, origin] of [
        ["root", "messaging"],
        ["worker", "agent"],
        ["grandchild", "agent"],
      ] as const) {
        await repositories.tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: "default",
          principalId: "alice",
          operationKey: `op-${taskId}`,
          kind: "start",
          intent: { prompt: "p" },
          checkpointNamespace: "",
          origin,
          newTaskId: (() => taskId)(),
          newAdmissionId: (() => `adm-${taskId}`)(),
          newThreadId: (() => `thread-${taskId}`)(),
          now: (() => "2026-09-01T00:00:00.000Z")(),
        });
      }
      await repositories.agentDelegations.recordSpawn({
        operationKey: "s1",
        workspaceId: "default",
        principalId: "alice",
        workerTaskId: "worker",
        workerAgentId: "a1",
        parentTaskId: "root",
        rootTaskId: "root",
        depth: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      await repositories.agentDelegations.recordSpawn({
        operationKey: "s2",
        workspaceId: "default",
        principalId: "alice",
        workerTaskId: "grandchild",
        workerAgentId: "a2",
        parentTaskId: "worker",
        rootTaskId: "root",
        depth: 2,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      expect(await delegationRootOrigin(repositories, "grandchild")).toBe("messaging");
      expect(await delegationRootOrigin(repositories, "root")).toBe("messaging");
    } finally {
      store.close();
    }
  });
});

describe("a task's memory reach", () => {
  it("narrows a group's Home, its topics and their workers; leaves a DM, an email thread and an ordinary chat", async () => {
    const store = await openStore();
    try {
      const repositories = store.asPort().repositories;
      const tasks = [
        ["group", "messaging"],
        ["topic", "messaging"],
        ["dm", "messaging"],
        ["email", "messaging"],
        ["chat", "cli"],
        ["worker", "agent"],
        ["unrecorded-worker", "agent"],
      ] as const;
      for (const [taskId, origin] of tasks) {
        await repositories.tasks.admit({
          prompt: fixturePromptPolicy,
          workspaceId: "default",
          principalId: "alice",
          operationKey: `op-${taskId}`,
          kind: "start",
          intent: { prompt: "p" },
          checkpointNamespace: "",
          origin,
          newTaskId: taskId,
          newAdmissionId: `adm-${taskId}`,
          newThreadId: `thread-${taskId}`,
          now: "2026-09-01T00:00:00.000Z",
        });
      }
      const at = "2026-09-01T00:00:00.000Z";
      await repositories.messagingConversations.record({
        connectionId: "telegram-1",
        externalConversationId: "-100",
        taskId: "group",
        createdAt: at,
        providerId: "telegram",
        conversationKind: "group",
      });
      await repositories.messagingConversations.record({
        connectionId: "telegram-1",
        externalConversationId: topicConversationKey("-100", "7"),
        taskId: "topic",
        createdAt: at,
        providerId: "telegram",
        conversationKind: "thread",
      });
      await repositories.messagingConversations.record({
        connectionId: "telegram-1",
        externalConversationId: "42",
        taskId: "dm",
        createdAt: at,
        providerId: "telegram",
        conversationKind: "direct",
      });
      await repositories.messagingConversations.record({
        connectionId: "mailgun-1",
        externalConversationId: "bot@x#a",
        taskId: "email",
        createdAt: at,
        providerId: "mailgun",
        conversationKind: "thread",
      });
      await repositories.agentDelegations.recordSpawn({
        operationKey: "s1",
        workspaceId: "default",
        principalId: "alice",
        workerTaskId: "worker",
        workerAgentId: "a1",
        parentTaskId: "group",
        rootTaskId: "group",
        depth: 1,
        createdAt: at,
      });
      expect(await memoryReachOf(repositories, "group")).toBe("chat-only");
      expect(await memoryReachOf(repositories, "topic")).toBe("chat-only");
      expect(await memoryReachOf(repositories, "worker")).toBe("chat-only");
      expect(await memoryReachOf(repositories, "dm")).toBeUndefined();
      expect(await memoryReachOf(repositories, "email")).toBeUndefined();
      expect(await memoryReachOf(repositories, "chat")).toBeUndefined();
      // A worker whose delegation row is not written yet (a joined worker's first turn) is left to its spawner's stamp.
      expect(await memoryReachOf(repositories, "unrecorded-worker")).toBeUndefined();
      // The reach reaches the actor `agents.spawn` checks the records it hands on with.
      expect(agentActorFrom({ ...context, memoryReach: "chat-only" }).memoryReach).toBe("chat-only");
      expect(agentActorFrom(context)).not.toHaveProperty("memoryReach");
    } finally {
      store.close();
    }
  });

  it("memory invariant 25: sessions.search from a group searches only its own conversation", async () => {
    const seen: unknown[] = [];
    const registry = new ToolRegistry();
    registerAssistantTools(registry, {
      searchHistory: async (input) => {
        seen.push(input);
        return [];
      },
      artifacts: { getArtifact: async () => undefined } as never,
    });
    const search = registry.get("sessions.search");
    await search?.handler({
      input: { query: "budget" },
      context: { ...context, memoryReach: "chat-only" },
      signal: new AbortController().signal,
    });
    await search?.handler({ input: { query: "budget" }, context, signal: new AbortController().signal });
    expect(seen).toEqual([
      {
        workspaceId: "default",
        principalId: "alice",
        terms: ["budget"],
        limit: 10,
        excludeTaskId: "task-now",
        reach: "chat-only",
        readerTaskId: "task-now",
      },
      { workspaceId: "default", principalId: "alice", terms: ["budget"], limit: 10, excludeTaskId: "task-now", readerTaskId: "task-now" },
    ]);
  });
});
