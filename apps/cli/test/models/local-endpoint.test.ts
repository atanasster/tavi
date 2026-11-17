import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ClientEvent } from "@tavi/contracts";
import { parseClientEvent } from "@tavi/contracts";
import { chromiumInstalled } from "@tavi/plugin-browser/playwright";
import { findFfmpeg } from "@tavi/plugin-video";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { startOpenAiStub } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * Full-stack evidence for the headline result: a real prompt →
 * model → tool → model result.
 *
 * Only the inference itself is stubbed. Everything else is production code: the
 * real HTTP request, the real AI SDK adapter, the real credential-file read, the
 * real PluginHost composition, SQLite, the pinned LangGraph saver and the real
 * CLI output path. This is stronger than a mocked `fetch`, and it needs no
 * operator credential and no network access.
 */

interface CapturedRequest {
  readonly body: {
    readonly messages: {
      readonly role: string;
      readonly tool_calls?: { readonly id: string; readonly function?: { readonly name?: string } }[];
      readonly tool_call_id?: string;
      readonly content?: unknown;
    }[];
  };
}

/** A local server that speaks the Chat Completions streaming protocol. */
async function startStubEndpoint(): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly CapturedRequest[];
  readonly close: () => Promise<void>;
}> {
  // First generation requests the read-only fixture tool; the second answers
  // with text once the tool result is in the transcript.
  const stub = await startOpenAiStub({
    reply: (_request, turn) =>
      turn === 1
        ? // The provider echoes back the wire name, never the canonical id.
          { calls: [{ id: "call-stub-1", name: "fixture_echo", arguments: { message: "ping", uppercase: true } }] }
        : { says: "The tool echoed PING." },
  });
  return {
    baseUrl: stub.baseUrl,
    get requests() {
      return stub.requests.map((request) => ({ body: request.body as CapturedRequest["body"] }));
    },
    close: stub.close,
  };
}

/** Parse a JSON event stream through the contract's own decoder. */
function parseEvents(stdout: string): ClientEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseClientEvent(line));
}

const directories = temporaryDirectories();

// This suite drives the real CLI composition, with `fixture.echo` turned on (only
// composition's devFixtureTools option registers it) so a scripted provider has a tool to call.
vi.mock("../../src/runtime/composition.js", async (original) =>
  (await import("../support/dev-fixture-tool.js")).withFixtureTools(await original()),
);

afterEach(() => {
  directories.cleanup();
  delete process.env["TAVI_BASE_URL"];
  delete process.env["TAVI_API_KEY_FILE"];
});

describe("real prompt → model → tool → model result over real HTTP", () => {
  it("completes the round trip with no test double inside the application", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-e2e-");
    const keyFile = join(directory, "api-key");
    writeFileSync(keyFile, "sk-local-probe\n", { mode: 0o600 });

    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = keyFile;

    const captured = capture();
    // The default runtime factory: the real adapter, the real composition, the
    // real credential read. Nothing is injected.
    const code = await main(
      [
        "run",
        "Echo ping using the fixture.echo tool.",
        "--connection",
        "local",
        "--model",
        "stub-model",
        "--data-dir",
        directory,
        "--format",
        "json",
      ],
      { io: captured.io },
    );

    try {
      expect(captured.stderr()).not.toContain("MODEL_FAILED");
      expect(code).toBe(EXIT.ok);

      const events = parseEvents(captured.stdout());

      // The tool ran and the model produced the final answer.
      expect(events.some((event) => event.kind === "tool.completed")).toBe(true);
      const completed = events.at(-1);
      expect(completed?.kind).toBe("task.completed");
      expect(JSON.stringify(completed)).toContain("The tool echoed PING.");

      // Two real HTTP generations, and the second one carries the tool result
      // introduced by the matching assistant tool call.
      expect(endpoint.requests).toHaveLength(2);
      const second = endpoint.requests[1]?.body.messages ?? [];
      const assistant = second.find((message) => message.role === "assistant");
      const tool = second.find((message) => message.role === "tool");
      expect(assistant?.tool_calls?.[0]?.id).toBe("call-stub-1");
      expect(assistant?.tool_calls?.[0]?.function?.name).toBe("fixture_echo");
      expect(tool?.tool_call_id).toBe("call-stub-1");
      expect(JSON.stringify(tool?.content)).toContain("PING");

      // Every function name on the wire satisfies the provider's pattern, which
      // the canonical dotted id does not. This is the check OpenAI rejected.
      // The composition also registers the governed memory tools,
      // the governed agent-delegation tools (agents.wait,
      // agents.request/agents.reply and agents.read_payload),
      // the governed sandbox/browser tools,
      // `http.request`, and the deterministic collectors
      // plus their pipeline, and the brief's renderer, so the
      // fixture tool is one of thirty-two offered, not the only one — assert
      // all forty-eight tools by name rather than just "at least one", so an
      // accidental removal of
      // registerMemoryTools/registerAgentTools/registerSandboxTools/
      // registerBrowserTools/registerMessagingTools/registerHttpTools/
      // registerCollectorTools/registerReportTools from the composition would
      // still fail this test.
      // The browser's own tools are offered only while Chromium is installed: CI has none.
      const chromium = await chromiumInstalled();
      const offered = (endpoint.requests[0]?.body as { tools?: { function?: { name?: string } }[] }).tools ?? [];
      for (const entry of offered) {
        expect(entry.function?.name ?? "").toMatch(/^[a-zA-Z0-9_-]+$/);
      }
      expect(offered.map((entry) => entry.function?.name)).toEqual(
        expect.arrayContaining([
          "fixture_echo",
          "memory_search",
          "memory_get",
          "memory_propose",
          "agents_spawn",
          "agents_send",
          "agents_status",
          "agents_cancel",
          "agents_wait",
          "agents_read_payload",
          "sandbox_run",
          ...(chromium
            ? ["browser_create_session", "browser_navigate", "browser_observe", "browser_act", "browser_capture", "browser_close"]
            : []),
          "messaging_send_to",
          "collect_daily",
          "projects_get",
          "reports_generate",
          "reports_history",
          "operator_ask_user",
          "routines_create",
          "routines_update",
          "routines_get",
          "routines_list",
          "routines_pause",
          "routines_resume",
          "routines_archive",
          "routines_reevaluate",
          "routines_run",
          "routines_preview",
          "routines_history",
          "routines_inspect",
          "routines_cancel_run",
          "routines_retry_delivery",
          "routines_resume_delivery",
          "routines_targets",
          "routines_add_target",
          "routines_undo",
          "routines_revoke_grant",
          "reminders_create",
          "reminders_list",
          "reminders_update",
          "reminders_cancel",
          "reminders_snooze",
        ]),
      );
      // `agents.request` and `agents.reply` are offered only where the workspace's grant
      // holds a peer-messaging permission (`agentMessageGrant`): with none here, each
      // could only be refused.
      for (const peer of ["agents_request", "agents_reply"]) expect(offered.map((entry) => entry.function?.name)).not.toContain(peer);
      // The per-project collectors are offered only where a project is
      // registered; this deployment has none, so a model here cannot reach for
      // `news.search` and spend a turn on the refusal.
      // `web_fetch` and `http.request` reach only `--http-allow-host` hosts; with
      // none configured they could reach nothing, so a named site goes to the browser.
      for (const hidden of ["ga4_report", "gsc_query", "gcp_billing", "stripe_subscriptions", "news_search", "web_fetch", "http_request"]) {
        expect(offered.map((entry) => entry.function?.name)).not.toContain(hidden);
      }
      // plan.update, sessions.search and artifacts.view_image are
      // default tools; the file tools work in the chat's own folder with no root.
      for (const added of [
        "plan_update",
        "sessions_search",
        "artifacts_view_image",
        "fs_read",
        "fs_list",
        "fs_glob",
        "fs_grep",
        "fs_write",
        "fs_edit",
      ])
        expect(offered.map((entry) => entry.function?.name)).toContain(added);
      // browser.read joined the browser tools, which a site-naming prompt is offered
      // while Chromium is installed.
      if (chromium) expect(offered.map((entry) => entry.function?.name)).toContain("browser_read");
      // The browser agent's tools: batched, reading, finding and seeing browser
      // actions, the task's findings, and a flight search.
      for (const added of [
        ...(chromium ? ["browser_batch", "browser_extract", "browser_find", "browser_vision_act"] : []),
        "findings_add",
        "findings_check",
        "findings_list",
        "travel_flights_search",
      ])
        expect(offered.map((entry) => entry.function?.name)).toContain(added);
      // The channels the agent can reach.
      expect(offered.map((entry) => entry.function?.name)).toContain("messaging_channels");
      // The plugin-authoring guide, and plugins.validate in the chat's folders, as the file tools.
      expect(offered.map((entry) => entry.function?.name)).toContain("plugins_authoring_guide");
      expect(offered.map((entry) => entry.function?.name)).toContain("plugins_validate");
      // Configuring the heartbeat by chat; its own heartbeat.report is offered to heartbeat turns only.
      for (const added of ["heartbeat_status", "heartbeat_propose"]) expect(offered.map((entry) => entry.function?.name)).toContain(added);
      expect(offered.map((entry) => entry.function?.name)).not.toContain("heartbeat_report");
      // The PDF tools, and pdf.overlay.
      for (const added of ["pdf_read", "pdf_view", "pdf_fields", "pdf_render", "pdf_fill", "pdf_overlay"])
        expect(offered.map((entry) => entry.function?.name)).toContain(added);
      // Site profiles' structured-data read.
      if (chromium) expect(offered.map((entry) => entry.function?.name)).toContain("browser_structured");
      // The video tools, where the person's FFmpeg is found, as the owner offers them.
      const video = ["video_info", "video_frames", "video_view", "video_pose", "video_transcribe"];
      if ("missing" in findFfmpeg()) for (const absent of video) expect(offered.map((entry) => entry.function?.name)).not.toContain(absent);
      else for (const added of video) expect(offered.map((entry) => entry.function?.name)).toContain(added);
      // A local chat's own answer is its reply: messaging.send is offered only in a turn a channel message started.
      expect(offered.map((entry) => entry.function?.name)).not.toContain("messaging_send");
      // Schedules from a chat (F1), forgetting a memory (F2), the skill tools (E4–E6) and the to-do list (F9).
      for (const added of [
        "schedules_create",
        "schedules_list",
        "schedules_history",
        "schedules_update",
        "schedules_pause",
        "schedules_resume",
        "schedules_run_now",
        "schedules_cancel",
        "memory_forget",
        "skills_read",
        "skills_search",
        "skills_propose",
        "todos_add",
        "todos_list",
        "todos_complete",
        "todos_update",
        "todos_remove",
      ])
        expect(offered.map((entry) => entry.function?.name)).toContain(added);
      // Twelve of them are the browser's, offered only while Chromium is installed.
      expect(offered).toHaveLength(86 + (chromium ? 12 : 0) + ("missing" in findFfmpeg() ? 0 : video.length));
    } finally {
      await endpoint.close();
    }
  });

  it("reports a clear, actionable error when the credential file is empty", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-e2e-empty-");
    const keyFile = join(directory, "api-key");
    // The mistake this guards: an unset variable written through printf. The mode
    // is 0600 because the reader checks permissions before it reports emptiness.
    writeFileSync(keyFile, "", { mode: 0o600 });
    chmodSync(keyFile, 0o600);

    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = keyFile;

    const captured = capture();
    const code = await main(
      ["run", "hello", "--connection", "local", "--model", "stub-model", "--data-dir", directory, "--format", "json"],
      { io: captured.io },
    );

    try {
      expect(code).toBe(EXIT.taskFailed);
      // Names the bound file and the likely cause, instead of "not configured".
      expect(captured.stdout()).toContain("file is empty");
      expect(captured.stdout()).toContain(keyFile);
      expect(endpoint.requests).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it("accepts an explicit --api-key-file binding", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-e2e-flag-");
    const keyFile = join(directory, "api-key");
    writeFileSync(keyFile, "sk-local-probe\n", { mode: 0o600 });

    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    // No environment binding at all: the flag alone must be enough.
    delete process.env["TAVI_API_KEY_FILE"];

    const captured = capture();
    const code = await main(
      [
        "run",
        "Echo ping using the fixture.echo tool.",
        "--connection",
        "local",
        "--model",
        "stub-model",
        "--data-dir",
        directory,
        "--api-key-file",
        keyFile,
      ],
      { io: captured.io },
    );

    try {
      expect(code).toBe(EXIT.ok);
      expect(captured.stdout()).toContain("The tool echoed PING.");
      expect(endpoint.requests).toHaveLength(2);
    } finally {
      await endpoint.close();
    }
  });

  it("prefers the --api-key-file flag over the environment binding", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-e2e-precedence-");
    const flagFile = join(directory, "from-flag");
    const envFile = join(directory, "from-env");
    writeFileSync(flagFile, "sk-from-flag\n", { mode: 0o600 });
    writeFileSync(envFile, "sk-from-env\n", { mode: 0o600 });

    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = envFile;

    const captured = capture();
    const code = await main(
      ["run", "hello", "--connection", "local", "--model", "stub-model", "--data-dir", directory, "--api-key-file", flagFile],
      { io: captured.io },
    );

    try {
      // The stub accepts anything; the point is that the run reaches the network
      // using the flag's binding rather than failing on the environment file.
      expect(code).toBe(EXIT.ok);
      expect(endpoint.requests.length).toBeGreaterThan(0);
    } finally {
      await endpoint.close();
    }
  });

  it("reports a missing credential binding with instructions, without a request", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-e2e-nobind-");
    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    delete process.env["TAVI_API_KEY_FILE"];

    const captured = capture();
    const code = await main(
      ["run", "hello", "--connection", "local", "--model", "stub-model", "--data-dir", directory, "--format", "json"],
      { io: captured.io },
    );

    try {
      expect(code).toBe(EXIT.taskFailed);
      expect(captured.stdout()).toContain("is not configured");
      // The message must say how to fix it, and that ambient keys are not used.
      expect(captured.stdout()).toContain("--api-key-file");
      expect(captured.stdout()).toContain("TAVI_API_KEY_FILE");
      expect(endpoint.requests).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });
});

describe("durable admission", () => {
  it("resolves a re-run with the same operation key without re-running the task", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-admit-");
    const keyFile = join(directory, "api-key");
    writeFileSync(keyFile, "sk-local-probe\n", { mode: 0o600 });
    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = keyFile;

    const args = [
      "run",
      "Echo ping using the fixture.echo tool.",
      "--connection",
      "local",
      "--model",
      "stub-model",
      "--data-dir",
      directory,
      "--format",
      "json",
      "--operation-key",
      "op-fixed-1",
    ];

    const first = capture();
    expect(await main(args, { io: first.io })).toBe(EXIT.ok);
    const generationsAfterFirst = endpoint.requests.length;
    expect(generationsAfterFirst).toBe(2);

    // The retry carries the same operation key: the same task and admission are
    // resolved and the durable outcome is returned without touching the model.
    const second = capture();
    expect(await main(args, { io: second.io })).toBe(EXIT.ok);
    expect(endpoint.requests).toHaveLength(generationsAfterFirst);
    expect(second.stderr()).toContain("Replayed committed admission");

    const completed = parseEvents(second.stdout()).at(-1);
    expect(completed?.kind).toBe("task.completed");
    // The replay reports the same task id as the original run.
    const originalStart = parseEvents(first.stdout())[0];
    expect(completed?.runId).toBe(originalStart?.runId);
    expect(JSON.stringify(completed)).toContain("The tool echoed PING.");

    await endpoint.close();
  });

  it("records the task and its admission intent together", async () => {
    const endpoint = await startStubEndpoint();
    const directory = directories.create("tavi-admit-row-");
    const keyFile = join(directory, "api-key");
    writeFileSync(keyFile, "sk-local-probe\n", { mode: 0o600 });
    process.env["TAVI_BASE_URL"] = endpoint.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = keyFile;

    const captured = capture();
    await main(
      ["run", "Echo ping.", "--connection", "local", "--model", "stub-model", "--data-dir", directory, "--operation-key", "op-recorded"],
      { io: captured.io },
    );

    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const task = await store.asPort().repositories.tasks.getByOperationKey("default", "operator", "op-recorded");
    expect(task).toBeDefined();
    // The task maps a stable id to a persisted thread, and the admission intent
    // committed with it.
    expect(task?.threadId).toBeTruthy();
    const admissions = await store.asPort().repositories.tasks.listAdmissions(task?.taskId ?? "");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ kind: "start", operationKey: "op-recorded" });
    expect(admissions[0]?.state).toBe("committed");
    expect(admissions[0]?.result).toMatchObject({ status: "completed" });
    store.close();

    await endpoint.close();
  });
});
