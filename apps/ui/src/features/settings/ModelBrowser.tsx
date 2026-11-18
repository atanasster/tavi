import { plural } from "@tavi/contracts/util";
import { useState } from "react";

import { hostOf } from "../../lib/format.js";
import { modelWrite } from "./model-setup.js";
import {
  describeTarget,
  loadModels,
  modelActions,
  roleRows,
  type ConnectionSummary,
  type ModelRole,
  type ModelsData,
  type RoleRow,
  type TargetRef,
} from "./models-api.js";
import { loadVideoStatus, type VideoStatus } from "./video-api.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, PageHead, StatusNote } from "../../ui/Parts.js";
import { Confirm } from "../../ui/Confirm.js";
import { AddConnectionModal, ManageConnectionModal } from "./ConnectionSetup.js";
import { VideoAnalyzerStatus, VideoModels } from "./VideoModels.js";
import { TargetName, TargetPicker } from "./TargetPicker.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { EmptyState } from "../../ui/Empty.js";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** What each role is for, in the words the table shows under its name. */
const ROLE_PURPOSE: Readonly<Record<ModelRole, string>> = {
  main: "Chat and agent work",
  extraction: "Pulls facts and structure out of text",
  compaction: "Summarises long conversations",
  fast: "Quick, cheaper work that does not need the main model",
  embedding: "Turns text into vectors for search",
};

const roleName = (role: ModelRole): string => role.replaceAll("_", " ");

/** Which picker is open: the workspace default, or one role. */
type Picking = { readonly slot: "default"; readonly connectionId?: string } | { readonly slot: "role"; readonly role: ModelRole };

/**
 * The Models page, roles first: what the workspace default and each of the
 * five roles run, each changed through one searchable picker; then the
 * connections the models come from, each rediscovered or managed in place.
 * Adding a connection is a dialog that ends by asking for a default model when
 * the workspace has none.
 */
export function ModelBrowser() {
  const { workspaceId } = useWorkspace();
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => loadModels(client, workspaceId));
  // With `tavi.video` off nothing reads a video: its switches and analysers are not shown.
  const settings = useLoaded(() => workspaceSettingsActions.load(client, workspaceId));
  const videoOff = settings.data?.disabledPlugins?.includes("tavi.video") === true;
  const { busy, note, run, say } = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<ConnectionSummary | undefined>();
  const [picking, setPicking] = useState<Picking | undefined>();
  /** A model whose native video waits on its disclosure being read and confirmed. */
  const [disclosing, setDisclosing] = useState<
    { readonly connectionId: string; readonly model: string; readonly disclosure: string } | undefined
  >();
  const [video, setVideo] = useState<{ readonly status?: VideoStatus; readonly loading: boolean; readonly error?: string }>({
    loading: false,
  });
  const checkVideo = (): void => {
    setVideo((current) => ({ ...current, loading: true }));
    void loadVideoStatus(client).then((outcome) =>
      setVideo(outcome.ok ? { status: outcome.value, loading: false } : { loading: false, error: outcome.message }),
    );
  };
  /** On asks first: the owner answers an unconfirmed one with its disclosure, shown before anything is sent. */
  const switchVideo = (connectionId: string, model: string, on: boolean): void =>
    act(`video:${connectionId}:${model}`, async () => {
      const outcome = await modelActions.setVideo(client, connectionId, model, on);
      if (!outcome.ok && "disclosure" in outcome) {
        setDisclosing({ connectionId, model, disclosure: outcome.disclosure });
        return { ok: true, value: undefined };
      }
      return outcome;
    });

  const act = (key: string, work: () => Promise<Outcome<string | undefined>>): void => void run(key, work);
  /** A dialog's write went through: say so on the page and read the models again. */
  const settle = (message: string | undefined): void => {
    say(message ?? "Saved.");
    reload();
  };
  const saveThen = async (work: Promise<Outcome<string | undefined>>): Promise<Outcome<string | undefined>> => {
    const outcome = await work;
    if (outcome.ok) settle(outcome.value);
    return outcome;
  };

  const hasConnections = data !== undefined && data.connections.length > 0;
  return (
    <section className="settings models-page">
      <PageHead
        className="settings-head"
        title="Models"
        description="Choose which model each part of Tavi uses, and connect the providers they come from."
      >
        {hasConnections ? (
          <Button variant="primary" disabled={busy !== undefined} onClick={() => setAdding(true)}>
            Add connection
          </Button>
        ) : null}
      </PageHead>
      <StatusNote note={note} />
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        {(data?.failures ?? []).map((failure) => (
          <Failure key={failure.connectionId} alert={false}>
            {failure.connectionId}'s models could not be read: {failure.message}
          </Failure>
        ))}
      </LoadState>

      {data !== undefined && !hasConnections ? (
        <EmptyState title="Connect a model provider">
          <p>
            Tavi needs at least one model to chat and run tasks. Add OpenRouter, OpenAI, a local server, or any OpenAI-compatible endpoint.
          </p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add connection
          </Button>
        </EmptyState>
      ) : null}

      {data !== undefined && hasConnections ? (
        <>
          <RolesTable
            data={data}
            busy={busy}
            onPick={setPicking}
            onReset={(role) => act(`clear-role:${role}`, () => modelWrite(client, { action: "clear-role", workspaceId, role }))}
            onClearDefault={() => act("clear-default", () => modelWrite(client, { action: "clear-default", workspaceId }))}
          />
          <Card title="Connections" titleId="connections-title" level={2} bare>
            <ul className="connection-list">
              {data.connections.map((connection) => (
                <ConnectionRow
                  key={connection.connectionId}
                  connection={connection}
                  data={data}
                  busy={busy}
                  onRediscover={() =>
                    act(`discover:${connection.connectionId}`, () => modelActions.discover(client, connection.connectionId))
                  }
                  onManage={() => setManaging(connection)}
                  videoOff={videoOff}
                  onVideo={(model, on) => switchVideo(connection.connectionId, model, on)}
                  onProbeVideo={(model) =>
                    act(`probe-video:${connection.connectionId}:${model}`, () =>
                      modelActions.probeVideo(client, connection.connectionId, model),
                    )
                  }
                />
              ))}
            </ul>
          </Card>
          {videoOff ? null : <VideoAnalyzerStatus status={video.status} loading={video.loading} error={video.error} onCheck={checkVideo} />}
        </>
      ) : null}

      {disclosing !== undefined ? (
        <Confirm
          title={`Send whole videos to ${disclosing.model}?`}
          message={disclosing.disclosure}
          action="Turn on"
          onClose={() => setDisclosing(undefined)}
          onConfirm={async () => {
            const { connectionId, model } = disclosing;
            await run(`video:${connectionId}:${model}`, () => modelActions.setVideo(client, connectionId, model, true, true));
          }}
        />
      ) : null}

      {adding ? (
        <AddConnectionModal
          taken={(data?.connections ?? []).map((connection) => connection.connectionId)}
          onClose={() => setAdding(false)}
          onAdded={(connectionId, message) => {
            setAdding(false);
            settle(message);
            // A first connection leaves the workspace without a default: ask for one now.
            if (data?.roles.workspaceDefault == null) setPicking({ slot: "default", connectionId });
          }}
        />
      ) : null}
      {managing !== undefined ? (
        <ManageConnectionModal
          connection={managing}
          onClose={() => setManaging(undefined)}
          onDone={(message) => {
            setManaging(undefined);
            settle(message);
          }}
        />
      ) : null}
      {picking !== undefined && data !== undefined ? (
        <RolePicker
          picking={picking}
          data={data}
          // Until the reload brings the just-added connection, its models are still on their way.
          loading={
            loading ||
            (picking.slot === "default" &&
              picking.connectionId !== undefined &&
              !data.connections.some((connection) => connection.connectionId === picking.connectionId))
          }
          onTest={(target) => modelActions.test(client, target.connectionId, target.model ?? "")}
          onSave={(primary, fallback) =>
            saveThen(
              picking.slot === "default"
                ? modelActions.setDefault(client, workspaceId, primary.connectionId, primary.model ?? "")
                : modelWrite(client, {
                    action: "set-role",
                    workspaceId,
                    role: picking.role,
                    connectionId: primary.connectionId,
                    model: primary.model,
                    fallback: fallback.map((entry) => ({ connectionId: entry.connectionId, model: entry.model ?? "" })),
                  }),
            )
          }
          onClose={() => setPicking(undefined)}
        />
      ) : null}
    </section>
  );
}

/** The picker, titled and seeded for the slot it changes. */
function RolePicker({
  picking,
  data,
  loading,
  onTest,
  onSave,
  onClose,
}: {
  readonly picking: Picking;
  readonly data: ModelsData;
  readonly loading: boolean;
  readonly onTest: (target: TargetRef) => Promise<Outcome<string | undefined>>;
  readonly onSave: (primary: TargetRef, fallback: readonly TargetRef[]) => Promise<Outcome<string | undefined>>;
  readonly onClose: () => void;
}) {
  if (picking.slot === "default") {
    return (
      <TargetPicker
        title="Default model"
        intro="Every role without a model of its own uses this one."
        data={data}
        loading={loading}
        initial={{ primary: data.roles.workspaceDefault?.target, fallback: [] }}
        {...(picking.connectionId === undefined ? {} : { initialConnection: picking.connectionId })}
        allowFallbacks={false}
        onTest={onTest}
        onSave={onSave}
        onClose={onClose}
      />
    );
  }
  const binding = data.roles.roles?.find((row) => row.role === picking.role);
  return (
    <TargetPicker
      title={`Model for ${roleName(picking.role)}`}
      intro={`${ROLE_PURPOSE[picking.role]}. Saving gives this role its own model instead of the default.`}
      data={data}
      loading={loading}
      initial={{ primary: binding?.target, fallback: binding?.fallback ?? [] }}
      allowFallbacks
      onTest={onTest}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

/** The default, then every role: what it runs, where that comes from, and a way to change it. */
function RolesTable({
  data,
  busy,
  onPick,
  onReset,
  onClearDefault,
}: {
  readonly data: ModelsData;
  readonly busy: string | undefined;
  readonly onPick: (picking: Picking) => void;
  readonly onReset: (role: ModelRole) => void;
  readonly onClearDefault: () => void;
}) {
  const fallback = data.roles.workspaceDefault?.target;
  const rows = roleRows(data.roles);
  // An unbound embedding role is a choice, not a gap: memory search then matches words alone.
  const unset = rows.filter((row) => row.source === "unset" && row.role !== "embedding").length;
  return (
    <Card
      title="Roles"
      titleId="roles-title"
      level={2}
      badge={unset > 0 ? <span className="badge badge-warning">{unset} not set</span> : null}
      bare
    >
      <ul className="role-list">
        <li className="role-row role-row-workspace">
          <div className="role-label">
            <span className="role-name">Default</span>
            <span className="role-purpose meta-sm">Used by every role without its own model, except Embedding</span>
          </div>
          <div className="role-target">
            {fallback === undefined ? <span className="badge badge-warning">Not set</span> : <TargetName target={fallback} data={data} />}
          </div>
          <div className="role-actions">
            {fallback !== undefined ? (
              <Button variant="ghost" size="sm" disabled={busy !== undefined} aria-label="Clear the default model" onClick={onClearDefault}>
                Clear
              </Button>
            ) : null}
            <Button
              variant={fallback === undefined ? "primary" : undefined}
              size="sm"
              disabled={busy !== undefined}
              aria-label="Set the default model"
              onClick={() => onPick({ slot: "default" })}
            >
              Set
            </Button>
          </div>
        </li>
        {rows.map((row) => (
          <RoleLine
            key={row.role}
            row={row}
            data={data}
            busy={busy}
            onPick={() => onPick({ slot: "role", role: row.role })}
            onReset={() => onReset(row.role)}
          />
        ))}
      </ul>
    </Card>
  );
}

function RoleLine({
  row,
  data,
  busy,
  onPick,
  onReset,
}: {
  readonly row: RoleRow;
  readonly data: ModelsData;
  readonly busy: string | undefined;
  readonly onPick: () => void;
  readonly onReset: () => void;
}) {
  const name = roleName(row.role);
  return (
    <li className={`role-row role-source-${row.source}`}>
      <div className="role-label">
        <span className="role-name">{name}</span>
        <span className="role-purpose meta-sm">{ROLE_PURPOSE[row.role]}</span>
      </div>
      <div className="role-target">
        {row.source === "unset" && row.role === "embedding" ? (
          <span className="muted">Not set · memory search matches words only</span>
        ) : row.source === "unset" || row.target === undefined ? (
          <span className="badge badge-warning">Not set</span>
        ) : row.source === "default" ? (
          <span className="muted">Uses default · {describeTarget(row.target, data).name}</span>
        ) : (
          <>
            <TargetName target={row.target} data={data} />
            {row.fallback.length > 0 ? (
              <span className="role-fallbacks meta-sm">
                then{" "}
                {row.fallback.map((entry, index) => (
                  <span key={`${entry.connectionId}/${entry.model ?? ""}`}>
                    {index > 0 ? ", " : ""}
                    <TargetName target={entry} data={data} />
                  </span>
                ))}
              </span>
            ) : null}
          </>
        )}
        {row.problem !== undefined && row.source !== "unset" ? <span className="role-problem">{row.problem}</span> : null}
      </div>
      <div className="role-actions">
        {row.source === "override" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            // Embedding never falls back to the default: resetting it unbinds its model.
            // Said as what it does: back to the default, or, for Embedding, no model at all.
            aria-label={row.role === "embedding" ? `Clear: unbind the model for ${name}` : `Use default for ${name}`}
            onClick={onReset}
          >
            {row.role === "embedding" ? "Clear" : "Use default"}
          </Button>
        ) : null}
        <Button size="sm" disabled={busy !== undefined} aria-label={`Set the model for ${name}`} onClick={onPick}>
          Set
        </Button>
      </div>
    </li>
  );
}

function ConnectionRow({
  connection,
  data,
  busy,
  onRediscover,
  onManage,
  videoOff,
  onVideo,
  onProbeVideo,
}: {
  readonly connection: ConnectionSummary;
  readonly data: ModelsData;
  readonly busy: string | undefined;
  readonly onRediscover: () => void;
  readonly onManage: () => void;
  readonly videoOff: boolean;
  readonly onVideo: (model: string, on: boolean) => void;
  readonly onProbeVideo: (model: string) => void;
}) {
  const models = data.models.filter((model) => model.connectionId === connection.connectionId);
  const failed = data.failures.some((failure) => failure.connectionId === connection.connectionId);
  const stale = models.some((model) => model.stale);
  const health = failed || models.length === 0 ? "warn" : "ok";
  const discovering = busy === `discover:${connection.connectionId}`;
  return (
    <li className="connection-item">
      <span className={`connection-dot connection-dot-${health}`} aria-hidden="true" />
      <div className="connection-info">
        <span className="connection-title">
          {connection.label}
          {connection.localOnly ? <span className="badge">local</span> : null}
          {connection.providerBinding !== undefined ? <span className="badge">plugin</span> : null}
        </span>
        <span className="muted">
          {hostOf(connection.baseUrl)} ·{" "}
          {failed ? "models could not be read" : models.length === 0 ? "no models discovered" : plural(models.length, "model")}
          {stale ? " · list is stale" : ""}
        </span>
        {videoOff ? null : <VideoModels connection={connection} models={models} busy={busy} onSwitch={onVideo} onProbe={onProbeVideo} />}
      </div>
      <div className="connection-actions">
        <Button size="sm" aria-label={`Rediscover ${connection.label}'s models`} disabled={busy !== undefined} onClick={onRediscover}>
          {discovering ? "Discovering…" : "Rediscover"}
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Manage ${connection.label}`} disabled={busy !== undefined} onClick={onManage}>
          Manage
        </Button>
      </div>
    </li>
  );
}
