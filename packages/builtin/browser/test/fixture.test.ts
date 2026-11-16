import {
  BROWSER_OBSERVATION_MAX_ELEMENTS,
  TaviError,
  dispatchBrowserAction,
  type ArtifactRepositoryPort,
  type ArtifactRecord,
  type BrowserAction,
  type BrowserPort,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureBrowser } from "./support/fixture.js";
import { createBrowserLiveSource } from "../src/live.js";

/**
 * `BrowserPort` fixture adapter and its `dispatchBrowserAction` gate.
 */

function fixtureArtifacts(): ArtifactRepositoryPort {
  const records = new Map<string, ArtifactRecord>();
  const bodies = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    async putArtifact(input) {
      const artifactId = `art-${(counter += 1)}`;
      const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
      const record: ArtifactRecord = {
        artifactId,
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        relativePath: `${input.workspaceId}/${artifactId}`,
        contentType: input.contentType,
        byteSize: bytes.byteLength,
        sha256: "fixture",
        reviewState: input.reviewState ?? "approved",
        reviewedBy: null,
        reviewedAt: null,
      };
      records.set(artifactId, record);
      bodies.set(artifactId, bytes);
      return record;
    },
    getArtifact: async (artifactId) => records.get(artifactId),
    readArtifactBody: async (artifactId) => bodies.get(artifactId),
    // No video previews in these fixtures (video retention's check).
    derivedPreviewExists: async () => false,
    listPendingReview: async (workspaceId, limit) =>
      [...records.values()].filter((record) => record.workspaceId === workspaceId && record.reviewState === "pending").slice(0, limit),
    async setReviewState(input) {
      const record = records.get(input.artifactId);
      if (record === undefined) {
        throw new TaviError("NOT_FOUND", `No artifact ${input.artifactId}`);
      }
      if (record.reviewState !== "pending") {
        throw new TaviError("CONFLICT", `Artifact ${input.artifactId} already has a terminal review state (${record.reviewState})`);
      }
      records.set(input.artifactId, {
        ...record,
        reviewState: input.reviewState,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
      });
    },
  };
}

describe("createFixtureBrowser", () => {
  it("creates a session, navigates to a scripted page, and observes its elements", async () => {
    const browser = createFixtureBrowser({ pages: { "https://example.com": [{ ref: "btn-1", role: "button", text: "Submit" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    expect(session.state).toBe("open");

    const observation = await browser.navigate(session.sessionId, "https://example.com");
    expect(observation.url).toBe("https://example.com");
    expect(observation.elements).toEqual([{ ref: "btn-1", role: "button", text: "Submit" }]);
    expect(observation.epoch).toBe(1);
  });

  it("compacts a scripted page as a real scan is: an element it drops is not offered", async () => {
    const browser = createFixtureBrowser({
      pages: {
        "/": [
          { ref: "el-0" },
          { ref: "el-1", text: "Story", href: "https://news.example/story" },
          { ref: "el-2", href: "https://news.example/story" },
        ],
      },
    });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    expect(observation.elements).toEqual([{ ref: "el-1", text: "Story", href: "https://news.example/story" }]);
    await expect(browser.act({ sessionId: session.sessionId, ref: "el-2", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /Unknown element reference/,
    );
  });

  it("says how many elements of a scripted page it left out", async () => {
    const buttons = Array.from({ length: BROWSER_OBSERVATION_MAX_ELEMENTS + 3 }, (_, index) => ({
      ref: `el-${index}`,
      role: "button",
      text: `btn-${index}`,
    }));
    const browser = createFixtureBrowser({ pages: { "/": buttons } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    expect(observation.elements).toHaveLength(BROWSER_OBSERVATION_MAX_ELEMENTS);
    expect(observation.elementsOmitted).toBe(3);
  });

  it("navigating to an unscripted URL succeeds with an empty page, not an error", async () => {
    const browser = createFixtureBrowser();
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "https://unscripted.example");
    expect(observation.elements).toEqual([]);
  });

  it("act on a current-epoch, known ref succeeds", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    const outcome = await browser.act({ sessionId: session.sessionId, ref: "btn-1", epoch: observation.epoch, kind: "click" });
    expect(outcome.status).toBe("accepted");
  });

  it("accepts a page action with no element, and refuses an element action without one", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    await browser.navigate(session.sessionId, "/");
    expect(await browser.act({ sessionId: session.sessionId, kind: "scroll", value: "down" })).toEqual({ status: "accepted" });
    expect(await browser.act({ sessionId: session.sessionId, kind: "back", ref: "gone", epoch: 99 })).toEqual({ status: "accepted" });
    await expect(browser.act({ sessionId: session.sessionId, kind: "click" })).rejects.toThrow(/needs the ref/);
    await expect(browser.act({ sessionId: session.sessionId, kind: "press", value: "Enter", ref: "btn-1", epoch: 0 })).rejects.toThrow(
      /stale/,
    );
  });

  it("rejects a stale reference from a since-replaced observation (epoch mismatch)", async () => {
    const browser = createFixtureBrowser({ pages: { "/a": [{ ref: "btn-1", role: "button" }], "/b": [{ ref: "btn-2", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const first = await browser.navigate(session.sessionId, "/a");
    await browser.navigate(session.sessionId, "/b"); // replaces the observation, bumping epoch

    await expect(browser.act({ sessionId: session.sessionId, ref: "btn-1", epoch: first.epoch, kind: "click" })).rejects.toThrow(/stale/);
  });

  it("rejects a ref that was never observed, even at the current epoch", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    await expect(
      browser.act({ sessionId: session.sessionId, ref: "no-such-ref", epoch: observation.epoch, kind: "click" }),
    ).rejects.toThrow(/Unknown element reference/);
  });

  it("close then act reports the session unavailable, not silently successful", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    await browser.close(session.sessionId);
    await expect(browser.act({ sessionId: session.sessionId, ref: "btn-1", epoch: observation.epoch, kind: "click" })).rejects.toThrow(
      /closed/,
    );
  });

  it("capture publishes a bounded artifact reference, never inline bytes", async () => {
    const artifacts = fixtureArtifacts();
    const browser = createFixtureBrowser({ artifacts });
    const session = await browser.createSession({ workspaceId: "w1" });
    await browser.navigate(session.sessionId, "https://example.com");
    const result = await browser.capture(session.sessionId);
    expect(result.artifactId).toBeDefined();
    expect(await artifacts.getArtifact(result.artifactId)).toBeDefined();
  });

  it("capture creates the screenshot artifact pending review, mirroring the real adapter", async () => {
    const artifacts = fixtureArtifacts();
    const browser = createFixtureBrowser({ artifacts });
    const session = await browser.createSession({ workspaceId: "w1" });
    await browser.navigate(session.sessionId, "https://example.com");
    const result = await browser.capture(session.sessionId);
    expect((await artifacts.getArtifact(result.artifactId))?.reviewState).toBe("pending");
  });

  it("capture without a configured artifact store throws rather than silently dropping the screenshot", async () => {
    const browser = createFixtureBrowser();
    const session = await browser.createSession({ workspaceId: "w1" });
    await expect(browser.capture(session.sessionId)).rejects.toThrow(/artifact store/);
  });

  it("cancel is a safe no-op on an open session, and errors on an unknown one", async () => {
    const browser = createFixtureBrowser();
    const session = await browser.createSession({ workspaceId: "w1" });
    await expect(browser.cancel(session.sessionId)).resolves.toBeUndefined();
    await expect(browser.cancel("no-such-session")).rejects.toThrow(/No browser session/);
  });

  it("close is idempotent-safe to call once, and a second close still finds the (closed) session", async () => {
    const browser = createFixtureBrowser();
    const session = await browser.createSession({ workspaceId: "w1" });
    await browser.close(session.sessionId);
    await expect(browser.close(session.sessionId)).resolves.toBeUndefined();
  });
});

describe("dispatchBrowserAction", () => {
  it("dispatches a click through the browser and returns its outcome", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    const outcome = await dispatchBrowserAction(browser, {
      sessionId: session.sessionId,
      ref: "btn-1",
      epoch: observation.epoch,
      kind: "click",
    });
    expect(outcome.status).toBe("accepted");
  });

  it("dispatches a successful write action (submit) through unchanged", async () => {
    const browser = createFixtureBrowser({ pages: { "/": [{ ref: "form-1", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const observation = await browser.navigate(session.sessionId, "/");
    const outcome = await dispatchBrowserAction(browser, {
      sessionId: session.sessionId,
      ref: "form-1",
      epoch: observation.epoch,
      kind: "submit",
    });
    expect(outcome).toEqual({ status: "accepted" });
  });

  it("does not soften NOT_FOUND (unknown session) into uncertain, even for a write action", async () => {
    const browser = createFixtureBrowser();
    await expect(dispatchBrowserAction(browser, { sessionId: "no-such-session", ref: "x", epoch: 0, kind: "submit" })).rejects.toThrow(
      /No browser session/,
    );
  });

  it("reports a governed write (submit) as uncertain, not silently failed, when the session is lost mid-write", async () => {
    // A wrapper around the fixture whose `act` closes the session as a
    // side effect right before delegating — simulates "the browser
    // process died while this exact write was in flight," the real
    // mid-write scenario the acceptance criterion names, rather than a
    // session that was already closed before any write was attempted.
    const inner = createFixtureBrowser({ pages: { "/": [{ ref: "form-1", role: "button" }] } });
    const session = await inner.createSession({ workspaceId: "w1" });
    const observation = await inner.navigate(session.sessionId, "/");
    const lossy: BrowserPort = {
      ...inner,
      act: async (action: BrowserAction) => {
        await inner.close(session.sessionId);
        return inner.act(action);
      },
    };

    const outcome = await dispatchBrowserAction(lossy, {
      sessionId: session.sessionId,
      ref: "form-1",
      epoch: observation.epoch,
      kind: "submit",
    });
    expect(outcome).toEqual({ status: "uncertain", detail: expect.stringContaining("closed") });
  });

  it("does not soften a lost session into uncertain for a non-write action (click) — it propagates the raw error", async () => {
    const inner = createFixtureBrowser({ pages: { "/": [{ ref: "btn-1", role: "button" }] } });
    const session = await inner.createSession({ workspaceId: "w1" });
    const observation = await inner.navigate(session.sessionId, "/");
    const lossy: BrowserPort = {
      ...inner,
      act: async (action: BrowserAction) => {
        await inner.close(session.sessionId);
        return inner.act(action);
      },
    };

    await expect(
      dispatchBrowserAction(lossy, { sessionId: session.sessionId, ref: "btn-1", epoch: observation.epoch, kind: "click" }),
    ).rejects.toThrow(/closed/);
  });

  it("propagates a stale-reference rejection unchanged — never softened to uncertain", async () => {
    const browser = createFixtureBrowser({ pages: { "/a": [{ ref: "btn-1", role: "button" }], "/b": [{ ref: "btn-2", role: "button" }] } });
    const session = await browser.createSession({ workspaceId: "w1" });
    const first = await browser.navigate(session.sessionId, "/a");
    await browser.navigate(session.sessionId, "/b");

    await expect(
      dispatchBrowserAction(browser, { sessionId: session.sessionId, ref: "btn-1", epoch: first.epoch, kind: "submit" }),
    ).rejects.toThrow(/stale/);
  });
});

describe("handing a session to a person", () => {
  it("names a task's session by its live id, waking one kept from the last turn so a person can be asked to take it", async () => {
    const live = createBrowserLiveSource();
    const browser = createFixtureBrowser({ live });
    const session = await browser.createSession({ workspaceId: "w", taskId: "chat" });
    const untracked = await browser.createSession({ workspaceId: "w" });
    await browser.taskEnded?.("chat");
    expect(live.sessions({ workspaceId: "w", taskIds: ["chat"] })[0]?.state).toBe("inactive");
    expect(browser.handoffTarget?.(session.sessionId)).toEqual({ historyId: "fixture-live-1", taskId: "chat" });
    expect(live.sessions({ workspaceId: "w", taskIds: ["chat"] })[0]?.state).toBe("inactive");
    expect(browser.handoffTarget?.(session.sessionId, { wake: true })).toEqual({ historyId: "fixture-live-1", taskId: "chat" });
    expect(live.sessions({ workspaceId: "w", taskIds: ["chat"] })[0]?.state).toBe("open");
    live.requestHandoff("fixture-live-1");
    expect(live.controlState("fixture-live-1")).toBe("requested");
    // A session the live view never had, or one closed, cannot be handed over.
    expect(browser.handoffTarget?.(untracked.sessionId)).toBeUndefined();
    await browser.close(session.sessionId);
    expect(browser.handoffTarget?.(session.sessionId)).toBeUndefined();
  });
});
