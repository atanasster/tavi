// @vitest-environment jsdom
import type { OnboardingFlowStep, OnboardingStatus, VoiceSetupStatus } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SettingsClient } from "../../../src/lib/ipc.js";
import { VoiceStep } from "../../../src/features/welcome/WelcomeVoiceStep.js";
import { button, flush, settledBy } from "../../support/dom.js";

/**
 * Setup's voice step on the canvas: what transcribing voice messages needs,
 * each ticked when it is here; one button has the owner add the rest, and the
 * step reads the job back until it ends. Where the owner cannot (no
 * Homebrew), the commands that do it by hand, and *Check again*.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { mount: mountFlushed, click } = settledBy(() => flush(6));

function owner(answers: Record<string, unknown | (() => unknown)>) {
  const sent: string[] = [];
  const client: SettingsClient = {
    request: (async (command: string, payload: Record<string, unknown>) => {
      const key = `${command}:${String(payload["action"])}`;
      sent.push(key);
      const answer = answers[key];
      return { ok: true, result: typeof answer === "function" ? (answer as () => unknown)() : (answer ?? {}) };
    }) as SettingsClient["request"],
  };
  return { client, sent };
}

const MISSING: VoiceSetupStatus = {
  supported: true,
  ready: false,
  ffmpeg: true,
  whisper: false,
  model: false,
  automatic: true,
  missing: ["whisper.cpp", "a speech model"],
  commands: ["brew install whisper-cpp ffmpeg", "curl -L -o /data/video/models/ggml-base.bin https://example.test/m"],
  modelInfo: { file: "ggml-base.bin", megabytes: 148, licence: "MIT" },
};
const READY: VoiceSetupStatus = { ...MISSING, ready: true, whisper: true, model: true, missing: [], commands: [] };

const STEP: OnboardingFlowStep = { id: "voice", kind: "voice", title: "Understand voice messages", body: "", optional: true };
const STATUS: OnboardingStatus = {
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [
    { kind: "model", state: "done", detail: "" },
    { kind: "voice", state: "todo", detail: "Missing: whisper.cpp, a speech model" },
  ],
  complete: true,
  firstRun: false,
  open: ["voice"],
};

const mount = (client: SettingsClient, onDone: () => void = () => {}) =>
  mountFlushed(
    <VoiceStep
      client={client}
      workspaceId="default"
      step={STEP}
      status={STATUS}
      providerId="tavi.onboarding"
      appsBefore={new Set()}
      onStep={() => {}}
      onLeave={() => {}}
      onSettings={() => {}}
      onDone={onDone}
      onStatus={() => {}}
    />,
  );

describe("the voice step", () => {
  it("ticks what is here, sets up the rest on the owner and follows the job until voice messages are ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reads: VoiceSetupStatus[] = [
        MISSING,
        { ...MISSING, job: { state: "running", phase: "download", message: "Downloading Whisper's base model", received: 37, total: 148 } },
        { ...READY, job: { state: "done", phase: "configure", message: "Voice messages are transcribed on this computer" } },
      ];
      const { client, sent } = owner({
        "models:voice-status": () => reads.shift(),
        "models:voice-setup": { ...MISSING, job: { state: "running", phase: "install", message: "Installing whisper-cpp with Homebrew" } },
      });
      const onDone = vi.fn();
      const page = await mount(client, onDone);
      expect(page.textContent).toContain("✓ FFmpeg");
      expect(page.textContent).toContain("– whisper.cpp — not here yet");
      expect(page.textContent).toContain("Whisper's base model (148 MB, MIT)");
      await click(button(page, "Set up voice messages"));
      expect(page.textContent).toContain("Installing whisper-cpp with Homebrew");
      expect(button(page, "Setting up…")?.disabled).toBe(true);
      await act(async () => void vi.advanceTimersByTime(1_000));
      await flush(6);
      expect(page.textContent).toContain("Downloading Whisper's base model 25%");
      await act(async () => void vi.advanceTimersByTime(1_000));
      await flush(6);
      expect(page.textContent).toContain("Voice messages are transcribed on this computer.");
      await click(button(page, "Continue"));
      expect(onDone).toHaveBeenCalledOnce();
      expect(sent).toEqual(["models:voice-status", "models:voice-setup", "models:voice-status", "models:voice-status"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the commands where the owner cannot install, and reads again on Check again", async () => {
    const reads: VoiceSetupStatus[] = [{ ...MISSING, automatic: false }, READY];
    const { client, sent } = owner({ "models:voice-status": () => reads.shift() });
    const page = await mount(client);
    expect(page.textContent).toContain("brew install whisper-cpp ffmpeg");
    expect(button(page, "Set up voice messages")).toBeUndefined();
    await click(button(page, "Check again"));
    expect(page.textContent).toContain("Voice messages are transcribed on this computer.");
    expect(sent).toEqual(["models:voice-status", "models:voice-status"]);
  });
});
