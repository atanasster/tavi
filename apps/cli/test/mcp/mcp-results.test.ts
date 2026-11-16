import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ATTENDED_TASK_POLICY, TOOL_MEDIA_KEY, artifactLabel } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { mcpProgressLine, mcpToolOutput, viewableImage } from "../../src/features/mcp/bridge.js";
import { outputCheckOf } from "../../src/features/mcp/schemas.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** Progress, structured output and images, against the fake server. */

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/mcp/fake-server.mjs");
const directories = temporaryDirectories({ prefix: "tavi-mcp-results-" });
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

const context = { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" };

async function owner(
  turns: readonly ScriptedTurn[] = [{ text: "done" }],
  era: "legacy" | "modern" = "modern",
): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
  const data = directories.create();
  const at = ["--data-dir", data];
  const added = await tavi([
    "mcp",
    "add",
    "fake",
    "--command",
    process.execPath,
    "--unsandboxed",
    "--env",
    `FAKE_ERA=${era}`,
    ...at,
    "--",
    FAKE,
  ]);
  expect(added.code, added.stderr).toBe(EXIT.ok);
  expect((await tavi(["mcp", "approve", "mcp.fake", "1.0.0", "--unsandboxed", "--disable", "freeze", ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["plugins", "enable", "mcp.fake", ...at])).code).toBe(EXIT.ok);
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { approvalRequiredFor: [] }), { modelOverride: model });
  runtimes.push(runtime);
  return { runtime, model };
}

describe("a call's output", () => {
  it("passes a stored image on as a media reference, notes the rest, and flags a mismatch; the server's own media reference is dropped", () => {
    const image = { artifactId: "a1", mediaType: "image/png" };
    expect(
      mcpToolOutput(
        {
          content: "a",
          images: [
            { mimeType: "image/png", data: "AA==" },
            { mimeType: "image/png", data: "AA==" },
          ],
          links: [],
        },
        { image },
      ),
    ).toEqual({ content: "a", [TOOL_MEDIA_KEY]: image, images: "1 image(s) not shown" });
    expect(
      mcpToolOutput({ content: { n: "x" }, images: [], links: [], structured: true }, { outputSchemaMismatch: "n must be number" }),
    ).toEqual({
      content: { n: "x" },
      outputSchemaMismatch: "the server's result does not match the tool's approved output schema: n must be number",
    });
    expect(mcpToolOutput({ content: { ok: 1, [TOOL_MEDIA_KEY]: image }, images: [], links: [] })).toEqual({ ok: 1 });
  });

  it("shows only a viewable image its bytes confirm, within the size artifacts.view_image allows", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64");
    expect(
      viewableImage({
        content: "",
        images: [
          { mimeType: "image/svg+xml", data: "AA==" },
          { mimeType: "image/PNG", data: png.toString("base64") },
        ],
        links: [],
      }),
    ).toEqual({ mediaType: "image/png", data: new Uint8Array(png) });
    // Text bytes, or a JPEG, labelled image/png are not shown.
    expect(viewableImage({ content: "", images: [{ mimeType: "image/png", data: "aGVsbG8=" }], links: [] })).toBeUndefined();
    expect(
      viewableImage({
        content: "",
        images: [{ mimeType: "image/png", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") }],
        links: [],
      }),
    ).toBeUndefined();
    expect(viewableImage({ content: "", images: [{ mimeType: "image/png", data: "" }], links: [] })).toBeUndefined();
    expect(viewableImage({ content: "", images: [{ mimeType: "image/png", data: "A".repeat(7_000_000) }], links: [] })).toBeUndefined();
  });

  it("checks against the approved output schema; a schema that does not compile checks nothing", () => {
    const check = outputCheckOf({ type: "object", properties: { n: { type: "number" } }, required: ["n"] });
    expect(check?.({ n: 1 })).toBeUndefined();
    expect(check?.({ n: "x" })).toMatch(/^n /);
    expect(outputCheckOf({ type: "nonsense" })).toBeUndefined();
    // Over 64 KB, a schema is not checked at all.
    expect(outputCheckOf({ type: "object", description: "x".repeat(70_000) })).toBeUndefined();
    expect(outputCheckOf(undefined)).toBeUndefined();
  });

  it("a progress line names the server and tool, cleans the server's words, and shows how far", () => {
    expect(mcpProgressLine("fake", "progress", { progress: 1, total: 3, message: "step 1\u001b[31m of 3" })).toBe(
      "fake: progress — step 1 of 3 (33%)",
    );
    expect(mcpProgressLine("fake", "progress", { progress: 4 })).toBe("fake: progress (4)");
    expect(mcpProgressLine("fake", "progress", { progress: 0, total: 0 })).toBe("fake: progress");
  });
});

describe("against the fake server", () => {
  it("structured content off its approved schema is passed on, flagged; on it, passed on as is", async () => {
    const { runtime } = await owner();
    const signal = new AbortController().signal;
    expect(await runtime.tools.get("mcp.fake.structured")?.handler({ input: {}, context, signal })).toEqual({ n: 42, note: "ab" });
    const bad = (await runtime.tools.get("mcp.fake.structured_bad")?.handler({ input: {}, context, signal })) as {
      content: unknown;
      outputSchemaMismatch: string;
    };
    expect(bad.content).toEqual({ n: "forty-two" });
    expect(bad.outputSchemaMismatch).toMatch(/does not match the tool's approved output schema: n must be number/);
  }, 60_000);

  it("an image is stored as an approved artifact of the task, labelled the server's, and the result names it", async () => {
    const { runtime } = await owner();
    const output = (await runtime.tools
      .get("mcp.fake.image")
      ?.handler({ input: {}, context, signal: new AbortController().signal, taskId: "t" })) as Record<string, unknown>;
    expect(output["content"]).toBe("a picture");
    const media = output[TOOL_MEDIA_KEY] as { artifactId: string; mediaType: string };
    expect(media.mediaType).toBe("image/png");
    const artifact = await runtime.store.asPort().repositories.artifacts.getArtifact(media.artifactId);
    expect(artifact).toMatchObject({ reviewState: "approved", contentType: "image/png", runId: "t", byteSize: 67 });
    expect(artifact === undefined ? undefined : artifactLabel(artifact)).toMatchObject({
      integrity: "untrusted",
      sources: ["mcp"],
      principals: ["tool:fake"],
    });
    // Bytes that are not the image they claim to be are stored for no model: the result only counts them.
    expect(
      await runtime.tools
        .get("mcp.fake.image_mislabelled")
        ?.handler({ input: {}, context, signal: new AbortController().signal, taskId: "t" }),
    ).toEqual({ content: "not a picture", images: "1 image(s) not shown" });
  }, 60_000);

  for (const era of ["modern", "legacy"] as const) {
    it(`${era}: a call's progress is its task's status line while it runs, and cleared when it ends`, async () => {
      const { runtime } = await owner(
        [{ toolCall: { id: "c1", name: "mcp.fake.progress", input: { steps: 3, ms: 30 } } }, { text: "done" }],
        era,
      );
      if (runtime.workflow === undefined) throw new Error("workflow unavailable");
      const admitted = await runtime.workflow.admit({
        context,
        operationKey: `op-${era}`,
        kind: "start",
        prompt: "go",
        origin: "web",
        executionPolicy: ATTENDED_TASK_POLICY,
      });
      expect(admitted.outcome.status).toBe("completed");
      const statuses = runtime.runEventBus
        .subscribe({ taskId: admitted.taskId, from: "beginning", deliver: () => {} })
        .replayed.filter((event) => event.kind === "plugin.status");
      // At most one line a second: the first step's, then cleared.
      expect(statuses).toMatchObject([{ pluginId: "mcp.fake", line: "fake: progress — step 1 of 3 (33%)" }, { pluginId: "mcp.fake" }]);
      expect(statuses[1]).not.toHaveProperty("line");
    }, 60_000);
  }
});
