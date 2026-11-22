// @vitest-environment jsdom
import type { RoutineDetail } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunInspector } from "../../../src/features/routines/RunInspector.js";
import { routineStatusView } from "../../../src/features/routines/status.js";
import { setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mount, settle, unmountAll } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Routines in Bulgarian: a routine's status notice, and a run's inspector. The run's headline and the routine's name are the owner's. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const detail = (status: string, evaluation: string): RoutineDetail =>
  ({
    routine: {
      routineId: "r",
      workspaceId: "default",
      principalId: "operator",
      name: "LLM news",
      version: 1,
      activeRevision: null,
      latestRevision: 1,
      status,
      conversationId: null,
      createdAt: "",
      updatedAt: "",
    },
    evaluation: { evaluationId: "e", routineId: "r", revision: 1, status: evaluation, detail: "", createdAt: "", finishedAt: null },
  }) as unknown as RoutineDetail;

describe("routines in Bulgarian", () => {
  it("say a routine's status in the language now chosen", async () => {
    const setup = routineStatusView(detail("setup-needed", "pending"));
    const failed = routineStatusView(detail("draft", "failed"));
    const bg = [setup.notice?.title, setup.notice?.action?.label, setup.runBlocked, failed.notice?.title];
    expect(bg).toEqual([
      "Нужна е настройка",
      "Провери готовността",
      "Ще е достъпно, след като рутината мине оценката си.",
      "Оценката не мина",
    ]);
    for (const text of bg)
      for (const word of ["Setup needed", "Check readiness", "Available once", "Evaluation failed"]) expect(text).not.toContain(word);

    await setLocale("en");
    expect(routineStatusView(detail("setup-needed", "pending")).notice?.title).toBe("Setup needed");
  });

  it("label a run's summary", async () => {
    const run = {
      runId: "run",
      routineId: "routine",
      revision: 1,
      mode: "production",
      status: "succeeded",
      claimedAt: "2026-10-01T10:00:00.000Z",
      startedAt: "2026-10-01T10:00:00.000Z",
      endedAt: "2026-10-01T10:05:00.000Z",
      snapshot: {},
      data: { modelCalls: 1, toolCalls: 0, tokensKnown: 1, usageComplete: true },
    };
    const publication = { reportArtifactId: "art", pdfArtifactId: null, pdfError: null, headline: "GPT-9 ships" };
    const client: SettingsClient = {
      request: async (_command, raw) => {
        const action = (raw as Record<string, unknown>)["action"];
        const result =
          action === "inspect"
            ? { run, publication, deliveries: [], attempts: [] }
            : action === "ledger"
              ? { events: [] }
              : action === "sources"
                ? { sources: [], nextAfterSourceId: null }
                : {};
        return { ok: true, result } as never;
      },
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <RunInspector timeZone="UTC" routineId="routine" routineName="LLM news" runId="run" onBack={() => {}} onFollow={async () => {}} />
      </InWorkspace>,
    );
    await settle();
    const labels = [...page.querySelectorAll(".summary-grid dt")].map((term) => term.textContent ?? "");
    expect(labels).toContain("Заглавие");
    expect(labels).toContain("Започнато");
    expect(page.textContent).toContain("Обобщение");
    expect(page.textContent).toContain("GPT-9 ships");
    for (const word of ["Headline", "Started", "Ended", "Duration", "Model calls", "Tool calls", "Known tokens", "Summary", "Cancel run"]) {
      expect(labels).not.toContain(word);
    }
    expect(page.textContent).not.toContain("Refresh run");
    expect(page.textContent).not.toContain("Summary");
  });
});
