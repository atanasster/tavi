import { useEffect, useRef, useState } from "react";
import type { RoutineLedgerVerdict, RoutineReadiness } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { listed, networkModeLabel, routineStep } from "./api.js";
import { Failure, Section, Summary } from "../../ui/Parts.js";
import { useT } from "../../lib/i18n.js";
import { when } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * What the routine needs to run and deliver, beside whether its ledger's local
 * chain verifies. Readiness is checked as it opens when `auto` (something
 * blocks the routine), and again each time `asked` moves.
 */
export function RoutineChecks({
  routineId,
  timeZone,
  auto,
  asked,
}: {
  readonly routineId: string;
  readonly timeZone: string | undefined;
  readonly auto: boolean;
  readonly asked: number;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const { busy, note, run } = useAction(() => {});
  const [readiness, setReadiness] = useState<RoutineReadiness>();
  const [verdict, setVerdict] = useState<RoutineLedgerVerdict>();
  const check = () =>
    run("readiness", () =>
      routineStep<RoutineReadiness>(client, workspaceId, { action: "readiness", routineId }, (answer) => {
        setReadiness(answer);
        return undefined;
      }),
    );
  // `check` is rebuilt each render; a blocked routine arriving, or a notice's ask, is what checks again.
  const latestCheck = useRef(check);
  latestCheck.current = check;
  useEffect(() => {
    if (auto || asked > 0) void latestCheck.current();
  }, [auto, asked]);
  const verify = () =>
    run("verify", () =>
      routineStep<RoutineLedgerVerdict>(client, workspaceId, { action: "verify", routineId }, (answer) => {
        setVerdict(answer);
        return undefined;
      }),
    );

  return (
    <Section title={t("routines.checks.health")} anchor="health">
      <Failure message={note || undefined} alert={false} />
      <div className="health-grid">
        <div>
          <h4>{t("routines.checks.readiness")}</h4>
          {readiness ? (
            <ReadinessReport readiness={readiness} timeZone={timeZone} />
          ) : (
            <p className="muted">{t("routines.checks.readinessHint")}</p>
          )}
          <Button size="sm" disabled={busy !== undefined} onClick={() => void check()}>
            {t("routines.status.checkReadiness")}
          </Button>
        </div>
        <div>
          <h4>{t("routines.checks.ledger")}</h4>
          {verdict ? (
            <>
              <p role="status">
                {t(verdict.valid ? "routines.checks.intact" : "routines.checks.broken", {
                  events: t("routines.checks.events", { count: verdict.events }),
                  head: verdict.headHash.slice(0, 16),
                  pruned: t("routines.checks.pruned", { count: verdict.prunedDetails }),
                })}
              </p>
              <p className="muted">{verdict.limitation}</p>
            </>
          ) : (
            <p className="muted">{t("routines.checks.ledgerHint")}</p>
          )}
          <Button size="sm" disabled={busy !== undefined} onClick={() => void verify()}>
            {t("routines.checks.verify")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Research and delivery health apart, and a stale heartbeat reported as unknown, never as offline. */
function ReadinessReport({ readiness, timeZone }: { readonly readiness: RoutineReadiness; readonly timeZone: string | undefined }) {
  const t = useT();
  const { revision, research, delivery, owner, renderer, schedule } = readiness;
  const ownerState =
    owner.state === "live"
      ? t("routines.checks.heartbeatLive")
      : owner.state === "stale"
        ? t("routines.checks.heartbeatStale", { seconds: Math.round((owner.heartbeatAgeMs ?? 0) / 1000) })
        : t("routines.checks.heartbeatNone");
  const rendererState =
    renderer === null
      ? t("routines.checks.unknown")
      : renderer.available
        ? t("routines.checks.rendererAvailable", { provider: renderer.provider })
        : t("routines.checks.rendererUnavailable");
  const active = revision.active ?? t("routines.checks.none");
  return (
    <Summary
      items={[
        [
          t("routines.checks.revision"),
          revision.candidate
            ? t("routines.checks.revisionCandidate", {
                active,
                latest: revision.latest,
                candidate: revision.candidate.revision,
                evaluation: revision.candidate.evaluation,
                detail: revision.candidate.detail,
              })
            : t("routines.checks.revisionLine", { active, latest: revision.latest }),
        ],
        [
          t("routines.checks.research"),
          t("routines.checks.researchLine", {
            state: research.ready ? t("routines.checks.ready") : t("routines.checks.blockedBy", { reason: String(research.blockedBy) }),
            network: networkModeLabel(research.networkMode),
            hosts: listed(research.hosts),
            tools: listed(research.tools),
          }),
        ],
        [
          t("routines.checks.delivery"),
          (delivery.targets ?? []).length === 0
            ? t("routines.checks.noDestination")
            : delivery.authorized
              ? t("routines.checks.authorized")
              : t("routines.checks.deliveryBlocked", { reason: delivery.blockedBy ?? t("routines.checks.unknown") }),
        ],
        [t("routines.checks.owner"), t("routines.checks.ownerLine", { owner: ownerState, renderer: rendererState })],
        [
          t("routines.checks.nextRun"),
          t("routines.checks.nextRunLine", {
            when: schedule?.nextRunAt ? when(schedule.nextRunAt, schedule.timezone ?? timeZone) : t("routines.checks.none"),
            zone: schedule?.timezone ?? t("routines.checks.noZone"),
          }),
        ],
      ]}
    />
  );
}
