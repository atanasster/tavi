import { definedOnly } from "@tavi/contracts/util";

import { ask, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** What `doctor` says of video: the FFmpeg found, how runs are confined, and each capability's analyser chain. */
export interface VideoStatus {
  readonly ffmpeg: string;
  /** The video tools' switch: off everywhere, or the workspaces it is off in. */
  readonly enabled?: boolean;
  readonly offIn?: readonly string[];
  readonly confinement?: string;
  /** How runs are confined, in words. */
  readonly detail?: string;
  /** srt does not work here, and why every video call fails until it does. */
  readonly broken?: string;
  readonly fix?: string;
  readonly configError?: string;
  readonly chains: Readonly<Record<string, readonly string[]>>;
}

/** What `doctor` says of video, through `models video-status` (a page may not read `doctor`), read when asked. */
export async function loadVideoStatus(client: SettingsClient): Promise<Outcome<VideoStatus>> {
  const answer = await ask<Record<string, unknown>>(client, "models", { action: "video-status" }, { timeoutMs: 60_000 });
  if (!answer.ok) return answer;
  const video = answer.value;
  const analyzers = (video["analyzers"] ?? {}) as {
    readonly chains?: Readonly<Record<string, readonly string[]>>;
    readonly configError?: string;
  };
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const confinement = text(video["confinement"]);
  const fix = text(video["fix"]);
  const detail = text(video["detail"]);
  const broken = video["works"] === false ? (text(video["note"]) ?? "the sandbox does not work here, so video calls fail") : undefined;
  const offIn = Array.isArray(video["offIn"])
    ? (video["offIn"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ok: true,
    value: {
      ffmpeg: text(video["ffmpeg"]) ?? "unknown",
      ...(typeof video["enabled"] === "boolean" ? { enabled: video["enabled"] } : {}),
      ...(offIn.length === 0 ? {} : { offIn }),
      ...definedOnly({ confinement, detail, broken, fix, configError: analyzers.configError }),
      chains: analyzers.chains ?? {},
    },
  };
}
