import { VIDEO_LIMITS, presetVideoNever, readsVideo } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import type { BrowsedModel, ConnectionSummary } from "./models-api.js";
import type { VideoStatus } from "./video-api.js";
import { Card } from "../../ui/Card.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";

/**
 * A connection's native-video switches: each model its catalog or a probe says reads video can be sent whole
 * clips, turned on after its disclosure; any other model can be probed. An
 * endpoint that takes no video (its preset says so) and a provider-managed
 * connection show none.
 */
export function VideoModels({
  connection,
  models,
  busy,
  onSwitch,
  onProbe,
}: {
  readonly connection: ConnectionSummary;
  readonly models: readonly BrowsedModel[];
  readonly busy: string | undefined;
  readonly onSwitch: (model: string, on: boolean) => void;
  readonly onProbe: (model: string) => void;
}) {
  const t = useT();
  const on = new Set(connection.videoModels ?? []);
  // A model turned on and since gone from the catalog keeps its row, so it can still be turned off.
  const listed = [
    ...models.map((model) => ({ modelId: model.modelId, name: model.displayName ?? model.modelId, reads: readsVideo(model.capabilities) })),
    ...[...on]
      .filter((modelId) => !models.some((model) => model.modelId === modelId))
      .map((modelId) => ({ modelId, name: modelId, reads: false })),
  ];
  if (listed.length === 0 || connection.providerBinding !== undefined || presetVideoNever(connection.baseUrl)) return null;
  const count = on.size;
  return (
    <details className="video-models">
      <summary className="disclosure">
        {count === 0 ? t("settings.video.native") : t("settings.video.nativeOn", { count: String(count) })}
      </summary>
      <p className="muted">
        {t("settings.video.nativeHint", {
          minutes: String(VIDEO_LIMITS.viewMaxDurationSec / 60),
          size: String(VIDEO_LIMITS.viewMaxBytes / 1024 / 1024),
        })}
      </p>
      <ul className="list-reset video-model-list">
        {listed.map(({ modelId, name, reads }) => {
          const sent = on.has(modelId);
          return (
            <li key={modelId} className="video-model">
              <span className="truncate" title={modelId}>
                {name}
              </span>
              {reads || sent ? (
                <Button
                  variant="bare"
                  role="switch"
                  className="switch"
                  aria-checked={sent}
                  aria-label={t("settings.video.sendWhole", { name })}
                  title={t("settings.video.sendWhole", { name })}
                  disabled={busy !== undefined}
                  onClick={() => onSwitch(modelId, !sent)}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("settings.video.probeLabel", { name })}
                  disabled={busy !== undefined}
                  onClick={() => onProbe(modelId)}
                >
                  {busy === `probe-video:${connection.connectionId}:${modelId}` ? t("settings.video.probing") : t("settings.video.probe")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Each capability's name as the page says it. */
const CAPABILITY_NAMES: Readonly<Record<string, UiKey>> = {
  pose: "settings.video.capability.pose",
  transcribe: "settings.video.capability.transcribe",
  ocr: "settings.video.capability.ocr",
};

/** What `doctor` says of the video analysers: each capability's chain, and why `analyzers.json` was not used. */
export function VideoAnalyzerStatus({
  status,
  loading,
  error,
  onCheck,
}: {
  readonly status: VideoStatus | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly onCheck: () => void;
}) {
  const t = useT();
  return (
    <Card
      title={t("settings.video.analysers")}
      titleId="video-analysers-title"
      level={2}
      actions={
        <Button size="sm" disabled={loading} onClick={onCheck}>
          {loading ? t("settings.rhumb.checking") : status === undefined ? t("settings.video.check") : t("settings.video.checkAgain")}
        </Button>
      }
    >
      {error !== undefined ? <Failure>{error}</Failure> : null}
      {status === undefined ? (
        <p className="muted">{t("settings.video.analysersHint")}</p>
      ) : (
        <>
          <p className="muted">
            {t("settings.video.ffmpeg", {
              ffmpeg:
                status.ffmpeg === "missing"
                  ? status.fix === undefined
                    ? t("settings.video.notInstalled")
                    : t("settings.video.notInstalledFix", { fix: status.fix })
                  : status.ffmpeg,
            })}
            {status.confinement === undefined ? "" : ` · ${t("settings.video.runs", { confinement: status.confinement })}`}
          </p>
          {status.detail !== undefined ? <p className="muted">{status.detail}</p> : null}
          {status.enabled === false ? <Failure alert={false}>{t("settings.video.toolsOff")}</Failure> : null}
          {status.offIn !== undefined ? (
            <p className="muted">{t("settings.video.offIn", { workspaces: status.offIn.join(", ") })}</p>
          ) : null}
          {status.broken !== undefined ? <Failure alert={false}>{status.broken}</Failure> : null}
          {status.configError !== undefined ? (
            <Failure alert={false}>{t("settings.video.configError", { error: status.configError })}</Failure>
          ) : null}
          <dl className="video-analyser-chains">
            {Object.entries(status.chains).map(([capability, entries]) => (
              <div key={capability}>
                <dt>{Object.hasOwn(CAPABILITY_NAMES, capability) ? t(CAPABILITY_NAMES[capability] as UiKey) : capability}</dt>
                <dd>
                  {entries.length === 0 ? (
                    <span className="muted">{t("settings.video.none")}</span>
                  ) : (
                    <ol className="list-reset">
                      {entries.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ol>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}
