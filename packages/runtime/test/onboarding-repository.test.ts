import Database from "better-sqlite3";
import {
  ONBOARDING_DISMISSED_KINDS_META_KEY,
  ONBOARDING_EVENTS_MAX,
  onboardingFirstRun,
  verificationMatches,
  type OnboardingVerification,
} from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../src/persistence/migrations.js";
import { SqliteOnboardingRepository } from "../src/persistence/onboarding-repository.js";
import { SqliteStore } from "../src/persistence/store.js";

/** Onboarding's store: the install row, step marks, verifications and seeding. */

const NOW = "2026-10-20T09:00:00.000Z";
const LATER = "2026-10-20T10:00:00.000Z";
const REVISION = "a".repeat(64);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  return { store, onboarding: store.asPort().repositories.onboarding };
}

const modelVerification = (overrides: Partial<OnboardingVerification> = {}): OnboardingVerification => ({
  workspaceId: "default",
  subject: "model",
  role: "main",
  subjectId: "openrouter",
  model: "anthropic/claude-sonnet",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialRevision: REVISION,
  ok: true,
  toolsOk: true,
  at: NOW,
  ...overrides,
});

describe("the install row", () => {
  const fresh = () => {
    const db = new Database(":memory:");
    cleanup.push(() => db.close());
    runMigrations(db);
    return db;
  };

  it("starts a new store as a first run, with nothing seen yet", () => {
    expect(fresh().prepare("SELECT completed_at, first_seen_at FROM tavi_onboarding").all()).toEqual([
      { completed_at: null, first_seen_at: null },
    ]);
  });

  it("keeps one install row", () => {
    expect(() => fresh().prepare("INSERT INTO tavi_onboarding (id) VALUES (2)").run()).toThrow(/CHECK/);
  });
});

describe("onboarding repository", () => {
  it("answers firstRun from the install and whether a model connection exists", () => {
    const { onboarding } = fixture();
    const install = onboarding.install();
    expect(install).toEqual({ providerId: null });
    expect(onboardingFirstRun(install, false)).toBe(true);
    expect(onboardingFirstRun(install, true)).toBe(false);
    expect(onboardingFirstRun(onboarding.dismiss(1, NOW), false)).toBe(false);
    expect(onboardingFirstRun({ ...install, completedAt: NOW }, false)).toBe(false);
  });

  it("keeps the first-seen and completed times, and records the provider and flow version", () => {
    const { onboarding } = fixture();
    expect(onboarding.noteSeen(NOW).firstSeenAt).toBe(NOW);
    expect(onboarding.noteSeen(LATER).firstSeenAt).toBe(NOW);
    expect(onboarding.complete(NOW).completedAt).toBe(NOW);
    expect(onboarding.complete(LATER).completedAt).toBe(NOW);
    expect(onboarding.setProvider("acme.onboarding").providerId).toBe("acme.onboarding");
    expect(onboarding.setProvider(null).providerId).toBeNull();
    expect(onboarding.setFlowVersion(3).flowVersion).toBe(3);
    expect(onboarding.dismiss(3, LATER)).toMatchObject({ dismissedAt: LATER, dismissedFlowVersion: 3 });
  });

  it("keeps the flow's step kinds with a dismissal, replaces them on the next, and forgets them on reset", () => {
    const { onboarding } = fixture();
    expect(onboarding.dismiss(1, NOW, ["model", "about", "about"]).dismissedStepKinds).toEqual(["model", "about"]);
    expect(onboarding.dismiss(2, LATER, ["model", "about", "search"])).toMatchObject({
      dismissedFlowVersion: 2,
      dismissedStepKinds: ["model", "about", "search"],
    });
    // No kinds, or a row that cannot be read, is none kept: never every open step.
    expect(onboarding.dismiss(3, LATER).dismissedStepKinds).toBeUndefined();
    const db = new Database(":memory:");
    cleanup.push(() => db.close());
    runMigrations(db);
    const raw = new SqliteOnboardingRepository(
      () => db,
      (work) => db.transaction(work)(),
    );
    raw.dismiss(4, LATER, ["model"]);
    db.prepare("UPDATE tavi_meta SET value = 'not json' WHERE key = ?").run(ONBOARDING_DISMISSED_KINDS_META_KEY);
    expect(raw.install()).toMatchObject({ dismissedFlowVersion: 4 });
    expect(raw.install().dismissedStepKinds).toBeUndefined();
    onboarding.reset("default", LATER);
    expect(onboarding.install().dismissedStepKinds).toBeUndefined();
    expect(onboarding.install().dismissedAt).toBeUndefined();
  });

  it("counts the funnel by step, a visit's reached once, and the last failure's code", () => {
    const { onboarding } = fixture();
    const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
    onboarding.recordEvent({ workspaceId: "default", kind: "model", event: "reached", now: at(0) });
    onboarding.recordEvent({ workspaceId: "default", kind: "model", event: "reached", now: at(2) });
    onboarding.recordEvent({ workspaceId: "default", kind: "model", event: "reached", now: at(10) });
    onboarding.recordEvent({ workspaceId: "default", kind: "model", event: "failed", errorCode: "auth", now: at(11) });
    onboarding.recordEvent({ workspaceId: "default", kind: "model", event: "failed", errorCode: "timeout", now: at(12) });
    onboarding.recordEvent({ workspaceId: "default", kind: "channels", event: "skipped", now: at(13) });
    onboarding.recordEvent({ workspaceId: "other", kind: "about", event: "skipped", now: at(13) });
    expect(onboarding.funnel("default")).toEqual({
      model: { reached: 2, skipped: 0, failed: 2, lastError: "timeout" },
      channels: { reached: 0, skipped: 1, failed: 0 },
    });
    onboarding.reset("default", at(20));
    expect(onboarding.funnel("default")).toEqual({});
    expect(onboarding.funnel("other")).toEqual({ about: { reached: 0, skipped: 1, failed: 0 } });
  });

  it("keeps at most ONBOARDING_EVENTS_MAX funnel rows, the oldest pruned", () => {
    const { onboarding } = fixture();
    for (let index = 0; index < ONBOARDING_EVENTS_MAX + 20; index += 1)
      onboarding.recordEvent({ workspaceId: "default", kind: "about", event: "skipped", now: NOW });
    expect(onboarding.funnel("default").about?.skipped).toBe(ONBOARDING_EVENTS_MAX);
  });

  it("skips and restores a step, per workspace", () => {
    const { onboarding } = fixture();
    expect(onboarding.setStep({ workspaceId: "default", kind: "channels", mark: "skipped", now: NOW })).toEqual({
      workspaceId: "default",
      kind: "channels",
      mark: "skipped",
      at: NOW,
    });
    expect(onboarding.steps("other")).toEqual([]);
    expect(onboarding.restoreStep("default", "channels", LATER)).toBeUndefined();
    expect(onboarding.steps("default")).toEqual([]);
  });

  it("keeps what the flow created across every change of mark, and a restore keeps the row that holds it", () => {
    const { onboarding } = fixture();
    expect(onboarding.recordCreated({ workspaceId: "default", kind: "model", createdRef: "openrouter", now: NOW })).toEqual({
      workspaceId: "default",
      kind: "model",
      createdRef: "openrouter",
      at: NOW,
    });
    expect(onboarding.setStep({ workspaceId: "default", kind: "model", mark: "skipped", now: LATER })).toEqual({
      workspaceId: "default",
      kind: "model",
      mark: "skipped",
      createdRef: "openrouter",
      at: LATER,
    });
    expect(onboarding.restoreStep("default", "model", LATER)).toEqual({
      workspaceId: "default",
      kind: "model",
      createdRef: "openrouter",
      at: LATER,
    });
    expect(onboarding.setStep({ workspaceId: "default", kind: "model", mark: "completed", now: LATER })).toMatchObject({
      mark: "completed",
      createdRef: "openrouter",
    });
    // A restore undoes only a skip.
    expect(onboarding.restoreStep("default", "model", LATER)).toMatchObject({ mark: "completed" });
    expect(onboarding.recordCreated({ workspaceId: "default", kind: "model", createdRef: "openrouter-2", now: LATER })).toMatchObject({
      mark: "completed",
      createdRef: "openrouter-2",
    });
  });

  it("resets skips, seen marks and the dismissal, and keeps everything else", () => {
    const { onboarding } = fixture();
    onboarding.setProvider("acme.onboarding");
    onboarding.noteSeen(NOW);
    onboarding.dismiss(2, NOW);
    onboarding.setStep({ workspaceId: "default", kind: "channels", mark: "skipped", now: NOW });
    onboarding.setStep({ workspaceId: "default", kind: "ideas", mark: "seen", now: NOW });
    onboarding.setStep({ workspaceId: "default", kind: "about", mark: "completed", now: NOW });
    onboarding.setStep({ workspaceId: "default", kind: "service", mark: "self-managed", now: NOW });
    onboarding.recordCreated({ workspaceId: "default", kind: "model", createdRef: "openrouter", now: NOW });
    onboarding.setStep({ workspaceId: "default", kind: "model", mark: "skipped", now: NOW });
    onboarding.setStep({ workspaceId: "other", kind: "channels", mark: "skipped", now: NOW });
    onboarding.recordVerification(modelVerification());

    expect(onboarding.reset("default", LATER)).toBe(3);
    expect(onboarding.steps("default")).toEqual([
      { workspaceId: "default", kind: "about", mark: "completed", at: NOW },
      { workspaceId: "default", kind: "model", createdRef: "openrouter", at: LATER },
      { workspaceId: "default", kind: "service", mark: "self-managed", at: NOW },
    ]);
    expect(onboarding.steps("other")).toHaveLength(1);
    expect(onboarding.install()).toEqual({ providerId: "acme.onboarding", firstSeenAt: NOW });
    expect(onboarding.verifications("default")).toHaveLength(1);
  });

  it("keeps the latest verification per subject, and tells model from search", () => {
    const { onboarding } = fixture();
    onboarding.recordVerification(modelVerification());
    onboarding.recordVerification(modelVerification({ role: "fast", model: "anthropic/claude-haiku" }));
    onboarding.recordVerification(modelVerification({ ok: false, toolsOk: undefined, errorCode: "auth", at: LATER }));
    onboarding.recordVerification({ workspaceId: "default", subject: "search", subjectId: "brave", ok: true, at: NOW });
    onboarding.recordVerification({
      workspaceId: "default",
      subject: "search",
      subjectId: "brave",
      ok: false,
      errorCode: "auth",
      at: LATER,
    });
    onboarding.recordVerification(modelVerification({ workspaceId: "other" }));

    expect(onboarding.verifications("default", "model")).toEqual(
      [
        modelVerification({ ok: false, toolsOk: undefined, errorCode: "auth", at: LATER }),
        modelVerification({ role: "fast", model: "anthropic/claude-haiku" }),
      ].map(({ toolsOk, ...rest }) => (toolsOk === undefined ? rest : { ...rest, toolsOk })),
    );
    expect(onboarding.verifications("default", "search")).toEqual([
      { workspaceId: "default", subject: "search", subjectId: "brave", ok: false, errorCode: "auth", at: LATER },
    ]);
    expect(onboarding.verifications("other")).toHaveLength(1);
    expect(() => onboarding.recordVerification({ workspaceId: "default", subject: "model", subjectId: "x", ok: true, at: NOW })).toThrow(
      /role/,
    );
  });

  it("matches a verification only to the live connection, model, endpoint and credential revision", () => {
    const verification = modelVerification();
    const live = {
      connectionId: "openrouter",
      model: "anthropic/claude-sonnet",
      baseUrl: "https://OpenRouter.ai/api/v1/",
      credentialRevision: REVISION,
    };
    expect(verificationMatches(verification, live)).toBe(true);
    expect(verificationMatches(verification, { ...live, model: "openai/gpt-5" })).toBe(false);
    expect(verificationMatches(verification, { ...live, baseUrl: "https://example.com/v1" })).toBe(false);
    // A key rotated in place keeps its ref but changes its revision.
    expect(verificationMatches(verification, { ...live, credentialRevision: "b".repeat(64) })).toBe(false);
    expect(verificationMatches(verification, { ...live, connectionId: "openrouter-2" })).toBe(false);
  });
});
