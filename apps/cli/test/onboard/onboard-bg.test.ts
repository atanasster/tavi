import {
  errorTextIn,
  memoryEmbeddingDisclosure,
  TaviError,
  type OnboardingStatus,
  type WorkspaceSettingsRepositoryPort,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { CORE_EN } from "@tavi/contracts/locales/core-en";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { WSL1_UNSUPPORTED, WSL_KEEP_RUNNING } from "@tavi/node-kit";
import { partialFake } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { onboardingCommand, type OnboardingCommandDependencies } from "../../src/features/onboard/owner.js";
import type { Prompter } from "../../src/features/onboard/prompter.js";
import {
  channelsStep,
  searchAllowedNotice,
  serviceStep,
  voiceStep,
  type StepContext,
  type StepSystem,
} from "../../src/features/onboard/steps.js";
import type { OnboardTransport } from "../../src/features/onboard/transport.js";
import { applyWorkspaceSetting } from "../../src/server/workspace-settings-commands.js";

/**
 * Onboarding in a Bulgarian workspace: the terminal flow's own lines, the
 * owner's refusals and the workspace settings' refusals are said in
 * Bulgarian, while the English they always printed stays as it was.
 */

const bg = coreIn("bg");

const STATUS: OnboardingStatus = {
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [{ kind: "model", state: "done", detail: "OpenRouter · m · verified" }],
  complete: true,
  firstRun: false,
  open: [],
};

/** A step's context whose prompter speaks `t` and keeps what it said. */
function step(t: CoreT, overrides: Partial<StepSystem> = {}, attached = false) {
  const said: string[] = [];
  const prompter = partialFake<Prompter>({ say: (text: string) => void said.push(text), words: () => t });
  const transport = partialFake<OnboardTransport>({ attached, request: async () => ({}) });
  const system = partialFake<StepSystem>({ platform: "darwin", home: "/home/test", ...overrides });
  const context: StepContext = { transport, prompter, system, workspaceId: "default", mode: "onboard", status: STATUS };
  return { context, said };
}

describe("onboarding in Bulgarian", () => {
  it("says the voice and channel steps' lines in Bulgarian when no owner runs", async () => {
    const voice = step(bg);
    await voiceStep(voice.context);
    expect(voice.said.join("\n")).toContain("Гласови съобщения — настройва ги работещият сървър на Tavi");
    const channels = step(bg);
    await channelsStep(channels.context);
    expect(channels.said.join("\n")).toContain("сдвояването иска работещ сървър на Tavi");
    // English is what it always said.
    const english = step(coreEnglish);
    await channelsStep(english.context);
    expect(english.said.join("\n")).toContain(
      "Channels — pairing needs a running owner: start `tavi serve` in another terminal, then run `tavi onboard` again.",
    );
  });

  it("says why the service cannot be kept running here, WSL's words included", async () => {
    const windows = step(bg, { platform: "win32" });
    await serviceStep(windows.context);
    expect(windows.said.join("\n")).toContain("Постоянна работа — tavi serve още не работи под Windows");
    // The English keys are node-kit's own words, said the same by the doctor and `tavi service`.
    expect(CORE_EN["onboard.say.wsl1"]).toBe(WSL1_UNSUPPORTED);
    expect(CORE_EN["onboard.say.wslKeepRunning"]).toBe(WSL_KEEP_RUNNING);
  });

  it("tells where searches go, with the menu path in Bulgarian", () => {
    const notice = searchAllowedNotice("brave", bg);
    expect(notice).toContain("Търсенията отиват към brave без питане");
    expect(notice).toContain("Настройки → Разрешения");
    expect(searchAllowedNotice("brave")).toContain("To be asked before every search: tavi permissions rm");
  });

  it("keys the owner's refusals, so the canvas and the terminal say them in Bulgarian", async () => {
    const deps = partialFake<OnboardingCommandDependencies>({ principalOf: () => undefined });
    const answer = await onboardingCommand(deps, { action: "status", workspaceId: "w1" });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.message).toBe("no operator acts in workspace w1");
    expect(errorTextIn(answer.error, bg)).toBe("никой собственик не работи в работното пространство w1");
  });

  it("keys the workspace settings' refusals beside their unchanged English", async () => {
    const settings = partialFake<WorkspaceSettingsRepositoryPort>({
      get: async () => ({ workspaceId: "default", settings: {}, revision: 0, actor: "operator", updatedAt: "2026-11-23T00:00:00.000Z" }),
    });
    const refusal = async (key: "locale" | "videoKeepDays" | "browserVisionEngine", value: string): Promise<TaviError> => {
      try {
        await applyWorkspaceSetting(settings, { workspaceId: "default", key, value, actor: "operator", now: "2026-11-23T00:00:00.000Z" });
      } catch (error) {
        return TaviError.from(error);
      }
      throw new Error("not refused");
    };
    const language = await refusal("locale", "xx");
    expect(language.message).toBe('"xx" is not a language Tavi speaks; use one of en, bg');
    expect(errorTextIn(language, bg)).toBe('"xx" не е език, който Tavi говори; използвай някой от: en, bg');
    const days = await refusal("videoKeepDays", "0");
    expect(errorTextIn(days, bg)).toContain("не е брой дни от 1 до");
    const engine = await refusal("browserVisionEngine", "x");
    expect(engine.message).toBe('"x" is not a vision engine: generic or native');
    expect(errorTextIn(engine, bg)).toBe('"x" не е механизъм за зрение: generic или native');
  });

  it("says hybrid recall's disclosure in Bulgarian, its English message as the check wrote it", async () => {
    const settings = partialFake<WorkspaceSettingsRepositoryPort>({
      get: async () => ({ workspaceId: "default", settings: {}, revision: 0, actor: "operator", updatedAt: "2026-11-23T00:00:00.000Z" }),
    });
    const disclosure = memoryEmbeddingDisclosure({ connectionId: "remote", records: 3 });
    let failure: TaviError | undefined;
    try {
      await applyWorkspaceSetting(settings, {
        workspaceId: "default",
        key: "memory",
        value: JSON.stringify({ retrieval: "hybrid" }),
        actor: "operator",
        now: "2026-11-23T00:00:00.000Z",
        retrievalCheck: async () => ({
          remote: true,
          connectionId: "remote",
          records: 3,
          personal: 0,
          disclosure,
          personalDisclosure: "",
        }),
      });
    } catch (error) {
      failure = TaviError.from(error);
    }
    expect(failure?.code).toBe("APPROVAL_REQUIRED");
    expect(failure?.message).toBe(`${disclosure} Confirm to turn hybrid recall on.`);
    const said = errorTextIn(failure, bg);
    expect(said).toContain(memoryEmbeddingDisclosure({ connectionId: "remote", records: 3 }, bg));
    expect(said).toContain("потвърди, за да включа хибридното припомняне");
  });

  it("has a Bulgarian sign-in error for each English one", () => {
    expect(bg("onboard.signIn.noKeyIssued", { status: "500" })).toBe("OpenRouter не издаде ключ (HTTP 500); влез пак или постави ключ");
    expect(bg("onboard.signIn.chatGptTooLong")).toBe("Влизането с ChatGPT отне твърде дълго. Започни отначало.");
  });
});
