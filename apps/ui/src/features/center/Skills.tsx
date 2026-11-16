import {
  SKILL_FEEDBACK_MAX_CHARS,
  SKILL_UNUSED_DAYS,
  skillBundleFileBytes,
  skillBundleFilesForReview,
  skillPackageFiles,
  skillProposalEditedInto,
  skillProposalExpired,
  skillProposalUntrustedLine,
  skillActivationHistoryText,
  skillTraceLine,
  skillToolsEscalationText,
  skillUsageText,
  taviToolForSkillName,
  type SkillsBodyAnswer,
  type SkillsTraceAnswer,
  type SkillVersion,
} from "@tavi/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import { instantLabel, todayIn } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Confirm.js";
import { Empty } from "../../ui/Empty.js";
import { Failure, LoadError, Pending } from "../../ui/Parts.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import {
  decideSkill,
  editSkill,
  foreignProvenance,
  lineDiff,
  listSkills,
  sendSkillFeedback,
  showSkill,
  skillBody,
  skillEntries,
  skillTrace,
  takeSkillFocus,
  type SkillDecision,
  type SkillEntry,
} from "./skills-api.js";
import { Field } from "../../ui/Field.js";

/**
 * The workspace's skills: what waits for review first, then every skill with
 * its versions. A version opens its text, diffed against the version it
 * follows; approving, rejecting, activating, disabling and rolling back are
 * the operator's, as `tavi skills` is. Each skill shows how often it was used
 * and when last, flagged once active and unused for `SKILL_UNUSED_DAYS`.
 *
 * An agent's proposal also shows the tool calls of the task it came from,
 * and what that turn read that Tavi does not trust; it can be edited before
 * approving (a new proposed version that follows it) or sent back to its
 * chat with feedback, for the agent to propose again. A chat's skill card's
 * *Review* opens its proposal here (`requestSkillFocus`).
 */
export function SkillsPane({ revision }: { readonly revision: number }) {
  const { client, workspaceId } = useWorkspace();
  const listed = useLoaded(() => listSkills(client, workspaceId), [workspaceId, revision]);
  // A chat card's *Review* names the proposal to open: taken once, as the page first shows.
  const [focused] = useState(takeSkillFocus);
  const [opened, setOpened] = useState<{ readonly skillId: string; readonly version: string } | undefined>(focused);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const entries = listed.data === undefined ? [] : skillEntries(listed.data);
  const proposed = entries.flatMap((entry) => entry.versions.filter((version) => version.reviewState === "proposed"));

  const decide = async (decision: SkillDecision, activeVersion: string | undefined): Promise<void> => {
    setFailure(undefined);
    const outcome = await decideSkill(client, workspaceId, decision, activeVersion);
    if (!outcome.ok) setFailure(outcome.message);
    listed.reload();
  };

  return (
    <section className="soul-skills" aria-labelledby="soul-skills-title">
      <h2 id="soul-skills-title">Skills</h2>
      <p className="settings-description">
        Procedures the agent loads when they apply (skills.read). Only an approved, active version is offered; a skill grants no permission.
      </p>
      {listed.error === undefined ? null : <LoadError error={`Skills could not be listed: ${listed.error}`} reload={listed.reload} />}
      {listed.data === undefined ? (
        <Pending error={listed.error} />
      ) : entries.length === 0 ? (
        <Empty>No skills yet. Import one with `tavi skills import`.</Empty>
      ) : (
        <>
          {proposed.length === 0 ? null : (
            <section aria-labelledby="soul-skills-proposed">
              <h3 id="soul-skills-proposed">Waiting for review</h3>
              <ul className="list-reset">
                {proposed.map((version) => (
                  <li key={`${version.skillId}@${version.version}`}>
                    <VersionLine
                      review
                      version={version}
                      onOpen={() => setOpened({ skillId: version.skillId, version: version.version })}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ul className="list-reset soul-skills-list">
            {/* A skill that is only a proposal so far waits above, and has no row of its own yet. */}
            {entries
              .filter((entry) => entry.versions.some((version) => version.reviewState !== "proposed"))
              .map((entry) => (
                <li key={entry.skillId}>
                  <SkillRow entry={entry} onOpen={(version) => setOpened({ skillId: entry.skillId, version })} onDecide={decide} />
                </li>
              ))}
          </ul>
        </>
      )}
      <Failure message={failure} />
      {opened === undefined ? null : (
        <SkillVersionViewer
          key={`${opened.skillId}@${opened.version}@${revision}`}
          skillId={opened.skillId}
          version={opened.version}
          active={entries.find((entry) => entry.skillId === opened.skillId)?.active}
          focused={focused !== undefined && focused.skillId === opened.skillId && focused.version === opened.version}
          onDecide={decide}
          onOpen={(version) => {
            listed.reload();
            setOpened({ skillId: opened.skillId, version });
          }}
          onClose={() => setOpened(undefined)}
        />
      )}
    </section>
  );
}

/** Where a version came from, in words: an agent's proposal, another author's archive, or the operator's own import. */
function provenanceText(provenance: string): string {
  if (provenance.startsWith("chat:")) return "proposed by Tavi in a chat";
  if (provenance.startsWith("archive:")) return `imported from ${provenance.slice("archive:".length)}, another author's`;
  return `from ${provenance}`;
}

/**
 * One version: under *Waiting for review*, its name, where it came from and a *Review* button; in a skill's own list,
 * its version and state. The button carries the version's full id either way, for a screen reader and a search.
 */
function VersionLine({
  version,
  onOpen,
  review = false,
}: {
  readonly version: SkillVersion;
  readonly onOpen: () => void;
  readonly review?: boolean;
}) {
  const id = `${version.skillId}@${version.version}`;
  return (
    <span className="soul-skill-version">
      {review ? (
        <>
          <strong>{version.manifest.name}</strong>{" "}
        </>
      ) : null}
      <Button variant={review ? "secondary" : "ghost"} size="sm" onClick={onOpen}>
        {review ? (
          <>
            Review<span className="visually-hidden"> {id}</span>
          </>
        ) : (
          <>
            <span className="visually-hidden">{version.skillId}@</span>
            {version.version}
          </>
        )}
      </Button>
      <span className="muted">
        {" "}
        {review ? "" : `${version.reviewState} · `}
        {/* An agent's proposal waiting past 30 days: still yours to review, no longer counted against its cap. */}
        {provenanceText(version.provenance)}
        {skillProposalExpired(version, new Date().toISOString()) ? " (expired)" : ""}
      </span>
    </span>
  );
}

function SkillRow({
  entry,
  onOpen,
  onDecide,
}: {
  readonly entry: SkillEntry;
  readonly onOpen: (version: string) => void;
  readonly onDecide: (decision: SkillDecision, activeVersion: string | undefined) => Promise<void>;
}) {
  // A proposal is listed once, under *Waiting for review*, not again here.
  const decided = entry.versions.filter((version) => version.reviewState !== "proposed");
  return (
    <article className="soul-skill card-flat" aria-label={entry.name}>
      <header>
        <strong>{entry.name}</strong> {entry.skillId === entry.name ? null : <span className="muted">{entry.skillId}</span>}{" "}
        {entry.active === undefined ? <span className="muted">· not active</span> : <span>· active {entry.active}</span>}{" "}
        <span className="muted">· {skillUsageText(entry)}</span>
        {entry.unused ? <strong> · unused {SKILL_UNUSED_DAYS}+ days</strong> : null}
        {entry.active === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={() => void onDecide({ action: "disable", skillId: entry.skillId }, entry.active)}>
            Disable
          </Button>
        )}
      </header>
      <ul className="list-reset">
        {decided.map((version) => (
          <li key={version.version}>
            <VersionLine version={version} onOpen={() => onOpen(version.version)} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** One version's text, diffed against its parent, with the decisions it allows and the skill's history. */
function SkillVersionViewer({
  skillId,
  version,
  active,
  focused = false,
  onDecide,
  onOpen,
  onClose,
}: {
  readonly skillId: string;
  readonly version: string;
  readonly active: string | undefined;
  /** Opened from a chat's card: scrolled into view. */
  readonly focused?: boolean;
  readonly onDecide: (decision: SkillDecision, activeVersion: string | undefined) => Promise<void>;
  /** Open another version of this skill: the one an edit filed. */
  readonly onOpen: (version: string) => void;
  readonly onClose: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const today = todayIn(timeZone);
  const body = useLoaded(() => skillBody(client, workspaceId, skillId, version), [workspaceId, skillId, version]);
  const shown = useLoaded(() => showSkill(client, workspaceId, skillId), [workspaceId, skillId, version]);
  const [diffed, setDiffed] = useState(true);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // A version you did not write (an agent's proposal, another author's archive) asks once before it is approved, as
  // `tavi skills approve` asks for --yes.
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | undefined>(undefined);
  const formId = useId();
  const viewer = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) viewer.current?.scrollIntoView?.({ block: "start" });
  }, [focused]);
  const answer = body.data;
  const stored = answer?.version;
  const proposal = stored?.manifest.proposal;
  const trace = useLoaded<SkillsTraceAnswer | undefined>(
    async () =>
      proposal === undefined ? { ok: true as const, value: undefined } : await skillTrace(client, workspaceId, skillId, version),
    [workspaceId, skillId, version, proposal === undefined],
  );
  const untrusted = stored === undefined ? undefined : skillProposalUntrustedLine(stored);
  const editedInto = stored === undefined ? undefined : skillProposalEditedInto(stored, shown.data?.versions ?? []);
  // A version this workspace activated before can be rolled back to; the history says which.
  const everActive = new Set((shown.data?.history ?? []).flatMap((entry) => (entry.newVersion === undefined ? [] : [entry.newVersion])));
  // The version it follows, read with a second `body`: both together may not fit one answer.
  const parentVersion = answer?.parentVersion;
  const parent = useLoaded<SkillsBodyAnswer | undefined>(
    async () =>
      parentVersion === undefined ? { ok: true, value: undefined } : await skillBody(client, workspaceId, skillId, parentVersion),
    [workspaceId, skillId, parentVersion],
  );
  const parentText = parent.data?.text;
  // A version that widens the allowed-tools of the one it follows — else the active one, as an import names
  // no parent — or drops them is an escalation, shown before any decision.
  const since = parentVersion ?? active;
  const against = since === version ? undefined : shown.data?.versions.find((entry) => entry.version === since);
  const escalation =
    against === undefined || stored === undefined
      ? undefined
      : skillToolsEscalationText(against.manifest.allowedTools, stored.manifest.allowedTools);
  const diff = useMemo(
    () => (answer?.text === undefined || parentText === undefined || !diffed ? undefined : lineDiff(parentText, answer.text)),
    [answer?.text, parentText, diffed],
  );
  return (
    <section className="soul-skill-viewer card-flat" aria-label={`${skillId}@${version}`} ref={viewer}>
      <header>
        <h3>
          {skillId}@{version}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      {answer === undefined || stored === undefined ? (
        <Pending error={body.error} reload={body.reload} />
      ) : (
        <>
          <p className="muted">
            {stored.reviewState} · sha256 <span className="soul-skill-hash">{stored.contentHash}</span> · from {stored.provenance}
            {foreignProvenance(stored.provenance) ? " — written by another author: read it before approving" : ""}
          </p>
          {proposal === undefined ? null : (
            <p className="muted">
              Proposed by the agent{proposal.requested ? " when you asked" : " on its own"}, from task {proposal.taskId}: {proposal.note}
            </p>
          )}
          {/* Tavi cannot tell which words came from what the turn read, so the whole text is flagged with what it read. */}
          {untrusted === undefined ? null : (
            <p role="alert" className="skill-untrusted">
              <strong>{untrusted}</strong>
            </p>
          )}
          {editedInto === undefined ? null : (
            <p className="muted">
              Set aside by your edit:{" "}
              <Button variant="ghost" size="sm" onClick={() => onOpen(editedInto)}>
                open {skillId}@{editedInto}
              </Button>
            </p>
          )}
          {stored.manifest.compatibility === undefined ? null : (
            <p className="muted">Compatibility (as the package states it): {stored.manifest.compatibility}</p>
          )}
          {stored.manifest.allowedTools === undefined ? null : (
            <p className="muted">
              Declares the tools it uses (a ceiling, never a grant):{" "}
              {stored.manifest.allowedTools
                .map((name) => (taviToolForSkillName(name) === undefined ? `${name} (declared but not enforceable here)` : name))
                .join(", ")}
            </p>
          )}
          {escalation === undefined ? null : (
            <p role="alert" className="skill-escalation">
              <strong>{escalation}</strong> (since {since})
            </p>
          )}
          <div className="soul-skill-actions">
            {stored.reviewState === "proposed" ? (
              <>
                <Button
                  onClick={() =>
                    foreignProvenance(stored.provenance)
                      ? setConfirmingApprove(true)
                      : void onDecide({ action: "approve", skillId, version }, active)
                  }
                >
                  Approve
                </Button>
                <Button variant="ghost" onClick={() => void onDecide({ action: "reject", skillId, version }, active)}>
                  Reject
                </Button>
                {proposal !== undefined && stored.manifest.files === undefined && answer.text !== undefined ? (
                  <Button variant="ghost" disabled={busy} onClick={() => setEditing(answer.text)}>
                    Edit
                  </Button>
                ) : null}
                {proposal !== undefined ? (
                  <Button variant="ghost" disabled={busy} onClick={() => setFeedback("")}>
                    Regenerate with feedback
                  </Button>
                ) : null}
              </>
            ) : null}
            {stored.reviewState === "approved" && active !== version ? (
              everActive.has(version) ? (
                <Button onClick={() => void onDecide({ action: "rollback", skillId, version }, active)}>Roll back to this</Button>
              ) : (
                <Button onClick={() => void onDecide({ action: "activate", skillId, version }, active)}>Activate</Button>
              )
            ) : null}
            {answer.parentVersion === undefined || parentText === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={() => setDiffed((value) => !value)}>
                {diffed ? "Show the whole text" : `Show changes from ${answer.parentVersion}`}
              </Button>
            )}
          </div>
          {said === undefined ? null : (
            <p className={said.failed ? "failure" : "muted"} role="status">
              {said.text}
            </p>
          )}
          {editing === undefined ? null : (
            <form
              className="soul-skill-edit"
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                void editSkill(client, workspaceId, skillId, version, editing).then((outcome) => {
                  setBusy(false);
                  if (!outcome.ok) {
                    setSaid({ text: outcome.message, failed: true });
                    return;
                  }
                  setEditing(undefined);
                  onOpen(outcome.value.version.version);
                });
              }}
            >
              <Field id={`${formId}-edit`} label="Edit the proposed text: saved as a new version to review, following this one">
                <textarea rows={16} value={editing} onChange={(event) => setEditing(event.target.value)} />
              </Field>
              <div className="soul-skill-actions">
                <Button type="submit" disabled={busy || editing.trim() === "" || editing === answer.text}>
                  Save as a new version
                </Button>
                <Button variant="ghost" onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {feedback === undefined || stored === undefined ? null : (
            <form
              className="soul-skill-feedback"
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                void sendSkillFeedback(client, workspaceId, stored, feedback).then((outcome) => {
                  setBusy(false);
                  if (!outcome.ok) {
                    setSaid({ text: `The feedback was not sent: ${outcome.message}`, failed: true });
                    return;
                  }
                  setFeedback(undefined);
                  setSaid({
                    text: `Sent to chat ${outcome.value.taskId} as your message: the agent proposes it again there. This version still waits until you reject it.`,
                    failed: false,
                  });
                });
              }}
            >
              <Field id={`${formId}-feedback`} label="What should change? Sent to the chat it came from, for the agent to propose it again">
                <textarea
                  rows={4}
                  maxLength={SKILL_FEEDBACK_MAX_CHARS}
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              </Field>
              <div className="soul-skill-actions">
                <Button type="submit" disabled={busy || feedback.trim() === ""}>
                  Send feedback
                </Button>
                <Button variant="ghost" onClick={() => setFeedback(undefined)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {proposal === undefined ? null : <SkillTrace trace={trace.data} error={trace.error} />}
          {answer.text === undefined ? (
            <Empty>This version is not readable text.</Empty>
          ) : diff === undefined ? (
            <SkillText text={answer.text} />
          ) : (
            <pre className="soul-skill-body soul-skill-diff" {...textPanel("SKILL.md changes")}>
              {diff.map((line, index) => (
                <span key={index} className={`diff-${line.kind}`}>
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                  {line.text}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </>
      )}
      {confirmingApprove && stored !== undefined ? (
        <Confirm
          title={`Approve ${skillId}@${version}?`}
          message={`${proposal === undefined ? `Another author wrote it (${stored.provenance})` : `Tavi proposed it in chat ${proposal.taskId}`}, not you. Read it above before approving: once active, any chat can load it when the job comes up. This is tavi skills approve --yes.`}
          action="Yes, approve"
          onClose={() => setConfirmingApprove(false)}
          onConfirm={() => onDecide({ action: "approve", skillId, version }, active)}
        />
      ) : null}
      {shown.data === undefined || shown.data.history.length === 0 ? null : (
        <section aria-label="Activation history">
          <h4>History</h4>
          <ul className="list-reset">
            {shown.data.history.map((entry) => (
              <li key={entry.historyId} className="muted">
                <time dateTime={entry.at}>{instantLabel(entry.at, timeZone, today)}</time> · {skillActivationHistoryText(entry)} ·{" "}
                {entry.actor}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/** A proposal's source task, condensed: each tool call's name and short input, in order. */
function SkillTrace({ trace, error }: { readonly trace: SkillsTraceAnswer | undefined; readonly error: string | undefined }) {
  return (
    <details className="soul-skill-trace" open>
      <summary>What the task did{trace === undefined ? "" : ` (${trace.calls.length + trace.more} tool calls)`}</summary>
      {trace === undefined ? (
        <p className="muted">{error === undefined ? "Reading the task's tool calls…" : `The tool calls could not be read: ${error}`}</p>
      ) : trace.calls.length === 0 ? (
        <p className="muted">Its history keeps no tool calls.</p>
      ) : (
        <>
          <ol className="soul-skill-trace-calls">
            {trace.calls.map((call, index) => (
              <li key={index} data-status={call.status}>
                <code>{skillTraceLine(call)}</code>
              </li>
            ))}
          </ol>
          {trace.more > 0 ? <p className="muted">… and {trace.more} more</p> : null}
          {trace.partial ? <p className="muted">As far as the task's stored history keeps them.</p> : null}
        </>
      )}
    </details>
  );
}

/** A scrolling text panel: a named region a keyboard reaches, so its text can be scrolled without a pointer (WCAG 2.1.1). */
const textPanel = (label: string) => ({ tabIndex: 0, role: "region", "aria-label": label }) as const;

/** A version's text: a plain package as it is, a bundle (Agent Skills) file by file, SKILL.md first, a script as text it never runs. */
function SkillText({ text }: { readonly text: string }) {
  const files = skillPackageFiles(text);
  if (files === undefined || (files.length === 1 && files[0]?.path === "SKILL.md"))
    return (
      <pre className="soul-skill-body" {...textPanel("SKILL.md text")}>
        {files?.[0]?.text ?? text}
      </pre>
    );
  const ordered = skillBundleFilesForReview(files);
  return (
    <>
      {ordered.map((file) => (
        <section key={file.path} aria-label={file.path}>
          <h4>{file.path}</h4>
          {file.text === undefined ? (
            <p className="muted">Not text ({skillBundleFileBytes(file)} bytes).</p>
          ) : (
            <pre className="soul-skill-body" {...textPanel(`${file.path} text`)}>
              {file.text}
            </pre>
          )}
        </section>
      ))}
    </>
  );
}
