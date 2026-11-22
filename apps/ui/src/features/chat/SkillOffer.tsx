import {
  SKILL_DISMISSED_TOPIC_DAYS,
  SKILLS_PROPOSE_TOOL_ID,
  skillProposalEditedInto,
  skillProposedOf,
  type SkillVersion,
} from "@tavi/contracts";
import { useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import { useT } from "../../lib/i18n.js";
import { readStored, writeStored } from "../../lib/storage.js";
import { Button } from "../../ui/Button.js";
import { Failure } from "../../ui/Parts.js";
import { decideSkill, listSkills, requestSkillFocus } from "../center/skills-api.js";
import { useWorkspace } from "../shell/Workspace.js";
import type { CanvasRun } from "./store/types.js";

/**
 * The end-of-turn card for a skill the agent offered on its own
 * (`skills.propose` with `requested: false`): "Save how I did this as a
 * skill?", with *Review* (the proposal, opened in Soul & memory → Skills),
 * *Not now* (it keeps waiting there; this browser folds the card) and
 * *Don't suggest this* (rejected, which keeps its topic from being offered
 * again for 30 days). A chat has at most one such offer, so the card is found
 * from the chat's skills (`chat:<taskId>`, unrequested) — a saved turn's
 * tool line has no output to name it — and placed after the turn whose call
 * filed it. The card reads the skill's state each time, so one decided in
 * the Center shows as decided.
 */

/** Whether a turn's `skills.propose` call completed: where an offer's card may go. */
export function proposesSkill(run: Pick<CanvasRun, "run">): boolean {
  return run.run.transcript.some(
    (entry) => entry.kind === "tool" && entry.toolName === SKILLS_PROPOSE_TOOL_ID && entry.status === "completed",
  );
}

/** The chat's unasked offer: its first unrequested proposal (an edit of it follows it, `skillProposalEditedInto`). */
export function chatSkillOffer(versions: readonly SkillVersion[], taskId: string): SkillVersion | undefined {
  return versions
    .filter((version) => version.provenance === `chat:${taskId}` && version.manifest.proposal?.requested === false)
    .sort((a, b) => (a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : 0))[0];
}

/**
 * The turn an offer's card follows: the first whose completed
 * `skills.propose` names it, or — a saved turn, whose tool lines carry no
 * output — the first such call in a turn that ended after it was filed.
 */
export function skillOfferHost(
  runs: readonly Pick<CanvasRun, "run" | "lastAt">[],
  offer: Pick<SkillVersion, "skillId" | "version" | "importedAt">,
): number | undefined {
  for (const [index, run] of runs.entries()) {
    const calls = run.run.transcript.flatMap((entry) =>
      entry.kind === "tool" && entry.toolName === SKILLS_PROPOSE_TOOL_ID && entry.status === "completed" ? [entry] : [],
    );
    if (calls.length === 0) continue;
    const named = calls.map((call) => skillProposedOf(call.output));
    if (named.some((proposed) => proposed?.skillId === offer.skillId && proposed.version === offer.version)) return index;
    if (named.some((proposed) => proposed === undefined) && (run.lastAt === undefined || run.lastAt >= offer.importedAt)) return index;
  }
  return undefined;
}

/** The newest version an offer was edited into, or the offer itself. */
function latestOf(offer: SkillVersion, versions: readonly SkillVersion[]): SkillVersion {
  let current = offer;
  for (let hops = 0; hops < versions.length; hops += 1) {
    const next = skillProposalEditedInto(current, versions);
    const found =
      next === undefined ? undefined : versions.find((version) => version.skillId === current.skillId && version.version === next);
    if (found === undefined) return current;
    current = found;
  }
  return current;
}

const laterKey = (version: Pick<SkillVersion, "skillId" | "version">): string =>
  `tavi.skill-offer.later:${version.skillId}@${version.version}`;

export function SkillOfferCard({
  taskId,
  runs,
  index,
  revision,
  connected = true,
  onReview,
}: {
  /** The chat whose turn it follows. */
  readonly taskId: string;
  readonly runs: readonly Pick<CanvasRun, "run" | "lastAt">[];
  /** This turn's place among `runs`: the card shows only after the turn that filed the offer. */
  readonly index: number;
  /** The workspace's skills revision: read again when it moves. */
  readonly revision?: number;
  readonly connected?: boolean;
  /** Open Soul & memory, where the proposal opens; absent where the Center has no such page. */
  readonly onReview?: (() => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const listed = useLoaded(() => listSkills(client, workspaceId), [workspaceId, taskId, revision]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState<readonly string[]>([]);
  const versions = listed.data?.versions ?? [];
  const offer = chatSkillOffer(versions, taskId);
  if (offer === undefined || skillOfferHost(runs, offer) !== index) return null;
  const latest = latestOf(offer, versions);
  const name = latest.manifest.name;
  const waiting = latest.reviewState === "proposed";
  const folded = later.includes(laterKey(latest)) || readStored(laterKey(latest)) !== undefined;
  const review =
    onReview === undefined
      ? undefined
      : () => {
          requestSkillFocus({ skillId: latest.skillId, version: latest.version });
          onReview();
        };
  const dismiss = (): void => {
    setBusy(true);
    void decideSkill(client, workspaceId, { action: "reject", skillId: latest.skillId, version: latest.version }, undefined).then(
      (outcome) => {
        setBusy(false);
        setFailure(outcome.ok ? undefined : outcome.message);
        listed.reload();
      },
    );
  };
  const heading = !waiting
    ? latest.reviewState === "approved"
      ? t("chat.skillOffer.saved", { name })
      : t("chat.skillOffer.dismissed", { count: SKILL_DISMISSED_TOPIC_DAYS, name })
    : folded
      ? t("chat.skillOffer.waiting", { name })
      : t("chat.skillOffer.ask");
  return (
    <article
      className="memory-card skill-offer"
      aria-label={t("chat.skillOffer.label", { heading })}
      data-skill-offer={`${latest.skillId}@${latest.version}`}
    >
      <p className="memory-card-heading" role="status" aria-live="polite">
        {heading}
      </p>
      {waiting && !folded ? (
        <>
          <p className="memory-card-title">{name}</p>
          {latest.manifest.description === undefined ? null : <p className="memory-card-excerpt">{latest.manifest.description}</p>}
        </>
      ) : null}
      {waiting ? (
        <div className="memory-card-actions">
          {review === undefined ? null : (
            <Button size="sm" onClick={review}>
              {t("chat.skillOffer.review")}
            </Button>
          )}
          {folded ? null : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  writeStored(laterKey(latest), "1");
                  setLater((keys) => [...keys, laterKey(latest)]);
                }}
              >
                {t("chat.skillOffer.later")}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !connected} onClick={dismiss}>
                {t("chat.skillOffer.dismiss")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      <Failure message={failure} />
    </article>
  );
}
