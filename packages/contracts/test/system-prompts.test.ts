import { describe, expect, it } from "vitest";

import {
  MAX_SYSTEM_PROMPT_CODE_UNITS,
  MAX_TASK_PROMPT_SNAPSHOT_BYTES,
  ResetWorkspaceSystemPromptInputSchema,
  SetWorkspaceSystemPromptInputSchema,
  SystemPromptAnswerSchema,
  SystemPromptLayerSchema,
  SystemPromptPayloadSchema,
  SystemPromptTextSchema,
  TaskPromptSnapshotRecordSchema,
  WorkspaceSystemPromptRecordSchema,
  absentWorkspaceSystemPrompt,
} from "../src/system-prompts.js";

const hash = "a".repeat(64);

describe("SystemPromptTextSchema", () => {
  it("accepts text up to the editor bound and preserves it exactly", () => {
    const text = "\n  leading and trailing  \n";
    expect(SystemPromptTextSchema.parse(text)).toBe(text);
    expect(SystemPromptTextSchema.safeParse("x".repeat(MAX_SYSTEM_PROMPT_CODE_UNITS)).success).toBe(true);
  });

  it("rejects an empty, whitespace-only or over-limit prompt", () => {
    expect(SystemPromptTextSchema.safeParse("").success).toBe(false);
    expect(SystemPromptTextSchema.safeParse("   \n\t ").success).toBe(false);
    expect(SystemPromptTextSchema.safeParse("x".repeat(MAX_SYSTEM_PROMPT_CODE_UNITS + 1)).success).toBe(false);
  });

  it("counts JavaScript string code units, so 10,000 astral characters are 20,000 units", () => {
    // The bound is stated in JavaScript string code units, which is what the DOM
    // `maxLength` counts — but NOT what zod's `.max()` counts: on the pinned zod
    // 4.6.5 `z.string().max(20_000)` accepts 20,002 code units, which is exactly
    // why `SystemPromptTextSchema` measures `.length` in an explicit `refine`.
    // Replacing that refine with `.max()` would silently widen the bound.
    expect(SystemPromptTextSchema.safeParse("\u{1F600}".repeat(10_000)).success).toBe(true);
    expect(SystemPromptTextSchema.safeParse("\u{1F600}".repeat(10_001)).success).toBe(false);
  });
});

describe("WorkspaceSystemPromptRecordSchema", () => {
  it("describes the absent row as revision zero with no override", () => {
    const record = absentWorkspaceSystemPrompt("ws-1");
    expect(WorkspaceSystemPromptRecordSchema.parse(record)).toEqual(record);
    expect(record.revision).toBe(0);
    expect(record.text).toBeNull();
  });

  it("refuses a negative revision and a hash that disagrees with the text", () => {
    expect(WorkspaceSystemPromptRecordSchema.safeParse({ ...absentWorkspaceSystemPrompt("ws-1"), revision: -1 }).success).toBe(false);
    // A hash with nothing to hash, and text with no hash, are both rows this
    // build cannot account for.
    expect(WorkspaceSystemPromptRecordSchema.safeParse({ ...absentWorkspaceSystemPrompt("ws-1"), hash }).success).toBe(false);
    expect(WorkspaceSystemPromptRecordSchema.safeParse({ ...absentWorkspaceSystemPrompt("ws-1"), text: "base" }).success).toBe(false);
    expect(WorkspaceSystemPromptRecordSchema.safeParse({ ...absentWorkspaceSystemPrompt("ws-1"), text: "base", hash }).success).toBe(true);
    expect(
      WorkspaceSystemPromptRecordSchema.safeParse({ ...absentWorkspaceSystemPrompt("ws-1"), text: "base", hash: "not-hex" }).success,
    ).toBe(false);
    // The schema can only check the hash's *shape* — matching it to the text
    // needs a digest, which is the repository's check on both paths.
  });
});

describe("write payload schemas", () => {
  it("accepts a complete set payload and rejects a malformed revision or extra key", () => {
    const payload = { workspaceId: "ws-1", text: "base", expectedRevision: 0, actor: "operator", now: "2026-01-01T00:00:00.000Z" };
    expect(SetWorkspaceSystemPromptInputSchema.safeParse(payload).success).toBe(true);
    expect(SetWorkspaceSystemPromptInputSchema.safeParse({ ...payload, expectedRevision: -1 }).success).toBe(false);
    expect(SetWorkspaceSystemPromptInputSchema.safeParse({ ...payload, expectedRevision: 0.5 }).success).toBe(false);
    expect(SetWorkspaceSystemPromptInputSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
    expect(SetWorkspaceSystemPromptInputSchema.safeParse({ ...payload, text: "   " }).success).toBe(false);
  });

  it("accepts a reset payload without text", () => {
    expect(
      ResetWorkspaceSystemPromptInputSchema.safeParse({
        workspaceId: "ws-1",
        expectedRevision: 3,
        actor: "operator",
        now: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(ResetWorkspaceSystemPromptInputSchema.safeParse({ workspaceId: "ws-1", expectedRevision: 3 }).success).toBe(false);
  });
});

describe("TaskPromptSnapshotRecordSchema", () => {
  const base = { taskId: "task-1", workspaceId: "ws-1", boundAt: "2026-01-01T00:00:00.000Z" };

  it("refuses a row with no text: every stored snapshot is bound", () => {
    const unbound = { ...base, source: "legacy_unbound", text: null, hash: null, revision: null, templateVersion: null };
    expect(TaskPromptSnapshotRecordSchema.safeParse(unbound).success).toBe(false);
  });

  it("requires text and a 64-hex hash for every bound source", () => {
    expect(
      TaskPromptSnapshotRecordSchema.safeParse({ ...base, source: "explicit", text: "base", hash, revision: null, templateVersion: null })
        .success,
    ).toBe(true);
    expect(
      TaskPromptSnapshotRecordSchema.safeParse({
        ...base,
        source: "explicit",
        text: "base",
        hash: null,
        revision: null,
        templateVersion: null,
      }).success,
    ).toBe(false);
    expect(
      TaskPromptSnapshotRecordSchema.safeParse({ ...base, source: "workspace", text: "base", hash, revision: null, templateVersion: null })
        .success,
    ).toBe(false);
  });

  it("bounds a bound snapshot by UTF-8 bytes, not by the editor limit", () => {
    const over = "x".repeat(MAX_TASK_PROMPT_SNAPSHOT_BYTES + 1);
    expect(
      TaskPromptSnapshotRecordSchema.safeParse({
        ...base,
        source: "explicit",
        text: over,
        hash,
        revision: null,
        templateVersion: null,
      }).success,
    ).toBe(false);
    // Multi-byte text counts by encoded size: an emoji is four bytes.
    const emoji = "\u{1F600}".repeat(MAX_TASK_PROMPT_SNAPSHOT_BYTES / 4);
    expect(
      TaskPromptSnapshotRecordSchema.safeParse({
        ...base,
        source: "explicit",
        text: emoji,
        hash,
        revision: null,
        templateVersion: null,
      }).success,
    ).toBe(true);
  });
});

describe("SystemPromptPayloadSchema", () => {
  it("accepts a get with only its workspace, and rejects a write without an expected revision", () => {
    expect(SystemPromptPayloadSchema.safeParse({ action: "get", workspaceId: "ws-1" }).success).toBe(true);
    // A write with no revision would be an unconditional overwrite.
    expect(SystemPromptPayloadSchema.safeParse({ action: "set", workspaceId: "ws-1", text: "base" }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "reset", workspaceId: "ws-1" }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "reset", workspaceId: "ws-1", expectedRevision: 2 }).success).toBe(true);
  });

  it("requires text for set and refuses a whitespace-only or extra field", () => {
    expect(SystemPromptPayloadSchema.safeParse({ action: "set", workspaceId: "ws-1", expectedRevision: 0, text: "base" }).success).toBe(
      true,
    );
    expect(SystemPromptPayloadSchema.safeParse({ action: "set", workspaceId: "ws-1", expectedRevision: 0 }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "set", workspaceId: "ws-1", expectedRevision: 0, text: "   " }).success).toBe(
      false,
    );
    expect(SystemPromptPayloadSchema.safeParse({ action: "get", workspaceId: "ws-1", extra: true }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "show", workspaceId: "ws-1" }).success).toBe(false);
  });
});

describe("SystemPromptPayloadSchema preview", () => {
  it("takes an optional workspace and agent, and nothing a write reads", () => {
    expect(SystemPromptPayloadSchema.safeParse({ action: "preview" }).success).toBe(true);
    expect(SystemPromptPayloadSchema.safeParse({ action: "preview", workspaceId: "ws-1", agentId: "sdaddy" }).success).toBe(true);
    expect(SystemPromptPayloadSchema.safeParse({ action: "preview", expectedRevision: 0 }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "preview", text: "base" }).success).toBe(false);
    // Only preview reads an agent, and only preview may omit its workspace.
    expect(SystemPromptPayloadSchema.safeParse({ action: "get", workspaceId: "ws-1", agentId: "sdaddy" }).success).toBe(false);
    expect(SystemPromptPayloadSchema.safeParse({ action: "get" }).success).toBe(false);
  });
});

describe("SystemPromptLayerSchema", () => {
  it("counts the active skills a context layer may draw on, when the owner says", () => {
    const context = { kind: "context", label: "Memory and skills context", generated: true, active: true };
    expect(SystemPromptLayerSchema.safeParse(context).success).toBe(true);
    expect(SystemPromptLayerSchema.safeParse({ ...context, skills: 0 }).success).toBe(true);
    expect(SystemPromptLayerSchema.safeParse({ ...context, skills: -1 }).success).toBe(false);
    expect(SystemPromptLayerSchema.safeParse({ ...context, skills: 1.5 }).success).toBe(false);
  });
});

describe("SystemPromptAnswerSchema", () => {
  const shipped = { text: "default", templateVersion: "v1" };
  it("describes a workspace with no override", () => {
    expect(
      SystemPromptAnswerSchema.safeParse({
        workspaceId: "ws-1",
        revision: 0,
        custom: null,
        shipped,
        effective: { text: "default", source: "builtin", revision: null, templateVersion: "v1" },
        appliesTo: "next-message",
        explicitAdapterShadowing: false,
      }).success,
    ).toBe(true);
  });

  it("refuses a source/revision mismatch, so `effective` cannot describe an impossible selection", () => {
    const base = {
      workspaceId: "ws-1",
      revision: 3,
      custom: null,
      shipped,
      appliesTo: "next-message" as const,
      explicitAdapterShadowing: false,
    };
    expect(
      SystemPromptAnswerSchema.safeParse({ ...base, effective: { text: "default", source: "builtin", revision: 3, templateVersion: "v1" } })
        .success,
    ).toBe(false);
  });
});
