// @vitest-environment jsdom
import type { AgentTreeNode, AgentTreeResult, TranscriptEntry } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTree } from "../../../src/features/workers/AgentTree.js";
import { WorkerTranscript } from "../../../src/features/workers/WorkerView.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, settle, unmountAll } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The agent tree and a worker's view-only transcript in Bulgarian. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const at = "2026-09-20T00:00:00.000Z";
const node = (taskId: string, status = "completed"): AgentTreeNode => ({
  taskId,
  parentTaskId: "root",
  status,
  depth: 1,
  createdAt: at,
  updatedAt: at,
});
const tree: AgentTreeResult = {
  workspaceId: "default",
  taskId: "root",
  nodes: [{ ...node("root", "running"), depth: 0, parentTaskId: undefined }, node("child", "running")],
  ancestors: ["ancestor"],
  truncated: false,
  ancestryUnknown: false,
};
const saved: TranscriptEntry = {
  taskId: "w1",
  seq: 1,
  turn: {
    admissionKind: "start",
    prompt: "Find flights",
    items: [{ kind: "text", text: "Found two." }],
    outcome: { status: "completed", finalText: "Found two." },
  },
  createdAt: "2026-10-04T00:00:00.000Z",
};

describe("workers in Bulgarian", () => {
  it("labels the tree and offers to stop a running child", async () => {
    const page = await mount(
      <InWorkspace timeZone="UTC" workspaceId="default" client={{ request: async () => ({ ok: true, result: tree }) as never }}>
        <AgentTree taskId="root" version="1" onOpen={async () => {}} onOpenWorker={() => undefined} />
      </InWorkspace>,
    );
    await settle();
    const labels = [...page.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label"));
    expect(labels).toContain("йерархия на помощниците");
    expect(page.textContent).toContain("Спри child");
    for (const word of ["Cancel child", "agent hierarchy", "Loading tree…", "Completed ("]) expect(page.textContent).not.toContain(word);
    expect(labels).not.toContain("agent hierarchy");
  });

  it("titles a worker's transcript as view only and pages back in Bulgarian", async () => {
    const request = async () => ({ ok: true, result: { entries: [saved], nextBefore: 1 } }) as never;
    const page = await mount(
      <InWorkspace workspaceId="default">
        <WorkerTranscript
          client={{ request }}
          worker={{ taskId: "w1", label: "researcher", chatTaskId: "root" }}
          onClose={() => undefined}
        />
      </InWorkspace>,
    );
    await settle();
    expect(page.querySelector("h2")?.textContent).toBe("Помощник researcher — само за преглед");
    expect(page.textContent).toContain("Помощникът не е чат");
    expect(page.textContent).toContain("Зареди по-ранни ходове");
    for (const word of ["Worker researcher", "view only", "A worker is not a chat", "Load earlier turns", "Asked of"])
      expect(page.textContent).not.toContain(word);
  });
});
