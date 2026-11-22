import type { RoutineDetail } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "../../../src/lib/i18n.js";
import { settingsPath } from "../../../src/features/shell/route.js";
import { evaluationWords, pausedDeliveryTarget, routineStatusView } from "../../../src/features/routines/status.js";

/** A routine as the owner reports it, varied per case. */
function detail(routine: Partial<RoutineDetail["routine"]>, evaluation: Partial<RoutineDetail["evaluation"]> = {}): RoutineDetail {
  return {
    routine: {
      routineId: "r",
      workspaceId: "default",
      principalId: "operator",
      name: "LLM news",
      version: 1,
      activeRevision: null,
      latestRevision: 1,
      status: "draft",
      conversationId: null,
      createdAt: "",
      updatedAt: "",
      ...routine,
    },
    evaluation: {
      evaluationId: "e",
      routineId: "r",
      revision: 1,
      status: "pending",
      detail: "",
      createdAt: "",
      finishedAt: null,
      ...evaluation,
    },
  } as unknown as RoutineDetail;
}

describe("a routine's status, as its page presents it", () => {
  it("says why setup is needed, offers neither Resume nor Run, and keeps polling for the retry", () => {
    const view = routineStatusView(detail({ status: "setup-needed" }, { detail: "No web search provider is configured." }));
    expect(view).toMatchObject({ pause: false, resume: false, run: false, evaluateAgain: false, settling: true });
    expect(view.notice).toEqual({
      tone: "warning",
      title: "Setup needed",
      detail: "No web search provider is configured.",
      action: { kind: "readiness", label: "Check readiness" },
    });
    expect(view.checkReadiness).toBe(true);
    expect(view.runBlocked).toBe("Available once the routine has passed its evaluation.");
  });

  it("falls back to pointing at Health when an older owner recorded no reason", () => {
    expect(routineStatusView(detail({ status: "setup-needed" })).notice?.detail).toContain("Check Health below");
  });

  it("offers Evaluate again after a failed first evaluation, and stops polling", () => {
    const view = routineStatusView(detail({ status: "draft" }, { status: "failed", detail: "Evaluation interrupted by owner restart." }));
    expect(view).toMatchObject({ evaluateAgain: true, resume: false, run: false, settling: false });
    expect(view.notice?.title).toBe("Evaluation failed");
  });

  it("pauses and runs an active routine, and resumes only an evaluated paused one", () => {
    expect(routineStatusView(detail({ status: "active", activeRevision: 1 }, { status: "passed" }))).toMatchObject({
      pause: true,
      resume: false,
      run: true,
    });
    expect(routineStatusView(detail({ status: "paused", activeRevision: 1 }, { status: "passed" }))).toMatchObject({
      pause: false,
      resume: true,
      run: false,
      runBlocked: "Resume the routine to run it.",
    });
    // Paused before its first evaluation passed: nothing to resume into.
    expect(routineStatusView(detail({ status: "paused" }))).toMatchObject({ resume: false });
  });

  it("never resumes a completed routine, and leaves an archived one read-only", () => {
    expect(routineStatusView(detail({ status: "completed", activeRevision: 1 }, { status: "passed" }))).toMatchObject({
      resume: false,
      run: false,
      runBlocked: "This routine has no trigger left to run.",
    });
    expect(routineStatusView(detail({ status: "archived", activeRevision: 1 }, { status: "passed" }))).toMatchObject({
      edit: false,
      archive: false,
      run: false,
      evaluateAgain: false,
      settling: false,
    });
  });

  it("tells an active routine's owner when its newer revision is waiting, failed or blocked, while the old one runs", () => {
    const active = { status: "active" as const, activeRevision: 1, latestRevision: 2 };
    expect(routineStatusView(detail(active, { revision: 2, status: "pending" })).notice?.title).toBe("Evaluating revision 2");
    expect(
      routineStatusView(detail(active, { revision: 2, status: "pending", detail: "No web search provider is configured." })).notice,
    ).toMatchObject({ tone: "warning", title: "Revision 2 cannot be evaluated yet" });
    const failed = routineStatusView(detail(active, { revision: 2, status: "failed", detail: "Below threshold." }));
    expect(failed).toMatchObject({ evaluateAgain: true, run: true });
    expect(failed.notice?.detail).toContain("Revision 1 keeps running");
  });

  it("offers only Archive for a routine whose owner is no longer allowed, and says why", () => {
    const revoked = { ...detail({ principalId: "ana", status: "active", activeRevision: 1 }, { status: "passed" }), ownerRevoked: true };
    expect(routineStatusView(revoked)).toMatchObject({
      pause: false,
      resume: false,
      run: false,
      evaluateAgain: false,
      edit: false,
      archive: true,
      preview: false,
      settling: false,
      runBlocked: "Its owner is no longer allowed in this workspace.",
    });
    expect(routineStatusView(revoked).notice).toMatchObject({
      tone: "warning",
      title: "Owner no longer allowed",
      detail: expect.stringContaining("ana was removed from Allowed people"),
    });
    // Once archived there is nothing left to do with it.
    expect(routineStatusView({ ...revoked, routine: { ...revoked.routine, status: "archived" } }).archive).toBe(false);
  });

  it("offers the fix with the notice, and checks readiness on its own only when something blocks the routine", () => {
    const blocked = routineStatusView(detail({ status: "credential-blocked", activeRevision: 1 }, { status: "passed" }));
    expect(blocked.notice?.action).toEqual({ kind: "link", label: "Open credentials", href: settingsPath("credentials") });
    expect(blocked.checkReadiness).toBe(true);
    const failing = routineStatusView(detail({ status: "paused-failures", activeRevision: 1 }, { status: "passed" }));
    expect(failing.notice?.action).toEqual({ kind: "readiness", label: "Check readiness" });
    expect(failing.checkReadiness).toBe(true);
    const active = routineStatusView(detail({ status: "active", activeRevision: 1 }, { status: "passed" }));
    expect(active.checkReadiness).toBe(false);
    expect(active.notice).toBeUndefined();
  });

  it("says a paused delivery target, with the way to resume it, when nothing else is wrong", () => {
    const view = routineStatusView(detail({ status: "active", activeRevision: 1 }, { status: "passed" }), "target-1");
    expect(view.notice).toMatchObject({
      tone: "warning",
      title: "Delivery is paused",
      action: { kind: "resume-delivery", label: "Resume delivery", targetId: "target-1" },
    });
    // A routine paused on research failures says that first.
    expect(
      routineStatusView(detail({ status: "paused-failures", activeRevision: 1 }, { status: "passed" }), "target-1").notice?.title,
    ).toBe("Paused after repeated failures");
  });

  it("says an evaluated routine no run has tried on its topic yet, with a preview, when nothing else is wrong", () => {
    const untried = { ...detail({ status: "active", activeRevision: 1 }, { status: "passed" }), topicNotice: "untried" };
    expect(routineStatusView(untried).notice).toMatchObject({
      tone: "info",
      title: "Not yet tried on its topic",
      detail: "untried",
      action: { kind: "preview", label: "Preview" },
    });
    // The owner's notice loses the lead-in the title already says.
    const owners =
      "Not yet tried on its own topic: its setup check measures the models on a fixed test set, not on this routine's objective. Preview it to see a report on its topic.";
    expect(routineStatusView({ ...untried, topicNotice: owners }).notice?.detail).toBe(
      "Its setup check measures the models on a fixed test set, not on this routine's objective. Preview it to see a report on its topic.",
    );
    // A paused delivery target says that first, and an unevaluated routine says it is evaluating.
    expect(routineStatusView(untried, "target-1").notice?.title).toBe("Delivery is paused");
    expect(routineStatusView({ ...detail({ status: "evaluating" }), topicNotice: "untried" }).notice?.title).toBe("Evaluating");
    expect(routineStatusView(detail({ status: "active", activeRevision: 1 }, { status: "passed" })).notice).toBeUndefined();
  });

  it("says a setup check in plain words, the scorer's measurements apart, and any other detail as it came", () => {
    const measured =
      "Quality passed against corpus v2/9330254964c1 scorer v1: research precision 0.92 recall 1.00 over 12 item(s); synthesis precision 1.00 recall 1.00 over 4 item(s); 36 model call(s), 83368 token(s) reserved.";
    expect(evaluationWords({ status: "passed", detail: measured })).toEqual({
      summary: "Passed its setup check on a fixed test set.",
      measured,
    });
    const incomplete = measured.replace("Quality passed", "Quality incomplete").concat(" Incomplete: the model budget ran out.");
    expect(evaluationWords({ status: "failed", detail: incomplete }).summary).toBe(
      "Did not pass its setup check on a fixed test set. Incomplete: the model budget ran out.",
    );
    expect(evaluationWords({ status: "failed", detail: "Prior revision remains active" })).toEqual({
      summary: "Prior revision remains active",
    });
  });

  it("reads a paused target from the stored delivery health: past its failure threshold, or its credential grace", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    const execution = { failureThreshold: 3, credentialGraceHours: 72 };
    const health = (deliveryHealth: unknown) => ({ data: { deliveryHealth } });
    expect(pausedDeliveryTarget(health({ t: { failures: 2, blockedSince: null, notified: false } }), execution, now)).toBeUndefined();
    expect(pausedDeliveryTarget(health({ t: { failures: 3, blockedSince: null, notified: true } }), execution, now)).toBe("t");
    expect(
      pausedDeliveryTarget(health({ t: { failures: 2, blockedSince: null, notified: false } }), { ...execution, failureThreshold: 2 }, now),
    ).toBe("t");
    expect(
      pausedDeliveryTarget(health({ t: { failures: 0, blockedSince: "2026-10-27T12:00:00.000Z", notified: false } }), execution, now),
    ).toBe(undefined);
    expect(
      pausedDeliveryTarget(health({ t: { failures: 0, blockedSince: "2026-10-25T11:00:00.000Z", notified: false } }), execution, now),
    ).toBe("t");
    expect(pausedDeliveryTarget(null, execution, now)).toBeUndefined();
  });
});

describe("a routine's status, in Bulgarian", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("puts the owner's reason first, then what to do about it", async () => {
    await setLocale("bg");
    const failedFirst = routineStatusView(detail({ status: "draft" }, { status: "failed", detail: "Оценката прекъсна." }));
    expect(failedFirst.notice?.detail).toBe("Оценката прекъсна. Оцени я отново или редактирай рутината, за да запазиш нова версия.");
    const noReason = routineStatusView(detail({ status: "draft" }, { status: "failed" }));
    expect(noReason.notice?.detail).toMatch(/^Версията не мина оценката си\. Оцени я отново/);
  });
});
