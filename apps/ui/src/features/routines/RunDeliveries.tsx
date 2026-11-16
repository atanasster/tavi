import { useState } from "react";

import { when } from "../../lib/time.js";
import { Section, StatusBadge } from "../../ui/Parts.js";
import { operationKey, type routineStep, type RunInspection } from "./api.js";
import { Button } from "../../ui/Button.js";

/** Each delivery with its receipts; a resend needs the duplicate risk acknowledged, a target resume does not. */
export function Deliveries({
  value,
  routineId,
  busy,
  change,
  timeZone,
}: {
  readonly value: RunInspection;
  readonly routineId: string;
  readonly timeZone: string | undefined;
  readonly busy: string | undefined;
  readonly change: (key: string, request: Parameters<typeof routineStep>[2], done: string) => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const deliveries = value.deliveries ?? [];
  return (
    <Section title="Delivery and receipts">
      {deliveries.length === 0 ? (
        <p className="muted">No delivery requested.</p>
      ) : (
        <>
          <label className="acknowledge">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand
            resending may deliver a duplicate.
          </label>
          <ul className="item-list list-reset">
            {deliveries.map((job) => {
              const health = value.deliveryHealth?.[job.data.targetId];
              return (
                <li key={job.jobId} className="item-row delivery-row">
                  <div className="item-main">
                    <span className="item-title-text">
                      {job.data.target.label}
                      {job.data.text === undefined ? "" : " · sent as text (no PDF)"}
                    </span>
                    <span className="item-meta meta-sm">
                      Provider message IDs: {job.data.providerMessageIds?.join(", ") || "none recorded"} · {health?.failures ?? 0}{" "}
                      consecutive failures; blocked since {health?.blockedSince ?? "not blocked"}
                    </span>
                    <span className="item-meta meta-sm">
                      Updated {when(job.updatedAt, timeZone)} · earliest send {when(job.notBefore, timeZone)} · expires{" "}
                      {when(job.expiresAt, timeZone)}
                    </span>
                    {job.data.error ? <span className="role-problem">{job.data.error}</span> : null}
                  </div>
                  <StatusBadge status={job.status} />
                  <div className="item-actions">
                    <Button
                      size="sm"
                      disabled={!acknowledged || busy !== undefined}
                      onClick={() =>
                        void change(
                          "resend",
                          { action: "retry_delivery", jobId: job.jobId, operationKey: operationKey(), acknowledgeDuplicateRisk: true },
                          "Resend recorded using the original artifact and destination",
                        )
                      }
                    >
                      {job.data.text === undefined ? "Resend original PDF" : "Resend original message"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy !== undefined}
                      onClick={() =>
                        void change(
                          "resume-delivery",
                          { action: "resume_delivery", routineId, targetId: job.data.targetId },
                          "Delivery target resumed; existing pending jobs will be reconsidered",
                        )
                      }
                    >
                      Resume this delivery target
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}
