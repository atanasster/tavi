import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ArtifactRecord,
  ArtifactRepositoryPort,
  BrowserPort,
  InvocationContext,
  ModelOutcome,
  ModelPort,
  ModelRequest,
} from "@tavi/contracts";
import { DEFAULT_BROWSER_DOWNLOAD_MAX_MIB, TaviError } from "@tavi/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assessBrowserAct } from "../../apps/cli/src/features/approvals/call-assessors.js";
import { runVisionLoop } from "../../apps/cli/src/features/browser/vision.js";
import { startMiniWebServer, type MiniWebServer } from "../../evals/browser/fixtures/server.js";
import { launchChromium } from "../../packages/builtin/browser/src/chromium.js";
import { createPlaywrightBrowser } from "../../packages/builtin/browser/src/playwright.js";

/**
 * Qualification of the browser adapter and call assessors against the local
 * mini-web fixture server. Each scenario exercises a deterministic local page
 * and checks server-recorded state (`miniWeb.state`) or the adapter's returned
 * observation/outcome.
 */

function createFixtureArtifacts(): ArtifactRepositoryPort {
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
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      };
      records.set(artifactId, record);
      bodies.set(artifactId, bytes);
      return record;
    },
    getArtifact: async (artifactId) => records.get(artifactId),
    readArtifactBody: async (artifactId) => bodies.get(artifactId),
    derivedPreviewExists: async () => false,
    listPendingReview: async (workspaceId, limit) =>
      [...records.values()].filter((record) => record.workspaceId === workspaceId && record.reviewState === "pending").slice(0, limit),
    async setReviewState(input) {
      const record = records.get(input.artifactId);
      if (record === undefined) throw new TaviError("NOT_FOUND", `No artifact ${input.artifactId}`);
      records.set(input.artifactId, {
        ...record,
        reviewState: input.reviewState,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
      });
    },
  };
}

function expectDefined<T>(value: T | undefined, label: string): T {
  expect(value, `Expected ${label} to be defined`).toBeDefined();
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

/** The workspace whose downloads are capped at 1 MiB. */
const CAPPED_WORKSPACE = "ws-miniweb-capped";

// Each case drives real Chromium through several guarded actions: well past the default 5 s on a loaded machine.
describe("browser mini-web qualification suite", { timeout: 30_000 }, () => {
  let chromiumAvailable = false;
  let miniWeb: MiniWebServer;
  let browser: BrowserPort;
  let artifacts: ArtifactRepositoryPort;
  let stagingDirectory: string | undefined;

  beforeAll(async () => {
    miniWeb = await startMiniWebServer();
    try {
      const probe = await launchChromium({ headless: true });
      await probe.close();
      chromiumAvailable = true;
    } catch {
      chromiumAvailable = false;
      return;
    }
    stagingDirectory = await mkdtemp(join(tmpdir(), "tavi-miniweb-"));
    artifacts = createFixtureArtifacts();
    // One workspace downloads under a 1 MiB cap, so a streamed file can pass it without sending hundreds of MiB.
    browser = createPlaywrightBrowser({
      stagingDirectory,
      artifacts,
      downloadMaxMiB: (workspaceId) => (workspaceId === CAPPED_WORKSPACE ? 1 : DEFAULT_BROWSER_DOWNLOAD_MAX_MIB),
    });
  }, 60_000);

  beforeEach(() => {
    miniWeb?.reset();
  });

  afterAll(async () => {
    await browser?.dispose?.();
    await miniWeb?.close();
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("drives a two-page form up to its gated final checkout step", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs1 = await browser.navigate(sessionId, `${miniWeb.origin}/wizard/step1`);
      const recipient = expectDefined(
        obs1.elements.find((el) => el.text?.includes("Recipient")),
        "Recipient field",
      );
      const city = expectDefined(
        obs1.elements.find((el) => el.text?.includes("City")),
        "City field",
      );
      const cont = expectDefined(
        obs1.elements.find((el) => el.text === "Continue to review"),
        "Continue button",
      );

      await browser.act({ sessionId, kind: "type", ref: recipient.ref, epoch: obs1.epoch, value: "Ada Lovelace" });
      await browser.act({ sessionId, kind: "type", ref: city.ref, epoch: obs1.epoch, value: "London" });
      await browser.act({ sessionId, kind: "click", ref: cont.ref, epoch: obs1.epoch });

      const obs2 = await browser.observe(sessionId);
      expect(obs2.url).toBe(`${miniWeb.origin}/wizard/checkout`);
      expect(miniWeb.state.twoStep.step1).toEqual({ recipient: "Ada Lovelace", city: "London" });

      const placeOrder = expectDefined(
        obs2.elements.find((el) => el.text === "Place order"),
        "Place order button",
      );
      const assessment = assessBrowserAct(
        { sessionId, kind: "click", ref: placeOrder.ref, epoch: obs2.epoch },
        { role: placeOrder.role, text: placeOrder.text, submitsForm: placeOrder.submitsForm, finalStep: true },
        undefined,
        obs2.url,
      );
      expect(assessment.hardDeny).toMatch(/last step/);
      expect(miniWeb.state.twoStep.finalSubmitted).toBe(false);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("re-verifies an element's identity when an SPA prepends a sibling node or calls pushState", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/spa`);
      const alpha = expectDefined(
        obs.elements.find((el) => el.text === "Alpha"),
        "Alpha button",
      );
      const prepend = expectDefined(
        obs.elements.find((el) => el.text === "Insert Above"),
        "Insert Above button",
      );
      const pushRoute = expectDefined(
        obs.elements.find((el) => el.text === "Navigate Client Route"),
        "Navigate Client Route button",
      );

      await browser.act({ sessionId, kind: "click", ref: prepend.ref, epoch: obs.epoch });
      const clickedAlpha = await browser.act({ sessionId, kind: "click", ref: alpha.ref, epoch: obs.epoch });
      expect(clickedAlpha.changes).toContain(`${alpha.ref} moved; acted on it by its label`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(miniWeb.state.spaClicked).toEqual(["Alpha"]);

      await browser.act({ sessionId, kind: "click", ref: pushRoute.ref, epoch: obs.epoch });
      await expect(browser.act({ sessionId, kind: "click", ref: alpha.ref, epoch: obs.epoch })).rejects.toThrow(/stale/);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("preserves distinct repeated Select controls across table rows with row context", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/rows`);
      expect(obs.elements.find((el) => el.role === "heading" && el.text === "Available Fares")).toBeDefined();
      const selects = obs.elements.filter((el) => el.role === "button" && el.text === "Select");
      expect(selects.length).toBe(3);
      expect(selects.map((el) => el.context)).toEqual(["Fare 1 · Morning · $120", "Fare 2 · Midday · $210", "Fare 3 · Evening · $300"]);
      await browser.act({ sessionId, kind: "click", ref: selects[2]?.ref ?? "", epoch: obs.epoch });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(miniWeb.state.chosenRow).toBe("fare-3");
    } finally {
      await browser.close(sessionId);
    }
  });

  it("surfaces elements inside same-origin and cross-origin iframes", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/frames`);
      const saveButtons = obs.elements.filter((el) => el.text === "Save Note");
      expect(saveButtons.length).toBe(2);
      expect(saveButtons[0]?.ref).toMatch(/^f1:el-\d+$/);
      expect(saveButtons[0]?.frame).toBe(miniWeb.origin);
      expect(saveButtons[1]?.ref).toMatch(/^f2:el-\d+$/);
      expect(saveButtons[1]?.frame).toBe(miniWeb.crossOrigin);

      const pageRead = await browser.read(sessionId);
      expect(pageRead.text).toContain(`## Frame f1 (${miniWeb.origin})`);
      expect(pageRead.text).toContain(`## Frame f2 (${miniWeb.crossOrigin})`);
      expect(pageRead.text).toContain("Frame (cross)");

      const crossNote = expectDefined(
        obs.elements.find((el) => el.frame === miniWeb.crossOrigin && el.text === "Note (cross)"),
        "cross-origin note field",
      );
      const crossSave = expectDefined(saveButtons[1], "cross-origin Save Note button");
      await browser.act({
        sessionId,
        kind: "type",
        ref: crossNote.ref,
        epoch: obs.epoch,
        value: "cross-frame-value",
      });
      await browser.act({
        sessionId,
        kind: "click",
        ref: crossSave.ref,
        epoch: obs.epoch,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(miniWeb.state.frameInputs.crossOrigin).toBe("cross-frame-value");

      const crossGender = expectDefined(
        obs.elements.find((el) => el.frame === miniWeb.crossOrigin && el.text === "Gender"),
        "cross-origin protected Gender field",
      );
      await expect(
        browser.act({
          sessionId,
          kind: "type",
          ref: crossGender.ref,
          epoch: obs.epoch,
          value: "Female",
        }),
      ).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
        details: { protected: "demographic" },
      });

      const crossPay = expectDefined(
        obs.elements.find((el) => el.frame === miniWeb.crossOrigin && el.text === "Pay"),
        "cross-origin Pay button",
      );
      const payAssessment = assessBrowserAct(
        { sessionId, kind: "click", ref: crossPay.ref, epoch: obs.epoch },
        { role: crossPay.role, text: crossPay.text, frame: crossPay.frame },
        undefined,
        obs.url,
      );
      expect(payAssessment.risk).toBe("high");
      expect(payAssessment.subjects).toContain("submit");
      expect(payAssessment.display.host).toBe(miniWeb.crossHost);

      await expect(
        browser.act({
          sessionId,
          kind: "click",
          ref: crossPay.ref,
          epoch: obs.epoch,
          guard: { commitApproved: false },
        }),
      ).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
        details: { guard: "commit" },
      });
      expect(miniWeb.state.frameInputs.paid).toEqual([]);
    } finally {
      await browser.close(sessionId);
    }

    const restrictedBrowser = createPlaywrightBrowser({
      stagingDirectory: stagingDirectory ?? "",
      artifacts: createFixtureArtifacts(),
      isFrameHostAllowed: (frameOrigin) => frameOrigin === miniWeb.origin,
    });
    try {
      const { sessionId: restrictedId } = await restrictedBrowser.createSession({ workspaceId: "ws-miniweb" });
      try {
        const restrictedObs = await restrictedBrowser.navigate(restrictedId, `${miniWeb.origin}/frames`);
        const crossFrameEntry = restrictedObs.elements.find((el) => el.ref === "f2:frame");
        expect(crossFrameEntry).toEqual({
          ref: "f2:frame",
          frame: `${miniWeb.crossHost} (not allowed)`,
        });
        expect(restrictedObs.elements.some((el) => el.ref.startsWith("f2:el-"))).toBe(false);
        const restrictedRead = await restrictedBrowser.read(restrictedId);
        expect(restrictedRead.text).toContain(`## Frame f1 (${miniWeb.origin})`);
        expect(restrictedRead.text).not.toContain(`## Frame f2`);
        // A frame inside the refused one (its own srcdoc) is refused with it.
        expect(restrictedRead.text).not.toContain("Nested widget text");
        expect(restrictedObs.elements.some((el) => el.ref.startsWith("f3:el-"))).toBe(false);
      } finally {
        await restrictedBrowser.close(restrictedId);
      }
    } finally {
      await restrictedBrowser.dispose?.();
    }
  });

  it("never pictures a page whose cross-site frame holds a card number", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/frames`);
      await expect(browser.capture(sessionId, { forModel: true })).resolves.toBeDefined();
      const demoCard = expectDefined(
        obs.elements.find((el) => el.frame === miniWeb.crossOrigin && el.text === "Use demo card"),
        "cross-site demo card button",
      );
      await browser.act({ sessionId, kind: "click", ref: demoCard.ref, epoch: obs.epoch });
      await expect(browser.capture(sessionId, { forModel: true })).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
        message: expect.stringMatching(/a secret field holds a value/),
      });
    } finally {
      await browser.close(sessionId);
    }
  });

  it("governs multilingual and icon-only submit buttons while keeping search-form Enter inert", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/submits`);
      const postBtn = expectDefined(
        obs.elements.find((el) => el.text === "Post"),
        "Post button",
      );
      const weiterBtn = expectDefined(
        obs.elements.find((el) => el.text === "Weiter"),
        "Weiter button",
      );
      const comprarBtn = expectDefined(
        obs.elements.find((el) => el.text === "Comprar"),
        "Comprar button",
      );
      const authBtn = expectDefined(
        obs.elements.find((el) => el.text === "Authorize"),
        "Authorize button",
      );
      const iconBtn = expectDefined(
        obs.elements.find((el) => el.role === "button" && el.text === undefined && el.submitsForm === true),
        "Icon-only submit button",
      );
      const destInput = expectDefined(
        obs.elements.find((el) => el.text === "Destination"),
        "Destination search input",
      );
      expect(destInput.searchForm).toBe(true);
      expect(destInput.inForm).toBeUndefined();
      // A checkout form's combobox: Enter in it submits the checkout.
      const country = expectDefined(
        obs.elements.find((el) => el.role === "combobox" && el.text === "Country"),
        "Country select",
      );
      expect(country.inForm).toBe(true);
      expect(country.searchForm).toBeUndefined();

      for (const btn of [postBtn, weiterBtn, comprarBtn, authBtn, iconBtn]) {
        const assessed = assessBrowserAct(
          { sessionId, kind: "click", ref: btn.ref, epoch: obs.epoch },
          { role: btn.role, text: btn.text, submitsForm: btn.submitsForm, searchForm: btn.searchForm },
          undefined,
          obs.url,
        );
        expect(assessed.risk).toBe("high");
        expect(assessed.subjects).toContain("submit");
      }

      const searchEnter = assessBrowserAct(
        { sessionId, kind: "press", ref: destInput.ref, epoch: obs.epoch, value: "Enter" },
        { role: destInput.role, text: destInput.text, searchForm: destInput.searchForm },
        undefined,
        obs.url,
      );
      expect(searchEnter.risk).toBe("medium");
      expect(searchEnter.subjects).toEqual(["press"]);
      expect(searchEnter.browserSteps).toEqual([{ kind: "inert" }]);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("re-checks a click by sight on a search form's button that turned into a commit", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/submits/swap`);
      const trigger = expectDefined(
        obs.elements.find((el) => el.text === "Show prices"),
        "Show prices button",
      );
      await browser.act({ sessionId, kind: "click", ref: trigger.ref, epoch: obs.epoch });
      const pointer = expectDefined(browser.pointer?.bind(browser), "browser.pointer");
      // The button sits at a fixed spot; it now reads "Pay" inside a role=search form.
      await expect(pointer(sessionId, { kind: "click", x: 80, y: 220 }, { guard: { commitApproved: false } })).rejects.toThrow(/commits/);
      // Enter in the search field submits through the same button, now "Pay".
      const destination = expectDefined(
        obs.elements.find((el) => el.text === "Destination"),
        "Destination field",
      );
      await expect(
        browser.act({ sessionId, kind: "press", ref: destination.ref, epoch: obs.epoch, value: "Enter", guard: { commitApproved: false } }),
      ).rejects.toThrow(/commits/);
      expect(miniWeb.state.submissions.some((submission) => submission.kind === "swap")).toBe(false);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("auto-dismisses confirm and prompt dialogs on the agent path and reports dialog details", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/dialogs`);
      const alertBtn = expectDefined(
        obs.elements.find((el) => el.text === "Trigger Alert"),
        "Trigger Alert button",
      );
      const confirmBtn = expectDefined(
        obs.elements.find((el) => el.text === "Delete Item"),
        "Delete Item button",
      );
      const promptBtn = expectDefined(
        obs.elements.find((el) => el.text === "Rename Item"),
        "Rename Item button",
      );

      const alertOutcome = await browser.act({ sessionId, kind: "click", ref: alertBtn.ref, epoch: obs.epoch });
      expect(alertOutcome.dialog).toEqual({
        type: "alert",
        message: "Notice: session active",
        handled: "accepted",
      });

      const outcome = await browser.act({ sessionId, kind: "click", ref: confirmBtn.ref, epoch: obs.epoch });
      expect(outcome.dialog).toEqual({
        type: "confirm",
        message: "Permanently delete this record?",
        handled: "dismissed",
      });

      const promptOutcome = await browser.act({ sessionId, kind: "click", ref: promptBtn.ref, epoch: obs.epoch });
      expect(promptOutcome.dialog).toEqual({
        type: "prompt",
        message: "Enter new name:",
        handled: "dismissed",
      });

      const acceptedConfirm = await browser.act({
        sessionId,
        kind: "click",
        ref: confirmBtn.ref,
        epoch: obs.epoch,
        dialog: { accept: true },
      });
      expect(acceptedConfirm.dialog).toEqual({
        type: "confirm",
        message: "Permanently delete this record?",
        handled: "accepted",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(miniWeb.state.dialogs).toContainEqual({ kind: "alert", outcome: "accepted" });
      expect(miniWeb.state.dialogs).toContainEqual({ kind: "confirm", outcome: "dismissed" });
      expect(miniWeb.state.dialogs).toContainEqual({ kind: "prompt", outcome: "dismissed" });
      expect(miniWeb.state.dialogs).toContainEqual({ kind: "confirm", outcome: "accepted" });
    } finally {
      await browser.close(sessionId);
    }
  }, 15_000);

  it("draws Set-of-Marks where page script cannot reach the canvas", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      await browser.navigate(sessionId, `${miniWeb.origin}/tamper-canvas`);
      const plain = await browser.capture(sessionId, { forModel: true });
      const marked = await browser.capture(sessionId, { forModel: true, marks: true });
      const plainBytes = expectDefined(await artifacts.readArtifactBody(plain.artifactId), "plain capture");
      const markedBytes = expectDefined(await artifacts.readArtifactBody(marked.artifactId), "marked capture");
      // The page replaced the canvas encoder with one that answers "TAMPERED": the marked copy is a real JPEG, with marks on it.
      expect(Buffer.from(markedBytes).subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(Buffer.from(markedBytes).equals(Buffer.from(plainBytes))).toBe(false);
      expect(marked.marks?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("says when a popup closed by itself, and treats its refs as stale", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/self-closing`);
      const open = expectDefined(
        obs.elements.find((el) => el.text === "Open payment window"),
        "Open payment window button",
      );
      const opened = expectDefined((await browser.act({ sessionId, kind: "click", ref: open.ref, epoch: obs.epoch })).page, "popup page");
      expect(opened.url).toBe(`${miniWeb.origin}/closes-soon`);
      const wait = expectDefined(
        opened.elements.find((el) => el.text === "Wait"),
        "popup's button",
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(browser.act({ sessionId, kind: "click", ref: wait.ref, epoch: opened.epoch })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/is stale/),
      });
      const back = await browser.observe(sessionId);
      expect(back.url).toBe(`${miniWeb.origin}/self-closing`);
      expect(back.popupClosed).toBe(true);
      expect((await browser.observe(sessionId)).popupClosed).toBeUndefined();
    } finally {
      await browser.close(sessionId);
    }
  });

  it("answers a dialog the opener raises behind its popup, so the opener does not hang", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/background-dialog`);
      const open = expectDefined(
        obs.elements.find((el) => el.text === "Open helper"),
        "Open helper button",
      );
      await browser.act({ sessionId, kind: "click", ref: open.ref, epoch: obs.epoch });
      // The popup is the active tab before the opener's alert comes (1.5 s after the click).
      expect((await browser.observe(sessionId)).url).toBe(`${miniWeb.origin}/submits`);
      expect(miniWeb.state.dialogs.some((entry) => entry.kind === "background")).toBe(false);
      const deadline = Date.now() + 5_000;
      while (!miniWeb.state.dialogs.some((entry) => entry.kind === "background") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(miniWeb.state.dialogs).toContainEqual({ kind: "background", outcome: "answered" });
    } finally {
      await browser.close(sessionId);
    }
  });

  it("stays on a page that asks to keep its unsaved changes, and says so", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/dialogs`);
      // A page may ask before it is left only once a person (here, a click) has used it.
      const alertButton = expectDefined(
        obs.elements.find((el) => el.text === "Trigger Alert"),
        "Trigger Alert button",
      );
      await browser.act({ sessionId, kind: "click", ref: alertButton.ref, epoch: obs.epoch });
      await expect(browser.navigate(sessionId, `${miniWeb.origin}/submits`)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/unsaved changes/),
      });
      expect((await browser.observe(sessionId)).url).toBe(`${miniWeb.origin}/dialogs`);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("marks password and one-time-code fields as secret and refuses typing into them", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/secrets`);
      const passwordField = expectDefined(
        obs.elements.find((el) => el.text?.includes("Password")),
        "Password field",
      );
      const otpField = expectDefined(
        obs.elements.find((el) => el.text?.includes("Verification code")),
        "Verification code field",
      );
      expect(passwordField.secret).toBe(true);
      expect(otpField.secret).toBe(true);
      await expect(browser.act({ sessionId, kind: "type", ref: passwordField.ref, epoch: obs.epoch, value: "hunter2" })).rejects.toThrow(
        /password|secret|protected/i,
      );
      await expect(browser.act({ sessionId, kind: "type", ref: otpField.ref, epoch: obs.epoch, value: "123456" })).rejects.toThrow(
        /password|secret|protected/i,
      );
    } finally {
      await browser.close(sessionId);
    }
  });

  it("keeps the opener alive when an OAuth popup opens, postMessages, and closes, and supports results-page tab round-trips", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs1 = await browser.navigate(sessionId, `${miniWeb.origin}/oauth`);
      const openBtn = expectDefined(
        obs1.elements.find((el) => el.text === "Sign in with Provider"),
        "Sign in with Provider button",
      );

      const openedPopup = await browser.act({ sessionId, kind: "click", ref: openBtn.ref, epoch: obs1.epoch });
      expect(openedPopup.page?.tabs).toHaveLength(2);
      const popupObs = await browser.observe(sessionId);
      const allowBtn = expectDefined(
        popupObs.elements.find((el) => el.text === "Allow Access"),
        "Allow Access button",
      );

      const closedPopup = await browser.act({ sessionId, kind: "click", ref: allowBtn.ref, epoch: popupObs.epoch });
      expect(closedPopup.detail).toContain("the popup closed; returned to");
      expect(closedPopup.page?.url).toBe(`${miniWeb.origin}/oauth`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(miniWeb.state.oauthToken).toBe("oauth-token-77");

      // Results-page round trip: open Result One in a new tab, return via back (popup with no history), then open Result Two and switch tabs via kind: "tab"
      const resultsObs = await browser.navigate(sessionId, `${miniWeb.origin}/results`);
      const result1Link = expectDefined(
        resultsObs.elements.find((el) => el.text === "Result One"),
        "Result One link",
      );
      const opened1 = await browser.act({ sessionId, kind: "click", ref: result1Link.ref, epoch: resultsObs.epoch });
      expect(opened1.page?.url).toBe(`${miniWeb.origin}/results/item-1`);
      expect(opened1.page?.tabs).toEqual([
        { index: 0, url: `${miniWeb.origin}/results`, title: "MiniWeb" },
        { index: 1, url: `${miniWeb.origin}/results/item-1`, title: "MiniWeb", active: true },
      ]);

      const returnedViaBack = await browser.act({ sessionId, kind: "back" });
      expect(returnedViaBack.status).toBe("accepted");
      expect(returnedViaBack.page?.url).toBe(`${miniWeb.origin}/results`);

      const switchedToTab1 = await browser.act({ sessionId, kind: "tab", tab: 1 });
      expect(switchedToTab1.status).toBe("accepted");
      expect(switchedToTab1.page?.url).toBe(`${miniWeb.origin}/results/item-1`);

      const switchedToTab0 = await browser.act({ sessionId, kind: "tab", tab: 0 });
      expect(switchedToTab0.status).toBe("accepted");
      expect(switchedToTab0.page?.url).toBe(`${miniWeb.origin}/results`);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("fails within 10 seconds with a concise blocker reason when clicking a covered button", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/covered`);
      const underneath = expectDefined(
        obs.elements.find((el) => el.text === "Continue"),
        "Continue button",
      );

      const started = Date.now();
      let caught: unknown;
      try {
        await browser.act({ sessionId, kind: "click", ref: underneath.ref, epoch: obs.epoch });
      } catch (error) {
        caught = error;
      }
      const elapsed = Date.now() - started;
      expect(caught).toBeDefined();
      expect(elapsed).toBeLessThan(10_000);
      expect(String((caught as Error).message)).not.toContain("Call log:");
      expect(String((caught as Error).message)).toContain('covered by <dialog "Sign in">');
    } finally {
      await browser.close(sessionId);
    }
  }, 40_000);

  it("keeps no download a plain click starts, fetches it as a download, reads PDFs on navigation, and refuses an oversized download", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/downloads`);
      const clickBtn = expectDefined(
        obs.elements.find((el) => el.text === "Export CSV"),
        "Export CSV button",
      );
      // A click is asked about as a click: the file it starts is not kept, and the model is told to fetch it as a download.
      const clickDownload = await browser.act({ sessionId, kind: "click", ref: clickBtn.ref, epoch: obs.epoch });
      expect(clickDownload.status).toBe("rejected");
      expect(clickDownload.detail).toMatch(/kind: "download"/);
      expect(miniWeb.state.downloadsServed).toContain("report.csv");
      const fetched = await browser.act({ sessionId, kind: "download", ref: clickBtn.ref, epoch: obs.epoch });
      expect(fetched.detail).toMatch(/saved as artifact/);

      const large = expectDefined(
        obs.elements.find((el) => el.text === "Download Oversized Archive"),
        "Download Oversized Archive link",
      );

      await expect(browser.act({ sessionId, kind: "download", ref: large.ref, epoch: obs.epoch })).rejects.toThrow(
        /cap|limit|256|large|size/i,
      );

      const pdfObs = await browser.navigate(sessionId, `${miniWeb.origin}/files/statement.pdf`);
      expect(pdfObs.url).toBe(`${miniWeb.origin}/files/statement.pdf`);
      const pdfRead = await browser.read(sessionId);
      expect(pdfRead.text).toContain("Quarterly Statement: Paid $42.00");
    } finally {
      await browser.close(sessionId);
    }
  });

  it("refuses a download past the cap that never said its size, and keeps nothing of it", async (ctx) => {
    if (!miniWeb || !browser) return ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: CAPPED_WORKSPACE });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/downloads`);
      const streamed = expectDefined(
        obs.elements.find((el) => el.text === "Download Streamed Archive"),
        "Download Streamed Archive link",
      );
      await expect(browser.act({ sessionId, kind: "download", ref: streamed.ref, epoch: obs.epoch })).rejects.toThrow(
        /exceeds the 1 MiB size limit/,
      );
      expect(miniWeb.state.downloadsServed).toContain("chunked.bin");
      expect(await artifacts.listPendingReview(CAPPED_WORKSPACE, 10)).toEqual([]);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("declines a cookie banner after following a cross-site link", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs1 = await browser.navigate(sessionId, `${miniWeb.origin}/cross-site`);
      const link = expectDefined(
        obs1.elements.find((el) => el.text === "Visit Partner Site"),
        "Visit Partner Site link",
      );

      await browser.act({ sessionId, kind: "click", ref: link.ref, epoch: obs1.epoch });
      const obs2 = await browser.observe(sessionId);
      expect(obs2.url).toBe(`${miniWeb.crossOrigin}/with-banner`);
      expect(obs2.consentDeclined).toBe("Reject all");
      expect(obs2.elements.some((el) => el.text === "Reject all")).toBe(false);
    } finally {
      await browser.close(sessionId);
    }
  });

  it("nudges after 4 no-op actions, refuses the next after 6, and reports end of page only at the bottom", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs = await browser.navigate(sessionId, `${miniWeb.origin}/loops?batches=1`);
      const noop = expectDefined(
        obs.elements.find((el) => el.text === "Refresh Feed"),
        "Refresh Feed button",
      );

      for (let i = 1; i <= 3; i += 1) {
        const res = await browser.act({ sessionId, kind: "click", ref: noop.ref, epoch: obs.epoch });
        expect(res.status).toBe("accepted");
        expect(res.detail ?? "").not.toContain("No change in the last 4 actions");
      }

      const fourth = await browser.act({ sessionId, kind: "click", ref: noop.ref, epoch: obs.epoch });
      expect(fourth.status).toBe("accepted");
      expect(fourth.detail).toContain("No change in the last 4 actions: observe, try another approach, or hand off");

      const fifth = await browser.act({ sessionId, kind: "click", ref: noop.ref, epoch: obs.epoch });
      expect(fifth.status).toBe("accepted");
      expect(fifth.detail).toContain("No change in the last 4 actions: observe, try another approach, or hand off");

      // The sixth runs, and says so; the one after it is refused before it runs.
      const sixth = await browser.act({ sessionId, kind: "click", ref: noop.ref, epoch: obs.epoch });
      expect(sixth.status).toBe("accepted");
      const noopsBefore = miniWeb.state.noopClicks;
      const seventh = await browser.act({ sessionId, kind: "click", ref: noop.ref, epoch: obs.epoch });
      expect(seventh.status).toBe("rejected");
      expect(seventh.detail).toContain("No change in the last 6 actions");
      expect(miniWeb.state.noopClicks).toBe(noopsBefore);

      // Navigating resets the loop counter; scroll grows on batch 1, then 2 scrolls without growth report end of page.
      const obs2 = await browser.navigate(sessionId, `${miniWeb.origin}/loops?batches=1`);
      const scroll1 = await browser.act({ sessionId, kind: "scroll", epoch: obs2.epoch, value: "down" });
      expect(scroll1.detail ?? "").not.toContain("end of page");
      expect(miniWeb.state.scrollBatches).toBe(1);

      const scroll2 = await browser.act({ sessionId, kind: "scroll", epoch: obs2.epoch, value: "down" });
      expect(scroll2.detail ?? "").not.toContain("end of page");

      const scroll3 = await browser.act({ sessionId, kind: "scroll", epoch: obs2.epoch, value: "down" });
      expect(scroll3.detail).toContain("end of page");

      // A long page that never grows: reading down it is no end until the bottom.
      const long = await browser.navigate(sessionId, `${miniWeb.origin}/long`);
      for (let i = 1; i <= 4; i += 1) {
        const step = await browser.act({ sessionId, kind: "scroll", epoch: long.epoch, value: "down" });
        expect(step.detail ?? "", `scroll ${i}`).not.toContain("end of page");
      }
      // At its bottom, the same page says so once it stops growing.
      await browser.act({ sessionId, kind: "scroll", epoch: long.epoch, value: "bottom" });
      const last = await browser.act({ sessionId, kind: "scroll", epoch: long.epoch, value: "bottom" });
      expect(last.detail).toContain("end of page");
    } finally {
      await browser.close(sessionId);
    }
  });

  it("supports drag by dx/dy and toRef, horizontal carousel scroll by ref, and clear option on mode: keys", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      const obs1 = await browser.navigate(sessionId, `${miniWeb.origin}/primitives`);
      const slider = expectDefined(
        obs1.elements.find((el) => el.role === "slider" && el.text === "Volume"),
        "Volume slider",
      );
      const slide1 = expectDefined(
        obs1.elements.find((el) => el.role === "button" && el.text === "Slide 1"),
        "Slide 1 button",
      );

      // 1. Drag slider right by dx: +80
      const dragSlider = await browser.act({
        sessionId,
        kind: "drag",
        ref: slider.ref,
        epoch: obs1.epoch,
        dx: 80,
        dy: 0,
      });
      expect(dragSlider.status).toBe("accepted");
      const obsAfterSlider = dragSlider.page ?? (await browser.observe(sessionId));
      const updatedSlider = expectDefined(
        obsAfterSlider.elements.find((el) => el.role === "slider" && el.text === "Volume"),
        "updated Volume slider",
      );
      expect(Number(updatedSlider.value)).toBeGreaterThan(20);

      // 2. Drag chip to drop zone by toRef
      const chipNow = expectDefined(
        obsAfterSlider.elements.find((el) => el.role === "button" && el.text === "Drag Chip"),
        "Drag Chip",
      );
      const zoneNow = expectDefined(
        obsAfterSlider.elements.find((el) => el.role === "button" && el.text === "Drop Zone"),
        "Drop Zone",
      );
      const dragToRef = await browser.act({
        sessionId,
        kind: "drag",
        ref: chipNow.ref,
        toRef: zoneNow.ref,
        epoch: obsAfterSlider.epoch,
      });
      expect(dragToRef.status).toBe("accepted");
      const obsAfterDrop = dragToRef.page ?? (await browser.observe(sessionId));
      expect(obsAfterDrop.elements.some((el) => el.role === "status" && el.text === "Dropped on zone")).toBe(true);

      // 3. Horizontal carousel scroll right and left by ref
      const slideNow = expectDefined(
        obsAfterDrop.elements.find((el) => el.role === "button" && el.text === "Slide 1"),
        "Slide 1",
      );
      const scrollRight = await browser.act({
        sessionId,
        kind: "scroll",
        ref: slideNow.ref,
        epoch: obsAfterDrop.epoch,
        value: "right",
      });
      expect(scrollRight.status).toBe("accepted");
      expect(scrollRight.detail).toMatch(/scrolled to [1-9]\d* of \d+ px/);

      const epochForLeft = scrollRight.page?.epoch ?? obsAfterDrop.epoch;
      const scrollLeft = await browser.act({
        sessionId,
        kind: "scroll",
        ref: slide1.ref,
        epoch: epochForLeft,
        value: "left",
      });
      expect(scrollLeft.status).toBe("accepted");
      expect(scrollLeft.detail).toMatch(/scrolled to 0 of \d+ px/);

      // 4. mode: "keys" with clear: false appends, and clear: true replaces
      const obsBeforeType = scrollLeft.page ?? (await browser.observe(sessionId));
      const boxNow = expectDefined(
        obsBeforeType.elements.find((el) => el.role === "textbox" && el.text === "Query"),
        "Query textbox",
      );
      const appended = await browser.act({
        sessionId,
        kind: "type",
        ref: boxNow.ref,
        epoch: obsBeforeType.epoch,
        mode: "keys",
        clear: false,
        value: "-more",
      });
      expect(appended.page?.elements.find((el) => el.role === "textbox" && el.text === "Query")?.value).toBe("seed-more");

      const cleared = await browser.act({
        sessionId,
        kind: "type",
        ref: boxNow.ref,
        epoch: appended.page?.epoch ?? obsBeforeType.epoch,
        mode: "keys",
        clear: true,
        value: "fresh",
      });
      expect(cleared.page?.elements.find((el) => el.role === "textbox" && el.text === "Query")?.value).toBe("fresh");
    } finally {
      await browser.close(sessionId);
    }
  });

  it("refuses a native computer-use click on a commit button by sight and runs the canvas and slider task on both native and generic adapters", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const { sessionId } = await browser.createSession({ workspaceId: "ws-miniweb" });
    try {
      await browser.navigate(sessionId, `${miniWeb.origin}/canvas`);
      const pointer = expectDefined(browser.pointer?.bind(browser), "browser.pointer");
      const context: InvocationContext = {
        runId: "run-vision",
        workspaceId: "ws-miniweb",
        principalId: "user-1",
        caller: "chat",
      };

      // 1. Native click on "Place order" commit button at (110, 228) is refused in isolated world
      let commitStep = 0;
      const seenCommitResults: unknown[] = [];
      const commitModels: ModelPort = {
        async stream(req: ModelRequest): Promise<ModelOutcome> {
          commitStep += 1;
          for (const msg of req.messages) {
            for (const tr of msg.toolResults ?? []) seenCommitResults.push(tr.output);
          }
          if (commitStep === 1) {
            return {
              status: "completed",
              attemptId: "att-c1",
              text: "",
              toolCalls: [{ id: "tc-commit", name: "computer", input: { action: "left_click", coordinate: [110, 228] } }],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          }
          return {
            status: "completed",
            attemptId: "att-c2",
            text: "Refused commit button as expected",
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      };

      const commitOut = await runVisionLoop(
        {
          browser,
          models: commitModels,
          target: async () => ({ connectionId: "conn-1", model: "claude-opus-4-6" }),
          nativeVendor: () => "anthropic",
          newId: () => "id-c",
          now: () => "2026-10-26T20:00:00.000Z",
          urlNow: async () => `${miniWeb.origin}/canvas`,
        },
        pointer,
        context,
        sessionId,
        "Click Place order",
        4,
        new AbortController().signal,
      );
      expect(commitOut.done).toBe(true);
      expect(miniWeb.state.canvasCommitted).toBe(false);
      expect(JSON.stringify(seenCommitResults)).toMatch(/Place order|commit|browser\.act/i);

      // 2. Canvas click + slider drag through native adapter ("anthropic") and generic adapter (undefined) on the same model
      for (const vendor of ["anthropic", undefined] as const) {
        miniWeb.reset();
        await browser.navigate(sessionId, `${miniWeb.origin}/canvas`);
        let step = 0;
        const models: ModelPort = {
          async stream(): Promise<ModelOutcome> {
            step += 1;
            if (vendor === "anthropic") {
              if (step === 1) {
                return {
                  status: "completed",
                  attemptId: "att-n1",
                  text: "",
                  toolCalls: [
                    { id: "tc-n1", name: "computer", input: { action: "left_click", coordinate: [100, 80] } },
                    {
                      id: "tc-n2",
                      name: "computer",
                      input: { action: "left_click_drag", start_coordinate: [60, 172], coordinate: [200, 172] },
                    },
                  ],
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                };
              }
              return {
                status: "completed",
                attemptId: "att-n2",
                text: "Completed canvas click and slider drag",
                toolCalls: [],
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              };
            }
            if (step === 1) {
              return {
                status: "completed",
                attemptId: "att-g1",
                text: "",
                toolCalls: [{ id: "tc-g1", name: "vision_act", input: { action: "click", x: 100, y: 80 } }],
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              };
            }
            if (step === 2) {
              return {
                status: "completed",
                attemptId: "att-g2",
                text: "",
                toolCalls: [{ id: "tc-g2", name: "vision_act", input: { action: "drag", x: 60, y: 172, toX: 200, toY: 172 } }],
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              };
            }
            return {
              status: "completed",
              attemptId: "att-g3",
              text: "",
              toolCalls: [{ id: "tc-g3", name: "vision_act", input: { action: "done", summary: "Completed canvas and slider" } }],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          },
        };

        const out = await runVisionLoop(
          {
            browser,
            models,
            target: async () => ({ connectionId: "conn-1", model: "claude-opus-4-6" }),
            ...(vendor === undefined ? {} : { nativeVendor: () => vendor }),
            newId: () => "id-v",
            now: () => "2026-10-26T20:00:00.000Z",
            urlNow: async () => `${miniWeb.origin}/canvas`,
          },
          pointer,
          context,
          sessionId,
          "Click the canvas and drag the slider right",
          5,
          new AbortController().signal,
        );
        expect(out.done).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(miniWeb.state.canvasClicks).toBe(1);
        expect(miniWeb.state.canvasSliderValue).toBeGreaterThan(50);
      }
    } finally {
      await browser.close(sessionId);
    }
  });
});
