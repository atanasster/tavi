import { describe, expect, it } from "vitest";

import {
  AgentTreeResultSchema,
  approvalCallsOf,
  CLIENT_EVENT_KINDS,
  CLIENT_PROTOCOL_VERSION,
  IPC_COMMANDS,
  IPC_MAX_FRAME_BYTES,
  MESSAGING_DISPLAY_NAME_MAX,
  MAX_REVIEW_EVENT_REQUESTS,
  ClientEventSchema,
  IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES,
  IPC_PROTOCOL_VERSION,
  IPC_RESERVED_OPERATION_KEY_PREFIX,
  isReservedOperationKey,
  reminderTaskOperationKey,
  IpcCommandPayloadSchemas,
  IpcFrameSchema,
  APPROVAL_NOTE_MAX_CHARS,
  TaviError,
  assertOriginPairing,
  isProtocolMismatch,
  protocolMismatchError,
  parseCommandPayload,
  expectedStepsOf,
  latestSettledAdmission,
  pendingRoundFromAdmission,
  pendingRoundOf,
  resumeIntentIdentity,
  roundResumeKey,
  approvalRowId,
  approvalRoundKey,
  reviewRoundKey,
  type ClientEvent,
} from "../src/index.js";
import { FrameReader, encodeFrame, encodedFrameBytes } from "../src/ipc-codec.js";

/**
 * IPC v2 contract tests.
 *
 * The invariant here is one-directional: the contract may declare a
 * command before an implementation exists, but the handshake must never
 * advertise what it cannot serve. These tests pin the pieces a later change can
 * silently break — the exhaustive payload map, the reserved operation-key
 * prefix, and the fact that a server-initiated frame survives the codec.
 */

describe("IPC v2 constants", () => {
  it("versions the frames and the events separately", () => {
    // v3: payload fields an older owner would strip unread (`expectTarget`); v5: `run`'s `model`;
    // v7: `run`'s `folder` and `clientCwd`.
    expect(IPC_PROTOCOL_VERSION).toBe(7);
    // v4: `wait.settled`; v5 `browser.controlled`; v6 `turn.steered`.
    expect(CLIENT_PROTOCOL_VERSION).toBe(8);
  });

  it("declares the new commands alongside the original six", () => {
    const original = ["tasks", "cancel", "recover", "doctor", "approvals", "shutdown"];
    for (const command of original) expect(IPC_COMMANDS).toContain(command);
    for (const command of [
      "run",
      "subscribe",
      "unsubscribe",
      "approve",
      "review",
      "reply",
      "abort",
      "agents",
      "models",
      "credentials",
      "projects",
      "schedules",
      // The web search providers, over IPC.
      "search",
      // The editable workspace system prompt: one more command, and the length
      // below is what makes adding one
      // a deliberate edit rather than a silent registry change.
      "system-prompt",
      // The sessions panel's pins, archive and seen marks, kept by the owner.
      "ui-preferences",
      // The plugin registry: list, install, review, enable, configure.
      "plugins",
      // Tool rules and session grants.
      "permissions",
      // Per-workspace settings, starting with the timezone.
      "workspace-settings",
      // The Command Center's summary and change feed.
      "center",
      // The operator's memory and proposal review.
      "memory",
      // The operator's skills: listing, a version's body, review, activation and rollback.
      "skills",
      // Reminders for the operator.
      "reminders",
      // Browser history for the Command Center.
      "browser",
      // A chat's own instructions.
      "chat-context",
      // Settings → General's Reset instance, and `tavi reset` on a live owner.
      "reset-instance",
      // Settings → Channels and `tavi channels`.
      "channels",
      // A chat's working folder and the canvas's attach picker.
      "folder",
      "browse",
      // The operator's heartbeat.
      "heartbeat",
      // Ideas, the tab and the empty chat's suggested prompts.
      "ideas",
      // Onboarding: status, the flow and its own marks.
      "onboarding",
      // Connected apps, one read model over every source.
      "apps",
    ]) {
      expect(IPC_COMMANDS).toContain(command);
    }
    expect(IPC_COMMANDS).toContain("artifacts");
    expect(IPC_COMMANDS).toContain("routines");
    expect(IPC_COMMANDS).toContain("plugin-commands");
    expect(IPC_COMMANDS).toHaveLength(45);
  });

  it("bounds any single subscription's backlog, allowing at least one frame", () => {
    // The backlog is unacknowledged bytes across many frames, so it is larger
    // than the single-frame bound by design — but it must admit one frame even
    // if that frame is at the maximum, and it must be finite so a slow reader
    // cannot grow a buffer without limit.
    expect(IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES).toBeGreaterThanOrEqual(IPC_MAX_FRAME_BYTES);
    expect(Number.isFinite(IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES)).toBe(true);
  });
});

describe("channels allow", () => {
  it("takes an optional display name for the person, bounded and not blank", () => {
    const allow = { action: "allow", workspaceId: "default", connectionId: "chat-1", sender: "42", principalId: "alice" };
    expect(parseCommandPayload("channels", allow).ok).toBe(true);
    expect(parseCommandPayload("channels", { ...allow, name: "Alice Smith" }).ok).toBe(true);
    expect(parseCommandPayload("channels", { ...allow, name: "   " }).ok).toBe(false);
    expect(parseCommandPayload("channels", { ...allow, name: "x".repeat(MESSAGING_DISPLAY_NAME_MAX + 1) }).ok).toBe(false);
  });
});

describe("payload schemas", () => {
  it("has a schema for every declared command", () => {
    // The record is `satisfies Record<IpcCommand, …>` so this is enforced at
    // compile time too; asserted at runtime so a hand-edited record is caught.
    for (const command of IPC_COMMANDS) {
      expect(IpcCommandPayloadSchemas[command], `${command} has no payload schema`).toBeDefined();
    }
    expect(Object.keys(IpcCommandPayloadSchemas)).toHaveLength(IPC_COMMANDS.length);
  });

  it("requires a run operation key and refuses the reserved schedule prefix", () => {
    const base = { prompt: "hi", workspaceId: "w", principal: "operator", approval: "client" };
    expect(parseCommandPayload("run", base).ok).toBe(false);
    expect(parseCommandPayload("run", { ...base, operationKey: "op-1" }).ok).toBe(true);
    const reserved = parseCommandPayload("run", {
      ...base,
      operationKey: `${IPC_RESERVED_OPERATION_KEY_PREFIX}fire:1`,
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.message).toMatch(/reserved prefix/);
  });

  it("refuses a reminder fire's key prefix, so no client can claim a reminder task's key", () => {
    const base = { prompt: "hi", workspaceId: "w", principal: "operator", approval: "client" };
    const key = reminderTaskOperationKey("rem-1", "2026-09-30T08:00:00.000Z");
    expect(isReservedOperationKey(key)).toBe(true);
    const reserved = parseCommandPayload("run", { ...base, operationKey: key });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.message).toMatch(/reminder:/);
    expect(parseCommandPayload("run", { ...base, operationKey: "reminders-op" }).ok).toBe(true);
  });

  it("takes a side chat's parent, but never with a target", () => {
    const base = { prompt: "hi", workspaceId: "w", principal: "operator", approval: "client", operationKey: "op-1" };
    const side = parseCommandPayload("run", { ...base, parentChatId: "task-1" });
    expect(side.ok && side.value.parentChatId).toBe("task-1");
    for (const target of ["home", "run"]) {
      const both = parseCommandPayload("run", { ...base, parentChatId: "task-1", target });
      expect(both.ok).toBe(false);
      if (!both.ok) expect(both.message).toContain("parentChatId");
    }
    expect(parseCommandPayload("run", { ...base, parentChatId: "" }).ok).toBe(false);
  });

  it("bounds a run prompt", () => {
    const payload = {
      prompt: "x".repeat(64 * 1024 + 1),
      workspaceId: "w",
      principal: "operator",
      approval: "client",
      operationKey: "op-1",
    };
    expect(parseCommandPayload("run", payload).ok).toBe(false);
    // Nor blank: the offline `tavi run` refuses one, and so does the contract.
    for (const prompt of ["", "   \n\t"]) {
      const blank = parseCommandPayload("run", { ...payload, prompt });
      expect(blank.ok, JSON.stringify(prompt)).toBe(false);
      if (!blank.ok) expect(blank.message).toContain("a run needs a prompt");
    }
    // Kept as sent: surrounding whitespace is not trimmed away.
    const spaced = parseCommandPayload("run", { ...payload, prompt: "  hi  " });
    expect(spaced.ok && spaced.value.prompt).toBe("  hi  ");
  });

  it("refuses an unknown approvals action rather than ignoring it", () => {
    expect(parseCommandPayload("approvals", { action: "list" }).ok).toBe(true);
    const unknown = parseCommandPayload("approvals", { action: "destroy" });
    expect(unknown.ok).toBe(false);
  });

  it("requires recover's generation to be a number, not a cast", () => {
    expect(parseCommandPayload("recover", { taskId: "t", generation: 1 }).ok).toBe(true);
    expect(parseCommandPayload("recover", { taskId: "t", generation: "1" }).ok).toBe(false);
  });

  it("requires exactly one of verdict or decisions on approve", () => {
    const base = { taskId: "t", workspaceId: "w" };
    expect(parseCommandPayload("approve", { ...base, verdict: "approve" }).ok).toBe(true);
    expect(parseCommandPayload("approve", { ...base, decisions: [{ callId: "c", approved: true }] }).ok).toBe(true);
    expect(parseCommandPayload("approve", base).ok).toBe(false);
    expect(parseCommandPayload("approve", { ...base, verdict: "approve", decisions: [{ callId: "c", approved: true }] }).ok).toBe(false);
  });

  it("refuses an approval note the workflow would reject, rather than failing the task later", () => {
    // The workflow's reply parser refuses a longer note and a refused reply fails
    // the task, so the IPC schema shares its bound.
    const base = { taskId: "t", workspaceId: "w", verdict: "approve" };
    expect(parseCommandPayload("approve", { ...base, note: "n".repeat(APPROVAL_NOTE_MAX_CHARS) }).ok).toBe(true);
    expect(parseCommandPayload("approve", { ...base, note: "n".repeat(APPROVAL_NOTE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(
      parseCommandPayload("approve", {
        taskId: "t",
        workspaceId: "w",
        decisions: [{ callId: "c", approved: true, note: "n".repeat(APPROVAL_NOTE_MAX_CHARS + 1) }],
      }).ok,
    ).toBe(false);
  });

  it("refuses a prototype member named as a command instead of calling it as a schema", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const parsed = parseCommandPayload(name as (typeof IPC_COMMANDS)[number], {});
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("unknown command");
    }
  });

  it("does not echo a refused payload's values into the message", () => {
    // A `credentials set` payload carries a secret; the error travels to logs.
    const refused = parseCommandPayload("credentials", { action: "set", reference: "r", value: 42 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).not.toContain("42");
  });
});

describe("the event frame", () => {
  const event: ClientEvent = {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "ep-1",
    sequence: 0,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-09-17T00:00:00.000Z",
    kind: "approval.required",
    callId: "call-1",
    toolName: "sandbox.exec",
    summary: "Approve sandbox.exec?",
    input: { command: "ls" },
    steps: 3,
    // The row id carries the round, exactly as the workflow writes it.
    approvalId: approvalRowId("task-1", "call-1", 3),
  };

  it("round-trips through the shared codec", () => {
    const reader = new FrameReader();
    const { frames, error } = reader.push(encodeFrame({ type: "event", subscriptionId: "sub-1", event }));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: "event", subscriptionId: "sub-1", event });
  });

  it("is accepted by the frame union, so the reader cannot reject it", () => {
    expect(IpcFrameSchema.safeParse({ type: "event", subscriptionId: "sub-1", event }).success).toBe(true);
  });

  it("measures encoded bytes rather than schema character bounds", () => {
    // A 128 KiB `finalText` of multi-byte characters is ~3x that in UTF-8, so a
    // budget derived from `.max()` lengths would under-count.
    const wide: ClientEvent = { ...event, kind: "task.completed", finalText: "\u4e2d".repeat(128 * 1024) };
    const frame = { type: "event" as const, subscriptionId: "sub-1", event: wide };
    const measured = encodedFrameBytes(frame);
    // Measured, not inferred: the schema's `.max(128 * 1024)` is a *character*
    // bound, and the encoded frame is larger than it because each of these
    // characters is three UTF-8 bytes.
    expect(measured).toBeGreaterThan(128 * 1024);
  });

  it("can represent the largest legitimate review round", () => {
    // The workflow can flag up to MAX_WORKFLOW_TOOL_CALLS (24) tool calls whose
    // messages each name 16 artifacts — 384 entries. A `.max(64)` here made a
    // round that the interrupt can carry impossible to report as an event.
    const requests = Array.from({ length: MAX_REVIEW_EVENT_REQUESTS }, (_, index) => ({
      artifactId: `art-${index}`,
      toolName: "sandbox.run",
      callId: `call-${index}`,
    }));
    const review: ClientEvent = {
      ...event,
      kind: "task.review_required",
      steps: 1,
      requests,
    };
    expect(ClientEventSchema.safeParse(review).success).toBe(true);
    expect(ClientEventSchema.safeParse({ ...review, requests: [...requests, requests[0]!] }).success).toBe(false);
  });

  it("derives the durable round keys a decision commits under", () => {
    // These are durable identities, not display strings: a decision is committed
    // under the approval round key, so the format has to be pinned here rather
    // than discovered when the handler lands.
    expect(approvalRoundKey("task-1", 3)).toBe("approval:6:task-1:3");
    // A review suspension is keyed on its waiting admission too: the review node
    // suspends again under the same `steps` while a flagged artifact is still
    // undecided, and each of those suspensions is acknowledged separately.
    expect(reviewRoundKey("task-1", 3, "adm-1")).toBe("review:6:task-1:3:5:adm-1");
    expect(reviewRoundKey("task-1", 3, "adm-1")).not.toBe(reviewRoundKey("task-1", 3, "adm-2"));
  });

  it("length-prefixes the row id so a delimiter inside an id cannot collide", () => {
    // `IdSchema` does not forbid a colon, so `taskId="a:b", callId="c"` must not
    // produce the same row id as `taskId="a", callId="b:c"`.
    expect(approvalRowId("a:b", "c", 1)).not.toBe(approvalRowId("a", "b:c", 1));
    // And the round distinguishes two rows for one reused call id.
    expect(approvalRowId("task-1", "call-1", 1)).not.toBe(approvalRowId("task-1", "call-1", 2));
  });

  it("declares the three new event kinds", () => {
    for (const kind of ["task.waiting", "task.review_required", "approval.settled"]) {
      expect(CLIENT_EVENT_KINDS).toContain(kind);
    }
  });
});

describe("task origin pairing", () => {
  it("refuses a schedule id under another origin and a schedule origin with no id", () => {
    expect(() => assertOriginPairing({ origin: "cli", originScheduleId: "sched-1" })).toThrowError(TaviError);
    // The other direction: a schedule origin that names no fire could never be
    // attributed to one, so the in-flight rule would have nothing to check.
    expect(() => assertOriginPairing({ origin: "schedule" })).toThrowError(/originScheduleId/);
    expect(() => assertOriginPairing({ origin: "schedule", originScheduleId: "sched-1" })).not.toThrow();
    expect(() => assertOriginPairing({ origin: "ipc" })).not.toThrow();
    expect(() => assertOriginPairing({})).not.toThrow();
  });
});

describe("the pending round", () => {
  const admission = (overrides: Partial<import("../src/index.js").AdmissionRecord>): import("../src/index.js").AdmissionRecord => ({
    admissionId: "adm",
    taskId: "task-1",
    operationKey: "op",
    kind: "start",
    intent: null,
    intentHash: "h",
    state: "committed",
    result: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  const approvalOutcome = (steps: number, calls: string[]) => ({
    status: "waiting" as const,
    finalText: "",
    interrupt: {
      requests: calls.map((callId) => ({
        callId,
        toolName: "t",
        summary: "s",
        input: {},
        effect: "mutating",
        steps,
      })),
    },
  });

  it("is the latest admission with an outcome, when that outcome is a suspension on a round", () => {
    const round = pendingRoundOf([
      admission({ admissionId: "a1", result: approvalOutcome(1, ["c1"]) }),
      admission({ admissionId: "a2", result: approvalOutcome(3, ["c1", "c2"]) }),
    ]);
    expect(round).toMatchObject({ kind: "approval", steps: 3, admissionId: "a2", callIds: ["c1", "c2"] });
    expect(roundResumeKey("task-1", round!)).toBe(approvalRoundKey("task-1", 3));
  });

  it("is nothing once a later admission moved the task on", () => {
    expect(
      pendingRoundOf([
        admission({ admissionId: "a1", result: approvalOutcome(1, ["c1"]) }),
        admission({ admissionId: "a2", result: { status: "completed", finalText: "done" } }),
      ]),
    ).toBeUndefined();
  });

  it("skips a refused admission and one that has no outcome yet", () => {
    const round = pendingRoundOf([
      admission({ admissionId: "a1", result: approvalOutcome(2, ["c1"]) }),
      admission({ admissionId: "a2", state: "refused", result: { status: "failed", finalText: "stale" } }),
      admission({ admissionId: "a3", state: "claimed", result: null }),
    ]);
    expect(round).toMatchObject({ kind: "approval", steps: 2, admissionId: "a1" });
  });

  it("names a review round, keyed by its round and its waiting admission", () => {
    const review = pendingRoundOf([
      admission({
        admissionId: "a1",
        result: {
          status: "waiting",
          finalText: "",
          reviewInterrupt: { requests: [{ artifactId: "art-1", callId: "c1", toolName: "t", steps: 4 }] },
        },
      }),
    ]);
    expect(review).toMatchObject({ kind: "review", steps: 4, artifactIds: ["art-1"] });
    expect(roundResumeKey("task-1", review!)).toBe(reviewRoundKey("task-1", 4, "a1"));
  });

  it("is nothing when the latest outcome failed, or suspended on a wait rather than a round", () => {
    expect(
      pendingRoundOf([
        admission({ admissionId: "a1", result: approvalOutcome(1, ["c1"]) }),
        admission({ admissionId: "a2", result: { status: "failed", finalText: "", error: { code: "INTERNAL", message: "x" } } }),
      ]),
    ).toBeUndefined();
    expect(
      pendingRoundOf([
        admission({
          admissionId: "a1",
          result: {
            status: "waiting",
            finalText: "",
            waitInterrupt: { wait: { waitId: "w1", deadlineAt: "2026-01-02T00:00:00.000Z" }, question: "why?" },
          },
        }),
      ]),
    ).toBeUndefined();
  });

  it("finds the latest settled admission, and states a round's precondition", () => {
    const rows = [
      admission({ admissionId: "a1", result: approvalOutcome(2, ["c1"]) }),
      admission({ admissionId: "a2", state: "refused", result: { status: "failed", finalText: "" } }),
    ];
    expect(latestSettledAdmission(rows)?.admissionId).toBe("a1");
    expect(latestSettledAdmission([])).toBeUndefined();
    expect(pendingRoundFromAdmission(undefined)).toBeUndefined();
    expect(expectedStepsOf({ steps: 2 })).toEqual({ expectedSteps: 2 });
  });
});

describe("a resume's identity", () => {
  it("leaves out who decided, but not what a rejection told the model", () => {
    expect(resumeIntentIdentity({ approved: true, decidedBy: "alice", note: "fine" })).toEqual(
      resumeIntentIdentity({ approved: true, decidedBy: "bob" }),
    );
    // A rejection's note is the tool result the model reads: two rejections with
    // different instructions are two different decisions.
    expect(resumeIntentIdentity({ approved: false, note: "no" })).not.toEqual(
      resumeIntentIdentity({ approved: false, note: "no, write to /tmp instead" }),
    );
    expect(resumeIntentIdentity({ decisions: [{ callId: "c1", approved: false, note: "no" }], decidedBy: "alice" })).not.toEqual(
      resumeIntentIdentity({ decisions: [{ callId: "c1", approved: false, note: "other" }] }),
    );
    expect(resumeIntentIdentity({ decisions: [{ callId: "c1", approved: true, note: "ok" }] })).toEqual(
      resumeIntentIdentity({ decisions: [{ callId: "c1", approved: true }] }),
    );
  });

  it("is one decision whatever the order of its calls, and whatever round it names", () => {
    const forward = resumeIntentIdentity({
      decisions: [
        { callId: "c1", approved: true },
        { callId: "c2", approved: false },
      ],
      expectedSteps: 3,
    });
    const backward = resumeIntentIdentity({
      decisions: [
        { callId: "c2", approved: false },
        { callId: "c1", approved: true },
      ],
    });
    expect(forward).toEqual(backward);
    // A review acknowledgement and an approval are never one identity.
    expect(resumeIntentIdentity({ reviewAck: true })).not.toEqual(resumeIntentIdentity({ approved: true }));
  });
});

describe("the protocol mismatch every client reports", () => {
  it("names both versions and the remedy, and is recognisable whichever client raised it", () => {
    const error = protocolMismatchError(IPC_PROTOCOL_VERSION - 1);
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toBe(
      `the running \`tavi serve\` speaks protocol ${IPC_PROTOCOL_VERSION - 1}; this CLI speaks ${IPC_PROTOCOL_VERSION} — restart the service`,
    );
    expect(isProtocolMismatch(error)).toBe(true);
    // Rebuilt with the same details (as `@tavi/client` does, adding its own), still recognised.
    expect(isProtocolMismatch(new TaviError(error.code, error.message, { details: { ...error.details, handshake: "protocol" } }))).toBe(
      true,
    );
    expect(isProtocolMismatch(new TaviError("UNAVAILABLE", error.message))).toBe(false);
    expect(isProtocolMismatch(new Error(error.message))).toBe(false);
  });
});

it("rejects old strict event envelopes and bounds the tree result", () => {
  const event = {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "e",
    sequence: 1,
    runId: "r",
    attemptId: "a",
    at: "2026-01-01T00:00:00Z",
    kind: "task.spawned",
    childRunId: "c",
    workerAgentId: "w",
    depth: 1,
  };
  expect(ClientEventSchema.safeParse(event).success).toBe(true);
  expect(ClientEventSchema.safeParse({ ...event, protocolVersion: 2 }).success).toBe(false);
  expect(
    AgentTreeResultSchema.safeParse({
      taskId: "r",
      workspaceId: "w",
      ancestors: [],
      nodes: Array(201).fill({ taskId: "r", status: "running", depth: 0, createdAt: event.at, updatedAt: event.at }),
      truncated: true,
      ancestryUnknown: false,
    }).success,
  ).toBe(false);
});

it("classifies reserved routine policies before strict payload parsing", () => {
  for (const snapshot of [
    { triggers: [{ kind: "event" }] },
    { execution: { overlap: "queue" } },
    { execution: { overlap: "cancel_previous" } },
  ]) {
    expect(parseCommandPayload("routines", { action: "update", update: { snapshot } })).toMatchObject({ ok: false, code: "UNSUPPORTED" });
  }
});

describe("approvalCallsOf", () => {
  it("masks a call's stored inputs when asked, and keeps them otherwise", () => {
    const record = {
      steps: 1,
      callId: "c1",
      toolId: "fs.write",
      inputs: { content: "key AKIAIOSFODNN7EXAMPLE" },
      state: "pending",
      decidedBy: null,
      note: null,
    };
    expect(approvalCallsOf([record], true)[0]?.inputs).toEqual({ content: "key [redacted:aws-key]" });
    expect(approvalCallsOf([record])[0]?.inputs).toEqual({ content: "key AKIAIOSFODNN7EXAMPLE" });
  });
});
