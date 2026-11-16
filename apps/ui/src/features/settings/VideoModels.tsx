import { VIDEO_LIMITS, presetVideoNever, readsVideo } from "@tavi/contracts";

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
      <summary>Native video{count === 0 ? "" : ` · on for ${String(count)}`}</summary>
      <p className="muted">
        A model turned on is sent a whole clip (MP4, MOV or WebM, up to {String(VIDEO_LIMITS.viewMaxDurationSec / 60)} minutes and{" "}
        {String(VIDEO_LIMITS.viewMaxBytes / 1024 / 1024)} MiB) in a chat someone is in; every other model, and every routine, sees the
        video's frames.
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
                  aria-label={`Send whole videos to ${name}`}
                  title={`Send whole videos to ${name}`}
                  disabled={busy !== undefined}
                  onClick={() => onSwitch(modelId, !sent)}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Probe whether ${name} watches video`}
                  disabled={busy !== undefined}
                  onClick={() => onProbe(modelId)}
                >
                  {busy === `probe-video:${connection.connectionId}:${modelId}` ? "Probing…" : "Probe"}
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
const CAPABILITY_NAMES: Readonly<Record<string, string>> = { pose: "Pose", transcribe: "Transcription", ocr: "On-screen text" };

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
  return (
    <Card
      title="Video analysers"
      titleId="video-analysers-title"
      level={2}
      actions={
        <Button size="sm" disabled={loading} onClick={onCheck}>
          {loading ? "Checking…" : status === undefined ? "Check" : "Check again"}
        </Button>
      }
    >
      {error !== undefined ? <Failure>{error}</Failure> : null}
      {status === undefined ? (
        <p className="muted">
          Pose, transcription and on-screen text come from the analysers the owner's video/analyzers.json names, or the built-in ones when
          it has none. Check to see which can run here.
        </p>
      ) : (
        <>
          <p className="muted">
            FFmpeg: {status.ffmpeg === "missing" ? `not installed${status.fix === undefined ? "" : ` (${status.fix})`}` : status.ffmpeg}
            {status.confinement === undefined ? "" : ` · runs: ${status.confinement}`}
          </p>
          {status.detail !== undefined ? <p className="muted">{status.detail}</p> : null}
          {status.enabled === false ? (
            <Failure alert={false}>The video tools are off (Settings → General, or tavi config set video.enabled on).</Failure>
          ) : null}
          {status.offIn !== undefined ? <p className="muted">The video tools are off in: {status.offIn.join(", ")}.</p> : null}
          {status.broken !== undefined ? <Failure alert={false}>{status.broken}</Failure> : null}
          {status.configError !== undefined ? <Failure alert={false}>analyzers.json is not used: {status.configError}</Failure> : null}
          <dl className="video-analyser-chains">
            {Object.entries(status.chains).map(([capability, entries]) => (
              <div key={capability}>
                <dt>{CAPABILITY_NAMES[capability] ?? capability}</dt>
                <dd>
                  {entries.length === 0 ? (
                    <span className="muted">none</span>
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
