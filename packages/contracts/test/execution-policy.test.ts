import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_REPORT_TOOL_ID,
  HEARTBEAT_TASK_POLICY,
  ROUTINE_CHECKPOINT_TASK_POLICY,
  ROUTINE_TASK_POLICY,
  RoutineSnapshotSchema,
  SCHEDULE_TASK_POLICY,
  ScheduleEmailTriggerInputSchema,
  TaskExecutionPolicySchema,
  policyAllowsTool,
  readerSessionAllows,
  routineDefaults,
  scheduleEmailSenderListed,
  scheduleEmailSubjectMatches,
} from "../src/index.js";

/** An unattended run may ask only when every question must carry a default. */
describe("TaskExecutionPolicySchema", () => {
  it("lets an unattended policy allow questions only when each must carry a default", () => {
    expect(TaskExecutionPolicySchema.safeParse(ROUTINE_CHECKPOINT_TASK_POLICY).success).toBe(true);
    expect(TaskExecutionPolicySchema.safeParse(ROUTINE_TASK_POLICY).success).toBe(true);
    expect(
      TaskExecutionPolicySchema.safeParse({ mode: "unattended", humanQuestionsAllowed: true, workerWaitsAllowed: false }).success,
    ).toBe(false);
    expect(
      TaskExecutionPolicySchema.safeParse({
        mode: "unattended",
        humanQuestionsAllowed: true,
        requiresDefault: false,
        workerWaitsAllowed: false,
      }).success,
    ).toBe(false);
  });
});

describe("a routine's human checkpoints", () => {
  const snapshot = {
    ...routineDefaults("Europe/Sofia"),
    objective: "Find news",
    agent: { agentId: "news", name: "News", revision: 1, instructions: "Find evidence", hash: "a".repeat(64) },
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
    skills: [],
    models: {
      research: { primary: { connectionId: "r", model: "r1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "s", model: "s1" }, fallbacks: [] },
    },
    permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
  };
  const ask = { ...snapshot.execution, humanCheckpoints: "ask-with-default" };

  it("reads a revision from before the setting as off, and needs a destination to ask in", () => {
    expect(RoutineSnapshotSchema.parse(snapshot).execution.humanCheckpoints).toBeUndefined();
    expect(RoutineSnapshotSchema.safeParse({ ...snapshot, execution: ask }).success).toBe(false);
    expect(
      RoutineSnapshotSchema.safeParse({
        ...snapshot,
        execution: ask,
        report: { ...snapshot.report, formats: ["in-app", "pdf"] },
        delivery: { ...snapshot.delivery, targetIds: ["chat"] },
      }).success,
    ).toBe(true);
  });
});

/** The heartbeat's structured answer is offered only to a task that names it. */
describe("policyAllowsTool", () => {
  it("admits an allowlist-only tool only when the allowlist names it exactly", () => {
    expect(policyAllowsTool(HEARTBEAT_TASK_POLICY, HEARTBEAT_REPORT_TOOL_ID)).toBe(true);
    expect(policyAllowsTool({}, HEARTBEAT_REPORT_TOOL_ID)).toBe(false);
    expect(policyAllowsTool({ toolAllowlist: ["*"] }, HEARTBEAT_REPORT_TOOL_ID)).toBe(false);
    expect(policyAllowsTool({ toolAllowlist: ["heartbeat.*"] }, HEARTBEAT_REPORT_TOOL_ID)).toBe(false);
  });

  it("admits any other tool with no allowlist, and by pattern with one", () => {
    expect(policyAllowsTool({}, "memory.search")).toBe(true);
    expect(policyAllowsTool(HEARTBEAT_TASK_POLICY, "memory.search")).toBe(true);
    expect(policyAllowsTool(HEARTBEAT_TASK_POLICY, "fs.write")).toBe(false);
  });
});

describe("a reader session", () => {
  const reader = { ...SCHEDULE_TASK_POLICY, readOnlyTools: true };

  it("is kept on a task's policy, and admits only tools that read", () => {
    expect(TaskExecutionPolicySchema.parse(reader)).toMatchObject({ readOnlyTools: true });
    expect(readerSessionAllows(reader, { id: "memory.search", effect: "read-only" }, { hasDelivery: false })).toBe(true);
    expect(readerSessionAllows(reader, { id: "fs.write", effect: "mutating" }, { hasDelivery: true })).toBe(false);
    expect(readerSessionAllows(reader, { id: "web_search", effect: "external" }, { hasDelivery: true })).toBe(false);
    // A tool that reads but reaches out is not a read here: a page fetch, a search, an MCP server's read.
    expect(readerSessionAllows(reader, { id: "fs.read", effect: "read-only", sink: "none" }, { hasDelivery: false })).toBe(true);
    expect(readerSessionAllows(reader, { id: "web_fetch", effect: "read-only", sink: "network" }, { hasDelivery: true })).toBe(false);
    expect(readerSessionAllows(reader, { id: "web_search", effect: "read-only", sink: "search" }, { hasDelivery: true })).toBe(false);
    expect(readerSessionAllows(reader, { id: "mcp.notes.lookup", effect: "read-only", sink: "network" }, { hasDelivery: false })).toBe(
      false,
    );
    // Any other policy admits everything here.
    expect(readerSessionAllows(SCHEDULE_TASK_POLICY, { id: "fs.write", effect: "mutating" }, { hasDelivery: false })).toBe(true);
  });

  it("keeps its delivery tool only with a destination, and a call of it only as a send there", () => {
    const sendTo = { id: "messaging.send_to", effect: "external" as const };
    expect(readerSessionAllows(reader, sendTo, { hasDelivery: false })).toBe(false);
    expect(readerSessionAllows(reader, sendTo, { hasDelivery: true })).toBe(true);
    expect(readerSessionAllows(reader, sendTo, { hasDelivery: true, atGate: true, assessedSink: "reply" })).toBe(true);
    expect(readerSessionAllows(reader, sendTo, { hasDelivery: true, atGate: true, assessedSink: "message" })).toBe(false);
    expect(readerSessionAllows(reader, sendTo, { hasDelivery: true, atGate: true })).toBe(false);
  });
});

describe("an email trigger's senders", () => {
  it("takes addresses and domains, lower-cased, and refuses anything else", () => {
    const parsed = ScheduleEmailTriggerInputSchema.parse({ connectionId: "mail-1", senders: [" Ann@Example.com ", "@Example.org"] });
    expect(parsed.senders).toEqual(["ann@example.com", "@example.org"]);
    for (const bad of ["ann", "ann@", "@", "ann@localhost", "two words@example.com", "*@example.com"])
      expect(ScheduleEmailTriggerInputSchema.safeParse({ connectionId: "mail-1", senders: [bad] }).success, bad).toBe(false);
    expect(ScheduleEmailTriggerInputSchema.safeParse({ connectionId: "mail-1", senders: [] }).success).toBe(false);
  });

  it("matches an address exactly or by its whole domain, never a subdomain or a look-alike", () => {
    const senders = ["ann@example.com", "@example.org"];
    expect(scheduleEmailSenderListed(senders, "Ann@Example.com")).toBe(true);
    expect(scheduleEmailSenderListed(senders, "bob@example.org")).toBe(true);
    expect(scheduleEmailSenderListed(senders, "bob@example.com")).toBe(false);
    expect(scheduleEmailSenderListed(senders, "bob@mail.example.org")).toBe(false);
    expect(scheduleEmailSenderListed(senders, "bob@example.org.evil.test")).toBe(false);
    expect(scheduleEmailSenderListed(senders, "ann@example.com@evil.test")).toBe(false);
    expect(scheduleEmailSenderListed(senders, "")).toBe(false);
  });

  it("matches a subject filter in any case, and every subject without one", () => {
    expect(scheduleEmailSubjectMatches({ subject: "invoice" }, "Your INVOICE for May")).toBe(true);
    expect(scheduleEmailSubjectMatches({ subject: "invoice" }, "Receipt")).toBe(false);
    expect(scheduleEmailSubjectMatches({ subject: "invoice" }, undefined)).toBe(false);
    expect(scheduleEmailSubjectMatches({}, undefined)).toBe(true);
  });
});
