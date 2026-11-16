import type { ArtifactListRow } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { listBrowserSessions } from "../center/browser-api.js";
import { useCloseBrowser } from "../center/use-close-browser.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { Failure, NO_CHAT_SELECTED, Pending } from "../../ui/Parts.js";
import type { Session } from "../shell/shell.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { loadArtifacts } from "../chat/tasks-api.js";
import { chatVersion } from "./load.js";
import { Empty } from "../../ui/Empty.js";
import { formatCount } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

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
      scope: recorded === undefined ? "last execution" : "this chat",
      models: metrics.models,
      tokens: `${metrics.partial ? "at least " : ""}${formatCount(metrics.totalTokens)}${metrics.partial ? " (partial)" : ""}`,
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
  const { workspaceId } = useWorkspace();
  if (session === undefined) return <Empty>{NO_CHAT_SELECTED}</Empty>;
  const last = session.runs.at(-1);
  /** Turns that ran: a Home a schedule started holds a place for its record, which is no turn. */
  const turns = session.runs.filter((run) => run.noTurn !== true).length;
  const pending = session.runs.flatMap((run) => run.run.pending);
  const reported = usage(session);
  const models = [...new Set([...modelsUsed(session), ...(reported?.models ?? [])])];
  return (
    <>
      {artifact ? (
        <section aria-label="artifact details">
          <h4>Artifact metadata</h4>
          <dl className="facts">
            <dt>ID</dt>
            <dd>{artifact.artifactId}</dd>
            <dt>Content type</dt>
            <dd>{artifact.contentType}</dd>
            <dt>Bytes</dt>
            <dd>{artifact.byteSize}</dd>
            <dt>Review</dt>
            <dd>{artifact.reviewState}</dd>
          </dl>
          <p>Content is not loaded in this page.</p>
        </section>
      ) : null}
      <dl className="facts">
        <dt>Task</dt>
        <dd>{session.taskId ?? "not admitted yet"}</dd>
        <dt>Workspace</dt>
        <dd>{last?.run.workspaceId ?? workspaceId}</dd>
        <dt>Thread</dt>
        <dd>{last?.run.threadId ?? "—"}</dd>
        <dt>{turns > 1 ? `Operation key (turn ${turns} of ${turns})` : "Operation key"}</dt>
        <dd>{turns === 0 ? "—" : (last?.id ?? "—")}</dd>
        <dt>Turns</dt>
        <dd>{turns}</dd>
        <dt>Model target</dt>
        <dd>{modelTarget ?? "—"}</dd>
        {models.length === 0 ? null : (
          <>
            <dt>Models used</dt>
            <dd>{models.join(", ")}</dd>
          </>
        )}
        {reported === undefined ? null : (
          <>
            <dt>{`Tokens (${reported.scope})`}</dt>
            <dd title="Provider-reported, including tool steps and retries">{reported.tokens}</dd>
          </>
        )}
      </dl>
      <h4>Waiting on a decision</h4>
      {pending.length === 0 ? (
        <Empty>Nothing.</Empty>
      ) : (
        <ul>
          {pending.map((round) => (
            <li key={`${round.taskId}:${round.steps}`}>
              Round {round.steps}: {plural(round.requests.length, "call")}
            </li>
          ))}
        </ul>
      )}
      {client === undefined || session.taskId === undefined ? null : (
        <>
          <Artifacts client={client} taskId={session.taskId} version={chatVersion(session)} onChanges={onChanges} />
          <BrowserSessions client={client} taskId={session.taskId} version={chatVersion(session)} onBrowser={onBrowser} />
        </>
      )}
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
  const { workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => loadArtifacts(client, workspaceId, taskId), [version]);
  const rows = data?.rows.filter((row) => row.workspaceId === workspaceId && row.runId === taskId);
  return (
    <section aria-label="this chat's artifacts">
      <h4>Artifacts</h4>
      {error !== undefined || rows === undefined ? (
        <Pending error={error} />
      ) : (
        <p>
          {rows.length === 0 ? "None archived." : `${rows.length}${data?.nextCursor === undefined ? "" : "+"} archived.`}
          {onChanges === undefined || rows.length === 0 ? null : (
            <>
              {" "}
              <Button variant="ghost" size="sm" onClick={onChanges}>
                Open in Held files
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
  const { workspaceId } = useWorkspace();
  const { state, failure, close } = useCloseBrowser(client, workspaceId, sessionId);
  if (state === "closed") return <span className="muted"> · closed</span>;
  return (
    <>
      <span className="muted"> · Ended</span>{" "}
      <Button variant="ghost" size="sm" disabled={state === "closing"} onClick={() => void close()}>
        {state === "closing" ? "Closing…" : "Close browser"}
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
  const { workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => listBrowserSessions(client, workspaceId, { open: true, taskId }), [version]);
  const live = data?.items;
  const partial = data?.nextCursor !== undefined;
  return (
    <section aria-label="this chat's browser sessions">
      <h4>Browser</h4>
      {error !== undefined || live === undefined ? (
        <Pending error={error} />
      ) : live.length === 0 ? (
        <Empty>No live session.</Empty>
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
      {partial ? <Empty>This chat has more live sessions than one list holds; some are not shown.</Empty> : null}
      {onBrowser === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onBrowser}>
          Earlier sessions in the Command Center →
        </Button>
      )}
    </section>
  );
}
