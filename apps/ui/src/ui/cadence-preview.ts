import { useEffect, useState } from "react";
import { SCHEDULE_PREVIEW_RUNS, type SchedulePreviewResult, type ScheduleSpec } from "@tavi/contracts";

import { ask, type SettingsClient } from "../lib/ipc.js";
import { dayTime, todayIn } from "../lib/time.js";
import { cadencePayload } from "./cadence.js";

/** How long typing settles before the next runs are asked for. */
export const PREVIEW_DELAY_MS = 250;

export type Preview =
  | { readonly state: "waiting" }
  | { readonly state: "ready"; readonly runs: readonly string[] }
  | { readonly state: "failed"; readonly message: string };

/** What the preview says aloud once it is known: the next run alone, or that there is none; nothing while it is worked out. */
export function previewSaid(preview: Preview, zone: string): string {
  if (preview.state === "waiting") return "";
  if (preview.state === "failed") return `Next runs not available: ${preview.message}`;
  const next = preview.runs[0];
  return next === undefined ? "It does not run again." : `Next run ${dayTime(next, zone, todayIn(zone))}.`;
}

/** The owner's next runs of `spec`, asked once typing settles; nothing is asked while it has problems. */
export function usePreview(
  client: SettingsClient | undefined,
  workspaceId: string | undefined,
  spec: ScheduleSpec,
  ready: boolean,
): Preview {
  const key = JSON.stringify(cadencePayload(spec));
  const [preview, setPreview] = useState<{ readonly key: string; readonly value: Preview }>();
  useEffect(() => {
    if (client === undefined || !ready) return;
    let live = true;
    const timer = setTimeout(() => {
      void ask<Partial<SchedulePreviewResult> | null>(
        client,
        "schedules",
        { action: "preview", ...(workspaceId === undefined ? {} : { workspaceId }), ...JSON.parse(key), limit: SCHEDULE_PREVIEW_RUNS },
        { refused: "The owner could not work them out." },
      ).then((answer) => {
        if (!live) return;
        const runs = answer.ok ? answer.value?.runs : undefined;
        setPreview({
          key,
          value: answer.ok
            ? Array.isArray(runs) && runs.every((run) => typeof run === "string")
              ? { state: "ready", runs }
              : { state: "failed", message: "The owner did not answer with them." }
            : { state: "failed", message: answer.message },
        });
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, key, ready]);
  return preview?.key === key ? preview.value : { state: "waiting" };
}
