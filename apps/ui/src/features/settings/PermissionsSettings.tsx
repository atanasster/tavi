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

import { workspaceSettingsActions } from "./workspace-api.js";
import { permissionActions } from "./plugins-api.js";
import { Notice, PageHead, Pending, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { LoadError } from "./FormParts.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { AppLink } from "../shell/AppLink.js";
import { taskPath } from "../shell/route.js";
import { Command } from "../../ui/Command.js";

const RULE_SOURCES: Readonly<Record<ToolRule["source"], string>> = {
  shipped: "shipped with Tavi",
  flag: "serve --allow",
  operator: "yours",
};

/**
 * The tasks a rule scoped to an origin applies to. A rule scoped to `ipc`
 * also covers the canvas's `web` tasks: the canvas is an attached client too.
 */
const RULE_ORIGINS: Readonly<Record<NonNullable<ToolRule["origin"]>, string>> = {
  cli: "tasks started with tavi run",
  ipc: "tasks started in a terminal or on the web",
  web: "tasks started on the web",
  messaging: "tasks started from a chat",
  schedule: "scheduled tasks",
  agent: "delegated tasks",
  reminder: "tasks a reminder started",
  heartbeat: "heartbeat checks",
  ideas: "ideas' prepared first steps",
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
  const { busy, note, run } = useAction(reload);
  // A matcher came from a call's subjects: what it would hide is marked.
  const describe = (entry: { readonly argMatcher?: string | undefined }) =>
    entry.argMatcher === undefined ? "any call" : <code>{displaySafe(entry.argMatcher)}</code>;
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
          {rule.workspaceId === "*" ? (
            <>
              {" "}
              <span className="badge badge-muted">All workspaces</span>
            </>
          ) : null}
        </span>
        <span className="muted">
          {RULE_SOURCES[rule.source]}
          {rule.note === undefined ? "" : `: ${rule.note}`}
          {rule.origin === undefined ? null : <span className="rule-origin"> · only {RULE_ORIGINS[rule.origin]}</span>}
        </span>
      </span>
      {/* The server removes only an allow rule from a page: dropping a deny or ask rule widens what runs unasked. */}
      {rule.source === "operator" && rule.decision === "allow" ? (
        <span className="actions">
          <Button
            variant="danger"
            disabled={busy !== undefined}
            onClick={() => void run(`rule:${rule.ruleId}`, () => permissionActions.remove(client, workspaceId, rule.ruleId))}
          >
            Remove
          </Button>
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
          <span>
            {[grant, ...rest].map((entry, index) => (
              <Fragment key={entry.grantId}>
                {index === 0 ? "" : ", "}
                <code>{entry.toolId}</code>
              </Fragment>
            ))}{" "}
            — {describe(grant)}
          </span>
          <span className="muted">
            {/* The chat as the reader knows it: its title, a link to it, with its id beside it. */}
            in{" "}
            <AppLink href={taskPath(grant.taskId)} onFollow={undefined}>
              {grant.taskTitle ?? grant.taskId}
            </AppLink>
            {grant.taskTitle === undefined ? "" : ` (${grant.taskId})`}, by {grant.createdBy}
            {grant.expiresAt === undefined ? "" : `, until ${grant.expiresAt.slice(0, 16).replace("T", " ")} UTC or the chat's next epoch`}
          </span>
        </span>
        <span className="actions">
          <Button
            variant="danger"
            disabled={busy !== undefined}
            onClick={() => void run(`grant:${grant.grantId}`, () => permissionActions.revoke(client, workspaceId, grant.grantId))}
          >
            Revoke
          </Button>
        </span>
      </li>
    );
  const taint = settings.data?.effective?.securityTaint === undefined ? undefined : settings.data;
  const detector = settings.data?.effective?.securityInjectionDetector === undefined ? undefined : settings.data;
  return (
    <section className="settings" aria-label="permissions">
      <PageHead
        className="settings-head"
        title="Permissions"
        description={
          <>
            Each tool call is checked when the model makes it: a built-in list refuses a few destructive commands outright, then deny, ask
            and allow rules apply (deny wins), then what approvals allowed for the rest of a task. Anything else that changes something or
            reaches outside waits for your approval.
          </>
        }
      />
      <Notice>
        Add a rule with <Command>tavi permissions add</Command>, or by approving a call with <em>Always allow</em>. This page removes only
        allow rules; remove a deny or ask rule with <Command>tavi permissions rm</Command>, since dropping one widens what runs unasked.
      </Notice>
      <StatusNote note={note} />
      {taint === undefined && detector === undefined ? null : (
        <section className="settings-panel" aria-label="untrusted content">
          <h2 className="settings-section-title">Untrusted content</h2>
          <p className="settings-description">
            After a web page, an email or a search result enters a chat, a call that could send data out, use a credential or save something
            can be held for your approval, whatever rules or grants allow. <em>Record only</em> decides as before and records each call it
            would have asked, which <Command>tavi doctor</Command> counts; <em>Ask</em> holds them. This page can only make it stricter;
            lower it with <Command>{"tavi permissions taint <mode>"}</Command>.
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
            {detector === undefined ? null : (
              <p>
                A likely injection in a page, an email or a result adds a warning to the next call's approval. It never decides for you.
              </p>
            )}
            {taint?.taintPolicy === undefined ? null : (
              <p>
                The owner was started with <code>serve --taint-policy {taint.taintPolicy}</code>, which applies instead until it restarts
                without it ({TAINT_MODE_LABELS[taint.effective.securityTaint ?? taint.settings.securityTaint ?? DEFAULT_TAINT_MODE]}).
              </p>
            )}
          </div>
        </section>
      )}
      <h2 className="settings-section-title">Rules</h2>
      {rules.error === undefined ? null : <LoadError error={rules.error} reload={reload} />}
      {rules.loading && rules.data === undefined ? (
        <Pending label="Loading rules…" className="notice" status />
      ) : (
        <>
          {/* Your rules lead; the ones Tavi ships are folded under their count, opened when an approval points at one. */}
          {ownRules.length === 0 ? <p className="muted">None of your own yet: Always allow on an approval adds one.</p> : null}
          <ul className="rows">{ownRules.map(ruleRow)}</ul>
          {shippedRules.length === 0 ? null : (
            <details className="rules-shipped" open={shippedRules.some((rule) => rule.ruleId === pointed)}>
              <summary className="disclosure">Shipped with Tavi · {shippedRules.length}</summary>
              <ul className="rows">{shippedRules.map(ruleRow)}</ul>
            </details>
          )}
        </>
      )}
      {pointed !== undefined && rules.data !== undefined && !pointedListed ? (
        <p className="muted">The rule that approval saved is no longer listed: it was removed.</p>
      ) : null}
      <h2 className="settings-section-title">Chat grants</h2>
      {grants.error === undefined ? null : <LoadError error={grants.error} reload={reload} />}
      {grants.loading && grants.data === undefined ? (
        <Pending label="Loading chat grants…" className="notice" status />
      ) : (grants.data?.grants.length ?? 0) === 0 ? (
        <Empty>No chat grants.</Empty>
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

const TAINT_MODE_LABELS: Readonly<Record<TaintMode, string>> = {
  enforce: "Ask (enforce)",
  observe: "Record only (observe)",
  off: "Off",
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
  const stored = answer.settings.securityTaint ?? DEFAULT_TAINT_MODE;
  return (
    <label>
      Mode
      <Select aria-label="taint mode" value={stored} disabled={busy} onChange={(event) => onChange(event.target.value as TaintMode)}>
        {TAINT_MODES.map((mode) => (
          <option key={mode} value={mode} disabled={TAINT_RANK[mode] < TAINT_RANK[stored]}>
            {TAINT_MODE_LABELS[mode]}
          </option>
        ))}
      </Select>
    </label>
  );
}

const DETECTOR_MODE_LABELS: Readonly<Record<InjectionDetectorMode, string>> = {
  off: "Off",
  patterns: "Patterns",
  model: "Patterns, then the fast model",
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
  const mode = answer.effective.securityInjectionDetector ?? "off";
  return (
    <label>
      Injection detector
      <Select
        aria-label="injection detector"
        value={mode}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as InjectionDetectorMode)}
      >
        {INJECTION_DETECTOR_MODES.map((entry) => (
          <option key={entry} value={entry}>
            {DETECTOR_MODE_LABELS[entry]}
          </option>
        ))}
      </Select>
    </label>
  );
}
