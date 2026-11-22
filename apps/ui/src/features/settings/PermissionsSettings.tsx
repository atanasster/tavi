import { Fragment, useEffect, useState } from "react";
import {
  DEFAULT_TAINT_MODE,
  INJECTION_DETECTOR_MODES,
  displaySafe,
  TAINT_MODES,
  type InjectionDetectorMode,
  type ListedSessionGrant,
  type TaintMode,
  type ToolRule,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { workspaceSettingsActions } from "./workspace-api.js";
import { permissionActions } from "./plugins-api.js";
import { Notice, PageHead, PageNote, Pending } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { LoadError } from "./FormParts.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { AppLink } from "../shell/AppLink.js";
import { taskPath } from "../shell/route.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/**
 * Where a rule came from, as a tag beside it — only where its list does not
 * already say: the shipped ones sit under "Shipped with Tavi", and the rest
 * are yours unless the owner was started with `serve --allow`.
 */
const RULE_SOURCE_TAGS: Readonly<Partial<Record<ToolRule["source"], string>>> = {
  flag: "serve --allow",
};

/** A note as a line of its own: its first letter raised (`approved always…` → `Approved always…`). */
function sentence(note: string): string {
  return note.charAt(0).toUpperCase() + note.slice(1);
}

/**
 * The tasks a rule scoped to an origin applies to. A rule scoped to `ipc`
 * also covers the canvas's `web` tasks: the canvas is an attached client too.
 */
const RULE_ORIGINS: Readonly<Record<NonNullable<ToolRule["origin"]>, UiKey>> = {
  cli: "settings.permissions.origin.cli",
  ipc: "settings.permissions.origin.ipc",
  web: "settings.permissions.origin.web",
  messaging: "settings.permissions.origin.messaging",
  schedule: "settings.permissions.origin.schedule",
  agent: "settings.permissions.origin.agent",
  reminder: "settings.permissions.origin.reminder",
  heartbeat: "settings.permissions.origin.heartbeat",
  ideas: "settings.permissions.origin.ideas",
};

/**
 * The rules that decide a tool call before any approval round, and the session
 * grants approvals made. This page lists, removes and revokes;
 * it never adds — a standing rule comes from approving a call with "Always
 * allow", which matches what was shown (for a browser call, the whole browser:
 * `browser.*`). One decision's grants are one row and are revoked together.
 */
/** The rule a `#rule-<id>` address names (an approval's "Always" row opened in a new tab), if any. */
function ruleFromHash(hash: string): string | undefined {
  const match = /^#rule-(.+)$/.exec(hash);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function PermissionsSettings({
  highlight,
}: {
  /** A rule to point out: the one an approval's "Always" row linked to. Absent, the address's `#rule-<id>`. */
  readonly highlight?: string | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [pointed] = useState(() => highlight ?? (typeof window === "undefined" ? undefined : ruleFromHash(window.location.hash)));
  const rules = useLoaded(() => permissionActions.rules(client, workspaceId));
  const ownRules = (rules.data?.rules ?? []).filter((rule) => rule.source !== "shipped");
  const shippedRules = (rules.data?.rules ?? []).filter((rule) => rule.source === "shipped");
  const pointedListed = pointed !== undefined && (rules.data?.rules ?? []).some((rule) => rule.ruleId === pointed);
  // Once the rules are read, the pointed-out one is brought into view.
  useEffect(() => {
    if (!pointedListed || pointed === undefined) return;
    document.getElementById(`rule-${pointed}`)?.scrollIntoView?.({ block: "center" });
  }, [pointedListed, pointed]);
  const grants = useLoaded(() => permissionActions.grants(client, workspaceId));
  const settings = useLoaded<WorkspaceSettingsAnswer>(() => workspaceSettingsActions.load(client, workspaceId));
  const reload = () => {
    rules.reload();
    grants.reload();
    settings.reload();
  };
  const { busy, note, tone, run } = useAction(reload);
  // A matcher came from a call's subjects: what it would hide is marked.
  const describe = (entry: { readonly argMatcher?: string | undefined }) =>
    entry.argMatcher === undefined ? t("settings.permissions.anyCall") : <code className="file-name">{displaySafe(entry.argMatcher)}</code>;
  const ruleRow = (rule: ToolRule) => (
    <li
      key={rule.ruleId}
      id={`rule-${rule.ruleId}`}
      className={rule.ruleId === pointed ? "row rule-pointed" : "row"}
      aria-current={rule.ruleId === pointed ? "true" : undefined}
    >
      <span className="rule-info">
        <span>
          <span className={`badge ${RULE_TONES[rule.decision]}`}>{rule.decision}</span> <code>{rule.toolPattern}</code> — {describe(rule)}
          {/* A rule an app's page set holds in every workspace. */}
          {/* Every shipped rule holds everywhere: its list says so once. */}
          {rule.workspaceId === "*" && rule.source !== "shipped" ? (
            <>
              {" "}
              <span className="badge badge-muted">{t("settings.permissions.allWorkspaces")}</span>
            </>
          ) : null}
          {RULE_SOURCE_TAGS[rule.source] === undefined ? null : (
            <>
              {" "}
              <span className="badge">{RULE_SOURCE_TAGS[rule.source]}</span>
            </>
          )}
        </span>
        {rule.note === undefined && rule.origin === undefined ? null : (
          <span className="muted">
            {rule.note === undefined ? "" : sentence(rule.note)}
            {rule.origin === undefined ? null : (
              <span className="rule-origin">
                {rule.note === undefined ? (
                  t("settings.permissions.onlyFirst", { who: t(RULE_ORIGINS[rule.origin]) })
                ) : (
                  <>
                    {" · "}
                    {t("settings.permissions.only", { who: t(RULE_ORIGINS[rule.origin]) })}
                  </>
                )}
              </span>
            )}
          </span>
        )}
      </span>
      {/* The server removes only an allow rule from a page: dropping a deny or ask rule widens what runs unasked. */}
      {rule.source === "operator" && rule.decision === "allow" ? (
        <span className="actions">
          <RowAction
            tone="danger"
            disabled={busy !== undefined}
            onClick={() => void run(`rule:${rule.ruleId}`, () => permissionActions.remove(client, workspaceId, rule.ruleId))}
          >
            {t("settings.action.remove")}
          </RowAction>
        </span>
      ) : null}
    </li>
  );
  // A browser decision grants every browser tool that asks: one row, one Revoke.
  const decisions = (grants.data?.grants ?? []).reduce<ListedSessionGrant[][]>((rows, grant) => {
    const row = rows.find((entry) => entry[0]?.approvalId === grant.approvalId && entry[0]?.taskId === grant.taskId);
    if (row === undefined) rows.push([grant]);
    else row.push(grant);
    return rows;
  }, []);
  const grantRow = ([grant, ...rest]: ListedSessionGrant[]) =>
    grant === undefined ? null : (
      <li key={grant.grantId} className="row">
        <span className="rule-info">
          {/* What it reaches leads (a site, a path), then the tools: a browser decision's six names never push the site to a line of its own. */}
          <span>
            {grant.argMatcher === undefined ? null : <>{describe(grant)} — </>}
            {[grant, ...rest].map((entry, index) => (
              <Fragment key={entry.grantId}>
                {index === 0 ? "" : ", "}
                <code>{entry.toolId}</code>
              </Fragment>
            ))}
            {grant.argMatcher === undefined ? ` — ${t("settings.permissions.anyCall")}` : null}
          </span>
          <span className="muted">
            {/* The chat as the reader knows it: its title, a link to it, with its id beside it. */}
            {withParts(
              grant.expiresAt === undefined
                ? t("settings.permissions.grantBy", {
                    id: grant.taskTitle === undefined ? "" : ` (${grant.taskId})`,
                    by: grant.createdBy,
                  })
                : t("settings.permissions.grantByUntil", {
                    id: grant.taskTitle === undefined ? "" : ` (${grant.taskId})`,
                    by: grant.createdBy,
                    until: grant.expiresAt.slice(0, 16).replace("T", " "),
                  }),
              {
                chat: (
                  <AppLink href={taskPath(grant.taskId)} onFollow={undefined}>
                    {grant.taskTitle ?? grant.taskId}
                  </AppLink>
                ),
              },
            )}
          </span>
        </span>
        <span className="actions">
          <RowAction
            tone="danger"
            disabled={busy !== undefined}
            onClick={() => void run(`grant:${grant.grantId}`, () => permissionActions.revoke(client, workspaceId, grant.grantId))}
          >
            {t("settings.permissions.revoke")}
          </RowAction>
        </span>
      </li>
    );
  const taint = settings.data?.effective?.securityTaint === undefined ? undefined : settings.data;
  const detector = settings.data?.effective?.securityInjectionDetector === undefined ? undefined : settings.data;
  return (
    <section className="settings" aria-label={t("settings.permissions.region")}>
      <PageHead className="settings-head" title={t("settings.permissions.title")} description={t("settings.permissions.description")} />
      <Notice>
        {withParts(t("settings.permissions.howToAdd"), {
          add: <Command>tavi permissions add</Command>,
          always: <em>{t("settings.permissions.alwaysAllow")}</em>,
          rm: <Command>tavi permissions rm</Command>,
        })}
      </Notice>
      <PageNote tone={tone} note={note} />
      {taint === undefined && detector === undefined ? null : (
        <section className="settings-panel" aria-label={t("settings.permissions.untrustedRegion")}>
          <h2 className="settings-section-title">{t("settings.permissions.untrusted")}</h2>
          <p className="settings-description">
            {withParts(t("settings.permissions.untrustedBody"), {
              record: <em>{t("settings.permissions.recordOnly")}</em>,
              doctor: <Command>tavi doctor</Command>,
              ask: <em>{t("settings.permissions.ask")}</em>,
              command: <Command>{"tavi permissions taint <mode>"}</Command>,
            })}
          </p>
          <div className="settings-fields">
            {taint === undefined ? null : (
              <TaintSetting
                answer={taint}
                busy={busy !== undefined}
                onChange={(mode) => void run("taint", () => workspaceSettingsActions.setTaint(client, workspaceId, mode, taint.revision))}
              />
            )}
            {detector === undefined ? null : (
              <InjectionDetectorSetting
                answer={detector}
                busy={busy !== undefined}
                onChange={(mode) =>
                  void run("detector", () => workspaceSettingsActions.setInjectionDetector(client, workspaceId, mode, detector.revision))
                }
              />
            )}
            {taint?.taintPolicy === undefined ? null : (
              <p>
                {withParts(
                  t("settings.permissions.taintPolicy", {
                    mode: t(TAINT_MODE_LABELS[taint.effective.securityTaint ?? taint.settings.securityTaint ?? DEFAULT_TAINT_MODE]),
                  }),
                  { flag: <code>serve --taint-policy {taint.taintPolicy}</code> },
                )}
              </p>
            )}
          </div>
        </section>
      )}
      <h2 className="settings-section-title">{t("settings.permissions.rules")}</h2>
      {rules.error === undefined ? null : <LoadError error={rules.error} reload={reload} />}
      {rules.loading && rules.data === undefined ? (
        <Pending label={t("settings.permissions.loadingRules")} className="notice" status />
      ) : (
        <>
          {/* Your rules lead; the ones Tavi ships are folded under their count, opened when an approval points at one. */}
          {ownRules.length === 0 ? <p className="muted">{t("settings.permissions.noneOwn")}</p> : null}
          <ul className="rows">{ownRules.map(ruleRow)}</ul>
          {shippedRules.length === 0 ? null : (
            <details className="rules-shipped" open={shippedRules.some((rule) => rule.ruleId === pointed)}>
              <summary className="disclosure">{t("settings.permissions.shipped", { count: shippedRules.length })}</summary>
              <ul className="rows">{shippedRules.map(ruleRow)}</ul>
            </details>
          )}
        </>
      )}
      {pointed !== undefined && rules.data !== undefined && !pointedListed ? (
        <p className="muted">{t("settings.permissions.pointedGone")}</p>
      ) : null}
      <h2 className="settings-section-title">{t("settings.permissions.grants")}</h2>
      {grants.error === undefined ? null : <LoadError error={grants.error} reload={reload} />}
      {grants.loading && grants.data === undefined ? (
        <Pending label={t("settings.permissions.loadingGrants")} className="notice" status />
      ) : (grants.data?.grants.length ?? 0) === 0 ? (
        <Empty>{t("settings.permissions.noGrants")}</Empty>
      ) : (
        <ul className="rows">{decisions.map(grantRow)}</ul>
      )}
    </section>
  );
}

const RULE_TONES: Readonly<Record<ToolRule["decision"], string>> = {
  allow: "badge-ok",
  ask: "badge-warning",
  deny: "badge-bad",
};

const TAINT_MODE_LABELS: Readonly<Record<TaintMode, UiKey>> = {
  enforce: "settings.permissions.taint.enforce",
  observe: "settings.permissions.taint.observe",
  off: "settings.permissions.taint.off",
};

const TAINT_RANK: Readonly<Record<TaintMode, number>> = { off: 0, observe: 1, enforce: 2 };

/**
 * `security.taint`: once untrusted content is in
 * a chat, `enforce` asks before a call that could send data out, use a
 * credential or save something (the default, `DEFAULT_TAINT_MODE`); `observe`
 * decides as before and records what it would have asked. A page may only raise it: the
 * owner refuses a lower mode from here (as it refuses removing a deny rule).
 */
function TaintSetting({
  answer,
  busy,
  onChange,
}: {
  readonly answer: WorkspaceSettingsAnswer;
  readonly busy: boolean;
  readonly onChange: (mode: TaintMode) => void;
}) {
  const t = useT();
  const stored = answer.settings.securityTaint ?? DEFAULT_TAINT_MODE;
  return (
    <label>
      {t("settings.permissions.mode")}
      <Select
        aria-label={t("settings.permissions.modeLabel")}
        value={stored}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as TaintMode)}
      >
        {TAINT_MODES.map((mode) => (
          <option key={mode} value={mode} disabled={TAINT_RANK[mode] < TAINT_RANK[stored]}>
            {t(TAINT_MODE_LABELS[mode])}
          </option>
        ))}
      </Select>
    </label>
  );
}

const DETECTOR_MODE_LABELS: Readonly<Record<InjectionDetectorMode, UiKey>> = {
  off: "settings.permissions.detector.off",
  patterns: "settings.permissions.detector.patterns",
  model: "settings.permissions.detector.model",
};

/**
 * `security.injectionDetector`: a detector reads
 * a chat's untrusted content and flags a call made after a likely injection.
 * Raise-only: a hit adds a warning line and high risk to the call's approval,
 * and never allows, refuses or lowers anything.
 */
function InjectionDetectorSetting({
  answer,
  busy,
  onChange,
}: {
  readonly answer: WorkspaceSettingsAnswer;
  readonly busy: boolean;
  readonly onChange: (mode: InjectionDetectorMode) => void;
}) {
  const t = useT();
  const mode = answer.effective.securityInjectionDetector ?? "off";
  return (
    <label>
      {t("settings.permissions.detector")}
      <Select
        aria-label={t("settings.permissions.detectorLabel")}
        aria-describedby="injection-detector-hint"
        value={mode}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as InjectionDetectorMode)}
      >
        {INJECTION_DETECTOR_MODES.map((entry) => (
          <option key={entry} value={entry}>
            {t(DETECTOR_MODE_LABELS[entry])}
          </option>
        ))}
      </Select>
      {/* What it does, under its own field rather than across both. */}
      <span id="injection-detector-hint" className="settings-description">
        {t("settings.permissions.detectorHint")}
      </span>
    </label>
  );
}
