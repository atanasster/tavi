import type { ArtifactListRow } from "@tavi/contracts";

import { listBrowserSessions } from "../center/browser-api.js";
import { useCloseBrowser } from "../center/use-close-browser.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { Failure, Pending } from "../../ui/Parts.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { Session } from "../shell/shell.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { loadArtifacts } from "../chat/tasks-api.js";
import { chatVersion } from "./load.js";
import { Empty } from "../../ui/Empty.js";
import { formatBytes, formatCount } from "../../lib/format.js";
import { fileKind, fileTitle, HeldFilePicture, ReviewBadge, showsImage } from "../chat/held-file.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { reduceModelName } from "../../lib/model-name.js";

/** The models that requested this chat's tool calls, as durable accounting names them, in first-seen order. */
export function modelsUsed(session: Session): readonly string[] {
  const seen = new Set<string>();
  for (const run of session.runs) {
    for (const entry of run.run.transcript) if (entry.kind === "tool" && entry.model !== undefined) seen.add(entry.model);
  }
  return [...seen];
}

/**
 * Provider usage for the chat, once an execution reported it: a recorded
 * chat's totals across its turns, else the latest execution's. Absent while a
 * turn runs and nothing was reported yet — never shown as "not recorded".
 */
export function usage(
  session: Session,
): { readonly scope: string; readonly models: readonly string[]; readonly tokens: string } | undefined {
  for (const run of [...session.runs].reverse()) {
    const recorded = run.recordedHistory?.metrics;
    const metrics = recorded ?? run.run.metrics;
    if (metrics === undefined) continue;
    return {
      scope: translateNow(recorded === undefined ? "chatPanel.details.scopeLast" : "chatPanel.details.scopeChat"),
      models: metrics.models,
      tokens: metrics.partial
        ? translateNow("chatPanel.details.tokensPartial", { count: metrics.totalTokens })
        : formatCount(metrics.totalTokens),
    };
  }
  return undefined;
}

/**
 * The chat panel's Details tab: run
 * facts, the model, the task's artifacts and live browser sessions, the
 * rounds waiting on a decision, and the metadata of an artifact Changes
 * opened. Rendered only while shown, and keyed by session; its reads are made
 * when it is shown and again when `chatVersion` says the chat moved on.
 */
export function Details({
  artifact,
  session,
  client,
  modelTarget,
  onChanges,
  onBrowser,
}: {
  readonly artifact?: ArtifactListRow | undefined;
  readonly session: Session | undefined;
  /** Absent: the reads are not made, and their sections are not drawn. */
  readonly client?: SettingsClient | undefined;
  /** The workspace's model target, when the owner has named it. */
  readonly modelTarget?: string | undefined;
  /** Open the chat's Changes view. */
  readonly onChanges?: (() => void) | undefined;
  /** Open the Command Center's Browser section; absent when the owner does not offer it. */
  readonly onBrowser?: (() => void) | undefined;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  if (session === undefined) return <Empty>{t("ui.parts.noChatSelected")}</Empty>;
  const last = session.runs.at(-1);
  /** Turns that ran: a Home a schedule started holds a place for its record, which is no turn. */
  const turns = session.runs.filter((run) => run.noTurn !== true).length;
  const pending = session.runs.flatMap((run) => run.run.pending);
  const reported = usage(session);
  const models = [...new Set([...modelsUsed(session), ...(reported?.models ?? [])])];
  return (
    <>
      {artifact ? (
        <section aria-label={t("chatPanel.details.artifactLabel")}>
          <h4>{fileTitle(artifact)}</h4>
          {showsImage(artifact) ? <HeldFilePicture row={artifact} alt={fileTitle(artifact)} className="held-file-preview" /> : null}
          <dl className="facts">
            <dt>{t("chatPanel.details.type")}</dt>
            <dd>{fileKind(artifact.contentType)}</dd>
            <dt>{t("chatPanel.details.size")}</dt>
            <dd>{formatBytes(artifact.byteSize)}</dd>
            <dt>{t("chatPanel.details.review")}</dt>
            <dd>
              <ReviewBadge state={artifact.reviewState} />
            </dd>
            <dt>{t("chatPanel.details.id")}</dt>
            <dd className="held-file-id">{artifact.artifactId}</dd>
          </dl>
          {showsImage(artifact) ? null : (
            <p className="muted">
              {t(artifact.reviewState === "approved" ? "chatPanel.details.picturesOnly" : "chatPanel.details.afterApproval")}
            </p>
          )}
        </section>
      ) : null}
      {/* What the chat ran on and how much, in words; its ids are under Technical details. */}
      <dl className="facts facts-plain">
        <dt>{t("chatPanel.details.turns")}</dt>
        <dd>{turns}</dd>
        <dt>{t("chatPanel.details.model")}</dt>
        <dd title={modelTarget}>{modelTarget === undefined ? "—" : reduceModelName(modelTarget)}</dd>
        {models.length === 0 ? null : (
          <>
            <dt>{t(models.length === 1 ? "chatPanel.details.modelUsed" : "chatPanel.details.modelsUsed")}</dt>
            <dd title={models.join(", ")}>{models.map(reduceModelName).join(", ")}</dd>
          </>
        )}
        {reported === undefined ? null : (
          <>
            <dt>{t("chatPanel.details.tokens", { scope: reported.scope })}</dt>
            <dd title={t("chatPanel.details.tokensTitle")}>{reported.tokens}</dd>
          </>
        )}
      </dl>
      {pending.length === 0 ? null : (
        <>
          <h4>{t("chatPanel.details.waitingDecision")}</h4>
          <ul>
            {pending.map((round) => (
              <li key={`${round.taskId}:${round.steps}`}>
                {t("chatPanel.details.round", { steps: round.steps, count: round.requests.length })}
              </li>
            ))}
          </ul>
        </>
      )}
      {client === undefined || session.taskId === undefined ? null : (
        <>
          <Artifacts client={client} taskId={session.taskId} version={chatVersion(session)} onChanges={onChanges} />
          <BrowserSessions client={client} taskId={session.taskId} version={chatVersion(session)} onBrowser={onBrowser} />
        </>
      )}
      <details className="chat-panel-technical">
        <summary className="disclosure">{t("chatPanel.details.technical")}</summary>
        <dl className="facts">
          <dt>{t("chatPanel.details.task")}</dt>
          <dd>{session.taskId ?? t("chatPanel.details.notAdmitted")}</dd>
          <dt>{t("chatPanel.details.workspace")}</dt>
          <dd>{last?.run.workspaceId ?? workspaceId}</dd>
          <dt>{t("chatPanel.details.thread")}</dt>
          <dd>{last?.run.threadId ?? "—"}</dd>
          <dt>{turns > 1 ? t("chatPanel.details.operationKeyTurn", { turn: turns }) : t("chatPanel.details.operationKey")}</dt>
          <dd>{turns === 0 ? "—" : (last?.id ?? "—")}</dd>
          {modelTarget === undefined ? null : (
            <>
              <dt>{t("chatPanel.details.modelTarget")}</dt>
              <dd>{modelTarget}</dd>
            </>
          )}
        </dl>
      </details>
    </>
  );
}

function Artifacts({
  client,
  taskId,
  version,
  onChanges,
}: {
  readonly client: SettingsClient;
  readonly taskId: string;
  readonly version: string;
  readonly onChanges?: (() => void) | undefined;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => loadArtifacts(client, workspaceId, taskId), [version]);
  const rows = data?.rows.filter((row) => row.workspaceId === workspaceId && row.runId === taskId);
  return (
    <section aria-label={t("chatPanel.details.artifactsLabel")}>
      <h4>{t("chatPanel.details.artifacts")}</h4>
      {error !== undefined || rows === undefined ? (
        <Pending error={error} />
      ) : (
        <p>
          {rows.length === 0
            ? t("chatPanel.details.noneArchived")
            : t(data?.nextCursor === undefined ? "chatPanel.details.archived" : "chatPanel.details.archivedMore", { count: rows.length })}
          {onChanges === undefined || rows.length === 0 ? null : (
            <>
              {" "}
              <Button variant="ghost" size="sm" onClick={onChanges}>
                {t("chatPanel.details.openHeld")}
              </Button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * A session the chat's last turn left open: **Ended**, kept for the
 * next turn, and closable here to free the browser it holds.
 */
function EndedSession({ client, sessionId }: { readonly client: SettingsClient; readonly sessionId: string }) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { state, failure, close } = useCloseBrowser(client, workspaceId, sessionId);
  if (state === "closed") return <span className="muted"> · {t("chatPanel.details.closed")}</span>;
  return (
    <>
      <span className="muted"> · {t("chatPanel.details.ended")}</span>{" "}
      <Button variant="ghost" size="sm" disabled={state === "closing"} onClick={() => void close()}>
        {state === "closing" ? t("chatPanel.details.closing") : t("chatPanel.details.closeBrowser")}
      </Button>
      {failure === undefined ? null : <Failure as="span"> {failure}</Failure>}
    </>
  );
}

/**
 * The chat's open browser sessions, as the owner filters them by its task;
 * past the owner's list limit (a `nextCursor`) the tab says some are not
 * shown. Closed sessions stay in the Center.
 */
function BrowserSessions({
  client,
  taskId,
  version,
  onBrowser,
}: {
  readonly client: SettingsClient;
  readonly taskId: string;
  readonly version: string;
  readonly onBrowser?: (() => void) | undefined;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => listBrowserSessions(client, workspaceId, { open: true, taskId }), [version]);
  const live = data?.items;
  const partial = data?.nextCursor !== undefined;
  return (
    <section aria-label={t("chatPanel.details.browserLabel")}>
      <h4>{t("chatPanel.details.browser")}</h4>
      {error !== undefined || live === undefined ? (
        <Pending error={error} />
      ) : live.length === 0 ? (
        <Empty>{t("chatPanel.details.noLive")}</Empty>
      ) : (
        <ul>
          {live.map((item) => (
            <li key={item.sessionId}>
              {item.lastTitle ?? item.host ?? "about:blank"}
              {item.host === null || item.lastTitle === null ? null : <span className="muted"> · {item.host}</span>}
              {item.inactive === true ? <EndedSession client={client} sessionId={item.sessionId} /> : null}
            </li>
          ))}
        </ul>
      )}
      {partial ? <Empty>{t("chatPanel.details.moreLive")}</Empty> : null}
      {onBrowser === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onBrowser}>
          {t("chatPanel.details.earlier")}
        </Button>
      )}
    </section>
  );
}
