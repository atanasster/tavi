// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import type { ConnectionSummary } from "../../../src/features/settings/models-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ModelBrowser } from "../../../src/features/settings/ModelBrowser.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, mount, unmountAll } from "../../support/dom.js";

beforeEach(() => void freshAnnouncer());

/**
 * Native video and the video analysers on the Models page:
 * a per-model switch on every connection
 * that can take video, turned on only after its disclosure; a probe for a
 * model not known to read video; a video badge in the picker; and what
 * `doctor` says of the analyser chains.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The model browser mounted, reading from `client`. */
async function browse(client: SettingsClient): Promise<void> {
  await mount(
    <InWorkspace client={client} workspaceId="default">
      <ModelBrowser />
    </InWorkspace>,
  );
}
const byLabel = (label: string): HTMLElement | null => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byText = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

const openrouter: ConnectionSummary = {
  connectionId: "openrouter",
  label: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialRef: "openrouter.apiKey",
  localOnly: false,
  defaultModel: null,
};
const vllm: ConnectionSummary = {
  connectionId: "vllm",
  label: "vLLM",
  kind: "openai-compatible",
  baseUrl: "http://localhost:8000/v1",
  credentialRef: "vllm.apiKey",
  localOnly: true,
  defaultModel: null,
};
const openai: ConnectionSummary = {
  connectionId: "openai",
  label: "OpenAI",
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "openai.apiKey",
  localOnly: false,
  defaultModel: null,
};

const catalog = (): Record<string, { modelId: string; capabilities: string[] }[]> => ({
  openrouter: [
    { modelId: "google/gemini-2.5-flash", capabilities: ["tools", "video"] },
    { modelId: "plain", capabilities: ["tools"] },
  ],
  vllm: [
    { modelId: "qwen-vl", capabilities: ["video-probed"] },
    { modelId: "llama", capabilities: [] },
    { modelId: "dud", capabilities: [] },
  ],
  openai: [{ modelId: "gpt-x", capabilities: ["tools", "video"] }],
  plugin: [{ modelId: "vision", capabilities: ["video"] }],
  refusing: [{ modelId: "google/gemini-2.5-flash", capabilities: ["video"] }],
});

const DOCTOR = {
  ffmpeg: "9.0.2",
  confinement: "srt",
  detail: "each video is read in its own srt sandbox",
  enabled: true,
  analyzers: {
    chains: {
      pose: ["rtmpose (builtin): not-installed, its add-on is not installed"],
      transcribe: ["mcp.vision/analyze (mcp, remote): ready"],
      ocr: [],
    },
  },
};

/**
 * An owner that refuses an unconfirmed switch with its disclosure, as `setVideoModel` does; whose probe passes for
 * `llama` (recording `video-probed`) and fails for `dud`; and whose `models video-status` says doctor's `video`.
 */
function owner(connections: ConnectionSummary[], video: Record<string, unknown> = DOCTOR) {
  const writes: Record<string, unknown>[] = [];
  const CATALOG = catalog();
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      const action = payload["action"];
      // A page never reads `doctor` (the bridge refuses it): the card reads `models video-status`.
      if (command === "doctor") return { ok: false, error: { code: "NOT_AUTHORIZED", message: "doctor is not available through tavi ui" } };
      if (action === "video-status") return { ok: true, result: video };
      if (action === "list") return { ok: true, result: connections };
      if (action === "roles") return { ok: true, result: { workspaceDefault: null, resolved: [], roles: [] } };
      if (action === "lifecycle") return { ok: true, result: { checkedAt: null, warnings: [], unread: [] } };
      if (action === "show")
        return {
          ok: true,
          result: {
            catalog: (CATALOG[String(payload["connectionId"])] ?? []).map((entry) => ({
              connectionId: payload["connectionId"],
              provenance: "live",
              state: "available",
              ...entry,
            })),
          },
        };
      writes.push(payload);
      const index = connections.findIndex((connection) => connection.connectionId === payload["connectionId"]);
      const connection = connections[index] as ConnectionSummary;
      if (action === "video") {
        const enable = payload["videoEnable"];
        if (payload["connectionId"] === "refusing")
          return { ok: false, error: { code: "UNSUPPORTED", message: "Connection refusing has native video on for 32 models, the most" } };
        if (typeof enable === "string" && payload["disclosureConfirmed"] !== true) {
          const disclosure = `${connection.label} receives the whole video when ${enable} is sent one.`;
          return {
            ok: false,
            error: {
              code: "INVALID_INPUT",
              message: `${disclosure} Confirm it to turn video on (tavi models video --yes).`,
              details: { disclosure },
            },
          };
        }
        const now = new Set(connection.videoModels ?? []);
        if (typeof enable === "string") now.add(enable);
        else now.delete(String(payload["videoDisable"]));
        connections[index] = { ...connection, videoModels: [...now] };
        return { ok: true, result: { connectionId: connection.connectionId, videoModels: [...now] } };
      }
      if (action === "probe") {
        if (payload["model"] === "dud")
          return { ok: true, result: { ok: false, videoProbed: false, latencyMs: 900, message: "it gave no answer within 60 s" } };
        CATALOG["vllm"]?.find((entry) => entry.modelId === payload["model"])?.capabilities.push("video-probed");
        return { ok: true, result: { ok: true, videoProbed: true, latencyMs: 900 } };
      }
      return { ok: true, result: { restartRequired: false } };
    },
  };
  return { client, writes };
}

describe("native video per model", () => {
  it("turns video on for a model on an OpenRouter and a vLLM connection only after its disclosure, and off again", async () => {
    const fake = owner([openrouter, vllm]);
    await browse(fake.client);
    for (const [model, label] of [
      ["google/gemini-2.5-flash", "OpenRouter"],
      ["qwen-vl", "vLLM"],
    ] as const) {
      const toggle = byLabel(`Send whole videos to ${model}`);
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      await click(toggle);
      // Nothing is on yet: the disclosure is shown and asked about first.
      expect(document.querySelector(".modal h2")?.textContent).toBe(`Send whole videos to ${model}?`);
      expect(document.querySelector(".modal")?.textContent).toContain(`${label} receives the whole video when ${model} is sent one.`);
      expect(fake.writes.at(-1)).toMatchObject({ action: "video", videoEnable: model, disclosureConfirmed: false });
      await click(byText("Turn on"));
      expect(fake.writes.at(-1)).toMatchObject({ action: "video", videoEnable: model, disclosureConfirmed: true });
      expect(document.querySelector(".modal")).toBeNull();
      expect(byLabel(`Send whole videos to ${model}`)?.getAttribute("aria-checked")).toBe("true");
    }
    expect(announced()).toContain("qwen-vl is sent whole videos.");
    await click(byLabel("Send whole videos to qwen-vl"));
    expect(fake.writes.at(-1)).toMatchObject({ action: "video", connectionId: "vllm", videoDisable: "qwen-vl" });
    expect(byLabel("Send whole videos to qwen-vl")?.getAttribute("aria-checked")).toBe("false");
  });

  it("cancelling the disclosure turns nothing on", async () => {
    const fake = owner([openrouter]);
    await browse(fake.client);
    await click(byLabel("Send whole videos to google/gemini-2.5-flash"));
    await click(byText("Cancel"));
    expect(fake.writes.filter((write) => write["disclosureConfirmed"] === true)).toEqual([]);
    expect(byLabel("Send whole videos to google/gemini-2.5-flash")?.getAttribute("aria-checked")).toBe("false");
  });

  it("probes a model not known to read video, and shows no switch on an endpoint that takes none", async () => {
    const fake = owner([vllm, openai]);
    await browse(fake.client);
    expect(byLabel("Send whole videos to llama")).toBeNull();
    await click(byLabel("Probe whether llama watches video"));
    expect(fake.writes.at(-1)).toMatchObject({ action: "probe", probe: "video", connectionId: "vllm", model: "llama" });
    expect(announced()).toContain("llama read the probe clip");
    // Passed and recorded: its switch is there now.
    expect(byLabel("Send whole videos to llama")?.getAttribute("aria-checked")).toBe("false");
    // A probe that did not pass says the owner's reason, not that the model misread it.
    await click(byLabel("Probe whether dud watches video"));
    // A refusal is the page's alert, said at once, not a polite note.
    expect(document.querySelector('.page-note[role="alert"]')?.textContent).toBe(
      "The video probe of dud did not pass: it gave no answer within 60 s",
    );
    // OpenAI's preset takes no video: frames only, so no switch is offered.
    expect(byLabel("Send whole videos to gpt-x")).toBeNull();
    expect([...document.querySelectorAll(".video-models")]).toHaveLength(1);
  });

  it("says a refusal other than the disclosure as it is, hides a provider-managed connection, and keeps a gone model's switch", async () => {
    const plugin: ConnectionSummary = {
      ...openrouter,
      connectionId: "plugin",
      label: "Plugin",
      baseUrl: "https://plugin.example/v1",
      providerBinding: { instanceId: "acme.models", workspaceId: "default", principalId: "operator", bindingHash: "h" },
    };
    const fake = owner([{ ...openrouter, videoModels: ["retired/model"] }, plugin]);
    await browse(fake.client);
    expect(byLabel("Send whole videos to vision")).toBeNull();
    // On, and no longer in the catalog: still listed, so it can be turned off.
    expect(document.querySelector(".video-models summary")?.textContent).toBe("Native video · on for 1");
    await click(byLabel("Send whole videos to retired/model"));
    expect(fake.writes.at(-1)).toMatchObject({ action: "video", videoDisable: "retired/model" });
    // Any other refusal is said as it is, with no dialog, and nothing turns on.
    unmountAll();
    await browse(owner([{ ...openrouter, connectionId: "refusing", label: "Refusing" }]).client);
    await click(byLabel("Send whole videos to google/gemini-2.5-flash"));
    expect(document.querySelector(".modal")).toBeNull();
    // A refusal is the page's alert, said at once, not a polite note.
    expect(document.querySelector('.page-note[role="alert"]')?.textContent).toBe(
      "Connection refusing has native video on for 32 models, the most",
    );
    expect(byLabel("Send whole videos to google/gemini-2.5-flash")?.getAttribute("aria-checked")).toBe("false");
  });

  it("badges a model that reads video in the picker", async () => {
    await browse(owner([openrouter, vllm]).client);
    await click(byLabel("Set the model for main"));
    const rows = [...document.querySelectorAll(".picker-row")];
    const badges = (model: string): string[] =>
      [...(rows.find((row) => row.textContent?.includes(model))?.querySelectorAll(".badge") ?? [])].map((badge) => badge.textContent ?? "");
    expect(badges("gemini-2.5-flash")).toContain("video");
    expect(badges("qwen-vl")).toContain("video");
    expect(badges("plain")).not.toContain("video");
  });
});

describe("the video analysers' status", () => {
  it("lists each capability's chain from doctor when asked", async () => {
    await browse(owner([openrouter]).client);
    const card = document.querySelector('[aria-labelledby="video-analysers-title"]');
    expect(card?.textContent).toContain("Check to see which can run here.");
    await click(byText("Check"));
    expect(card?.textContent).toContain("FFmpeg: 9.0.2 · runs: srt");
    expect(card?.textContent).toContain("rtmpose (builtin): not-installed, its add-on is not installed");
    expect(card?.textContent).toContain("mcp.vision/analyze (mcp, remote): ready");
    expect(card?.querySelector("dl")?.textContent).toContain("none");
    expect(card?.textContent).toContain("each video is read in its own srt sandbox");
    expect([...(card?.querySelectorAll("dt") ?? [])].map((term) => term.textContent)).toEqual(["Pose", "Transcription", "On-screen text"]);
  });

  it("says when FFmpeg is missing, analyzers.json is not used, the tools are off, or the sandbox does not work", async () => {
    await browse(
      owner([openrouter], {
        ffmpeg: "missing",
        fix: "brew install ffmpeg",
        enabled: false,
        offIn: ["team"],
        works: false,
        note: "the video tools fail until srt works here",
        analyzers: { configError: "analyzers.json: ocr.0: invalid", chains: {} },
      }).client,
    );
    await click(byText("Check"));
    const card = document.querySelector('[aria-labelledby="video-analysers-title"]');
    expect(card?.textContent).toContain("FFmpeg: not installed (brew install ffmpeg)");
    expect(card?.textContent).toContain("analyzers.json is not used: analyzers.json: ocr.0: invalid");
    expect(card?.textContent).toContain("The video tools are off");
    expect(card?.textContent).toContain("The video tools are off in: team.");
    expect(card?.textContent).toContain("the video tools fail until srt works here");
  });
});
