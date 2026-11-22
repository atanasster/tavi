import { RHUMB_CREDENTIAL_REF } from "@tavi/contracts";
import { useState } from "react";

import { hostOf } from "../../lib/format.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
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
  lifecycleNotice,
  rolesLifecycleNotices,
} from "./models-api.js";
import { loadVideoStatus, type VideoStatus } from "./video-api.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, Notice, PageHead, PageNote } from "../../ui/Parts.js";
import { Confirm } from "../../ui/Confirm.js";
import { AddConnectionModal, ManageConnectionModal } from "./ConnectionSetup.js";
import { VideoAnalyzerStatus, VideoModels } from "./VideoModels.js";
import { RhumbKeyCard } from "./RhumbKeyCard.js";
import { credentialActions } from "./credentials-api.js";
import {
  previewReplace,
  replaceModel,
  replacementChoices,
  replacementLines,
  storeRhumbKey,
  syncLifecycle,
  type ModelRef,
  type ModelReplacements,
} from "./lifecycle-api.js";
import { TargetName, TargetPicker } from "./TargetPicker.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { EmptyState } from "../../ui/Empty.js";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";

/** What each role is for, in the words the table shows under its name. */
const ROLE_PURPOSE: Readonly<Record<ModelRole, UiKey>> = {
  main: "settings.modelsPage.purpose.main",
  extraction: "settings.modelsPage.purpose.extraction",
  compaction: "settings.modelsPage.purpose.compaction",
  fast: "settings.modelsPage.purpose.fast",
  embedding: "settings.modelsPage.purpose.embedding",
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
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => loadModels(client, workspaceId, { replacements: true }));
  // With `tavi.video` off nothing reads a video: its switches and analysers are not shown.
  const settings = useLoaded(() => workspaceSettingsActions.load(client, workspaceId));
  const videoOff = settings.data?.disabledPlugins?.includes("tavi.video") === true;
  // Whether a Rhumb key is stored: the references only, never a value.
  const credentials = useLoaded(() => credentialActions.list(client));
  // An owner that answers no list (an older one) shows no card.
  const listed = credentials.data?.credentials;
  const rhumbStored = Array.isArray(listed) ? listed.includes(RHUMB_CREDENTIAL_REF) : undefined;
  const { busy, note, tone, run, say } = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<ConnectionSummary | undefined>();
  const [picking, setPicking] = useState<Picking | undefined>();
  /** A model whose native video waits on its disclosure being read and confirmed. */
  const [disclosing, setDisclosing] = useState<
    { readonly connectionId: string; readonly model: string; readonly disclosure: string } | undefined
  >();
  /** A replacement whose uses are listed, waiting on a yes. */
  const [replacing, setReplacing] = useState<
    { readonly from: ModelRef; readonly to: ModelRef; readonly uses: readonly string[]; readonly unread: readonly string[] } | undefined
  >();
  /** Lists what moving `from` to `to` changes, then asks; nothing moves before the yes, and a read reloads nothing. */
  const askReplace = (from: ModelRef, to: ModelRef): void =>
    void run(
      `replace:${from.connectionId}/${from.model}`,
      async () => {
        const preview = await previewReplace(client, from, to);
        if (!preview.ok) return preview;
        const { uses, unread } = preview.value;
        // Nothing to move: said on the page, with no dialog that could only cancel.
        if (uses.length === 0)
          return unread.length === 0
            ? { ok: true, value: translateNow("settings.modelsPage.notUsed", { model: `${from.connectionId}/${from.model}` }) }
            : {
                ok: false,
                message: translateNow("settings.modelsPage.usesUnread", {
                  model: `${from.connectionId}/${from.model}`,
                  sources: unread.join("; "),
                }),
              };
        setReplacing({ from, to, uses, unread });
        return { ok: true, value: undefined };
      },
      { reload: false },
    );
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
    say(message ?? translateNow("settings.setup.saved"));
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
      <PageHead className="settings-head" title={t("settings.modelsPage.title")} description={t("settings.modelsPage.description")}>
        {hasConnections ? (
          <Button variant="primary" disabled={busy !== undefined} onClick={() => setAdding(true)}>
            {t("settings.modelsPage.addConnection")}
          </Button>
        ) : null}
      </PageHead>
      <PageNote tone={tone} note={note} />
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        {(data?.failures ?? []).map((failure) => (
          <Failure key={failure.connectionId} alert={false}>
            {t("settings.modelsPage.failure", { connection: failure.connectionId, message: failure.message })}
          </Failure>
        ))}
      </LoadState>

      {data !== undefined && !hasConnections ? (
        <EmptyState title={t("settings.modelsPage.emptyTitle")}>
          <p>{t("settings.modelsPage.emptyBody")}</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t("settings.modelsPage.addConnection")}
          </Button>
        </EmptyState>
      ) : null}

      {data !== undefined && hasConnections ? (
        <>
          <LifecycleBanner data={data} busy={busy !== undefined} onReplace={askReplace} />
          <RolesTable
            data={data}
            busy={busy}
            onPick={setPicking}
            onReset={(role) => act(`clear-role:${role}`, () => modelWrite(client, { action: "clear-role", workspaceId, role }))}
            onClearDefault={() => act("clear-default", () => modelWrite(client, { action: "clear-default", workspaceId }))}
          />
          <Card title={t("settings.modelsPage.connections")} titleId="connections-title" level={2} bare>
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
          <RhumbKeyCard
            stored={rhumbStored}
            busy={busy}
            onStore={(key) =>
              act("rhumb-key", async () => {
                const outcome = await storeRhumbKey(client, key);
                if (outcome.ok) credentials.reload();
                return outcome;
              })
            }
            onCheck={() => act("lifecycle-sync", () => syncLifecycle(client))}
          />
        </>
      ) : null}

      {replacing !== undefined ? (
        <Confirm
          title={t("settings.modelsPage.replaceTitle", { from: replacing.from.model, to: replacing.to.model })}
          message={t("settings.modelsPage.replaceMessage", { to: `${replacing.to.connectionId}/${replacing.to.model}` })}
          action={t("settings.credentials.replace")}
          onClose={() => setReplacing(undefined)}
          onConfirm={async () => {
            const { from, to } = replacing;
            await run(`replace:${from.connectionId}/${from.model}`, () => replaceModel(client, from, to));
          }}
        >
          <ul className="replace-uses">
            {replacing.uses.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
          {replacing.unread.length === 0 ? null : (
            <Notice>{t("settings.modelsPage.notRead", { sources: replacing.unread.join("; ") })}</Notice>
          )}
        </Confirm>
      ) : null}

      {disclosing !== undefined ? (
        <Confirm
          title={t("settings.modelsPage.videoTitle", { model: disclosing.model })}
          message={disclosing.disclosure}
          action={t("settings.modelsPage.turnOn")}
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
  const t = useT();
  if (picking.slot === "default") {
    return (
      <TargetPicker
        title={t("settings.modelsPage.defaultTitle")}
        intro={t("settings.modelsPage.defaultIntro")}
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
      title={t("settings.modelsPage.roleTitle", { role: roleName(picking.role) })}
      intro={t("settings.modelsPage.roleIntro", { purpose: t(ROLE_PURPOSE[picking.role]) })}
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
  const t = useT();
  const fallback = data.roles.workspaceDefault?.target;
  const rows = roleRows(data.roles);
  // An unbound embedding role is a choice, not a gap: memory search then matches words alone.
  const unset = rows.filter((row) => row.source === "unset" && row.role !== "embedding").length;
  return (
    <Card
      title={t("settings.modelsPage.roles")}
      titleId="roles-title"
      level={2}
      badge={unset > 0 ? <span className="badge badge-warning">{t("settings.modelsPage.unsetCount", { count: unset })}</span> : null}
      bare
    >
      <ul className="role-list">
        <li className="role-row role-row-workspace">
          <div className="role-label">
            <span className="role-name">{t("settings.modelsPage.default")}</span>
            <span className="role-purpose meta-sm">{t("settings.modelsPage.defaultPurpose")}</span>
          </div>
          <div className="role-target">
            {fallback === undefined ? (
              <span className="badge badge-warning">{t("settings.modelsPage.notSet")}</span>
            ) : (
              <TargetName target={fallback} data={data} />
            )}
          </div>
          <div className="role-actions">
            {fallback !== undefined ? (
              <RowAction disabled={busy !== undefined} aria-label={t("settings.modelsPage.clearDefault")} onClick={onClearDefault}>
                {t("settings.modelsPage.clear")}
              </RowAction>
            ) : null}
            <RowAction
              // No default yet: setting one is what the row waits on.
              tone={fallback === undefined ? "awaited" : "plain"}
              disabled={busy !== undefined}
              aria-label={t("settings.modelsPage.setDefault")}
              onClick={() => onPick({ slot: "default" })}
            >
              {t("settings.modelsPage.set")}
            </RowAction>
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
  const t = useT();
  const name = roleName(row.role);
  return (
    <li className={`role-row role-source-${row.source}`}>
      <div className="role-label">
        <span className="role-name">{name}</span>
        <span className="role-purpose meta-sm">{t(ROLE_PURPOSE[row.role])}</span>
      </div>
      <div className="role-target">
        {row.source === "unset" && row.role === "embedding" ? (
          <span className="muted">{t("settings.modelsPage.embeddingUnset")}</span>
        ) : row.source === "unset" || row.target === undefined ? (
          <span className="badge badge-warning">{t("settings.modelsPage.notSet")}</span>
        ) : row.source === "default" ? (
          <span className="muted">{t("settings.modelsPage.usesDefault", { name: describeTarget(row.target, data).name })}</span>
        ) : (
          <>
            <TargetName target={row.target} data={data} />
            {row.fallback.length > 0 ? (
              <span className="role-fallbacks meta-sm">
                {t("settings.modelsPage.then")}{" "}
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
          <RowAction
            disabled={busy !== undefined}
            // Embedding never falls back to the default: resetting it unbinds its model.
            // Said as what it does: back to the default, or, for Embedding, no model at all.
            aria-label={
              row.role === "embedding"
                ? t("settings.modelsPage.unbindLabel", { role: name })
                : t("settings.modelsPage.useDefaultLabel", { role: name })
            }
            onClick={onReset}
          >
            {row.role === "embedding" ? t("settings.modelsPage.clear") : t("settings.modelsPage.useDefault")}
          </RowAction>
        ) : null}
        <RowAction disabled={busy !== undefined} aria-label={t("settings.modelsPage.setRoleLabel", { role: name })} onClick={onPick}>
          {t("settings.modelsPage.set")}
        </RowAction>
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
  const t = useT();
  const models = data.models.filter((model) => model.connectionId === connection.connectionId);
  const failed = data.failures.some((failure) => failure.connectionId === connection.connectionId);
  const stale = models.some((model) => model.stale);
  const warning = models.filter((model) => {
    const notice = lifecycleNotice(model);
    return notice !== undefined && notice.level !== "info";
  }).length;
  const health = failed || models.length === 0 ? "warn" : "ok";
  const discovering = busy === `discover:${connection.connectionId}`;
  return (
    <li className="connection-item">
      <span className={`connection-dot connection-dot-${health}`} aria-hidden="true" />
      <div className="connection-info">
        <span className="connection-title">
          {connection.label}
          {connection.localOnly ? <span className="badge">{t("settings.badge.local")}</span> : null}
          {connection.providerBinding !== undefined ? <span className="badge">{t("settings.badge.plugin")}</span> : null}
        </span>
        <span className="muted">
          {hostOf(connection.baseUrl)} ·{" "}
          {failed
            ? t("settings.modelsPage.unreadable")
            : models.length === 0
              ? t("settings.modelsPage.noneDiscovered")
              : t("settings.modelsPage.modelCount", { count: models.length })}
          {stale ? ` · ${t("settings.modelsPage.stale")}` : ""}
          {warning > 0 ? ` · ${t("settings.modelsPage.warningCount", { count: warning })}` : ""}
        </span>
        {videoOff ? null : <VideoModels connection={connection} models={models} busy={busy} onSwitch={onVideo} onProbe={onProbeVideo} />}
      </div>
      <div className="connection-actions">
        <RowAction
          aria-label={t("settings.modelsPage.rediscoverLabel", { connection: connection.label })}
          disabled={busy !== undefined}
          onClick={onRediscover}
        >
          {discovering ? t("settings.modelsPage.discovering") : t("settings.modelsPage.rediscover")}
        </RowAction>
        <RowAction
          aria-label={t("settings.modelsPage.manageLabel", { connection: connection.label })}
          disabled={busy !== undefined}
          onClick={onManage}
        >
          {t("settings.modelsPage.manage")}
        </RowAction>
      </div>
    </li>
  );
}

/**
 * The models in use (the default, the running target, the roles and their
 * fallbacks) that are retired, redirected or retiring soon, from the last
 * lifecycle sync: said above the roles, since Tavi never changes a model for
 * you. Nothing shows when none is.
 */
function LifecycleBanner({
  data,
  busy,
  onReplace,
}: {
  readonly data: ModelsData;
  readonly busy: boolean;
  readonly onReplace: (from: ModelRef, to: ModelRef) => void;
}) {
  const t = useT();
  const notices = rolesLifecycleNotices(data);
  if (notices.length === 0) return null;
  const retired = notices.some(({ notice }) => notice.level === "error");
  const Line = retired ? Failure : Notice;
  // A named section, not a live region: it is there when the page opens, and says nothing new while it stays.
  return (
    <section className="lifecycle-banner" aria-labelledby="lifecycle-banner-title">
      <h2 id="lifecycle-banner-title" className="visually-hidden">
        {t("settings.modelsPage.bannerTitle")}
      </h2>
      <Line {...(retired ? { alert: false } : {})}>
        {retired ? t("settings.modelsPage.bannerRetired") : t("settings.modelsPage.bannerRetiring")}
      </Line>
      <ul className="list-reset">
        {notices.map(({ target, notice, replacements }) => {
          const lines = replacementLines(replacements);
          return (
            <li key={target}>
              <strong>{target}</strong> {notice.text}
              {lines.length === 0 ? null : (
                <ul className="lifecycle-replacements">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <ReplaceButtons target={target} replacements={replacements} busy={busy} onReplace={onReplace} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One button per model that may take over, on the same connection, each saying what it was suggested for. */
function ReplaceButtons({
  target,
  replacements,
  busy,
  onReplace,
}: {
  readonly target: string;
  readonly replacements: ModelReplacements | undefined;
  readonly busy: boolean;
  readonly onReplace: (from: ModelRef, to: ModelRef) => void;
}) {
  const t = useT();
  const slash = target.indexOf("/");
  const from = { connectionId: target.slice(0, slash), model: target.slice(slash + 1) };
  const choices = replacementChoices(replacements, from.model);
  if (choices.length === 0) return null;
  return (
    <div className="lifecycle-replace-actions">
      {choices.map(({ model, why }) => (
        <Button
          key={model}
          variant="ghost"
          size="sm"
          disabled={busy}
          // The visible words first, then which model it replaces: a voice command matches what is shown.
          aria-label={t("settings.modelsPage.replaceWithLabel", { model, why, target })}
          onClick={() => onReplace(from, { connectionId: from.connectionId, model })}
        >
          {t("settings.modelsPage.replaceWith", { model, why })}
        </Button>
      ))}
    </div>
  );
}
