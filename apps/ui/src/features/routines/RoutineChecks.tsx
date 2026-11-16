import { useEffect, useRef, useState } from "react";
import type { RoutineLedgerVerdict, RoutineReadiness } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { useAction } from "../../hooks/use-action.js";
import { listed, routineStep } from "./api.js";
import { Failure, Section, Summary } from "../../ui/Parts.js";
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
    <Section title="Health">
      <Failure message={note || undefined} alert={false} />
      <div className="health-grid">
        <div>
          <h4>Readiness</h4>
          {readiness ? (
            <ReadinessReport readiness={readiness} timeZone={timeZone} />
          ) : (
            <p className="muted">Whether research, delivery and the owner are ready for the next run.</p>
          )}
          <Button size="sm" disabled={busy !== undefined} onClick={() => void check()}>
            Check readiness
          </Button>
        </div>
        <div>
          <h4>Ledger integrity</h4>
          {verdict ? (
            <>
              <p role="status">
                {verdict.valid ? "The ledger's local chain is intact" : "The ledger's local chain does not verify"} over{" "}
                {plural(verdict.events, "event")}; head {verdict.headHash.slice(0, 16)}…; {plural(verdict.prunedDetails, "pruned detail")}.
              </p>
              <p className="muted">{verdict.limitation}</p>
            </>
          ) : (
            <p className="muted">Whether the routine's recorded history still hashes into one chain.</p>
          )}
          <Button size="sm" disabled={busy !== undefined} onClick={() => void verify()}>
            Verify this routine's ledger
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Research and delivery health apart, and a stale heartbeat reported as unknown, never as offline. */
function ReadinessReport({ readiness, timeZone }: { readonly readiness: RoutineReadiness; readonly timeZone: string | undefined }) {
  const { revision, research, delivery, owner, renderer, schedule } = readiness;
  const ownerState =
    owner.state === "live"
      ? "heartbeat is current"
      : owner.state === "stale"
        ? `heartbeat is ${Math.round((owner.heartbeatAgeMs ?? 0) / 1000)}s old, so the owner's state is unknown`
        : "no heartbeat has been written";
  const rendererState = renderer === null ? "unknown" : renderer.available ? `available (${renderer.provider})` : "unavailable";
  return (
    <Summary
      items={[
        [
          "Revision",
          `${revision.active ?? "none"} active, ${revision.latest} latest${revision.candidate ? `; candidate ${revision.candidate.revision} is ${revision.candidate.evaluation} — ${revision.candidate.detail}` : ""}`,
        ],
        [
          "Research",
          `${research.ready ? "ready" : `blocked by ${research.blockedBy}`} · ${research.networkMode} egress · hosts ${listed(research.hosts)} · tools ${listed(research.tools)}`,
        ],
        [
          "Delivery",
          (delivery.targets ?? []).length === 0
            ? "no destination configured"
            : delivery.authorized
              ? "authorized"
              : `blocked (${delivery.blockedBy ?? "unknown"})`,
        ],
        ["Owner", `${ownerState} · renderer ${rendererState}`],
        [
          "Next run",
          `${schedule?.nextRunAt ? when(schedule.nextRunAt, schedule.timezone ?? timeZone) : "none"} (${schedule?.timezone ?? "n/a"})`,
        ],
      ]}
    />
  );
}
