import { useState } from "react";

import { useT } from "../../lib/i18n.js";
import { when } from "../../lib/time.js";
import { Section, StatusBadge } from "../../ui/Parts.js";
import { operationKey, type routineStep, type RunInspection } from "./api.js";
import { RowAction } from "../../ui/RowAction.js";

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
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);
  const deliveries = value.deliveries ?? [];
  return (
    <Section title={t("routines.deliveries.title")}>
      {deliveries.length === 0 ? (
        <p className="muted">{t("routines.deliveries.none")}</p>
      ) : (
        <>
          <label className="acknowledge">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{" "}
            {t("routines.deliveries.acknowledge")}
          </label>
          <ul className="item-list list-reset">
            {deliveries.map((job) => {
              const health = value.deliveryHealth?.[job.data.targetId];
              return (
                <li key={job.jobId} className="item-row delivery-row">
                  <div className="item-main">
                    <span className="item-title-text">
                      {job.data.target.label}
                      {job.data.text === undefined ? "" : ` · ${t("routines.deliveries.sentAsText")}`}
                    </span>
                    <span className="item-meta meta-sm">
                      {t("routines.deliveries.health", {
                        ids: job.data.providerMessageIds?.join(", ") || t("routines.deliveries.noIds"),
                        count: health?.failures ?? 0,
                        since: health?.blockedSince ?? t("routines.deliveries.notBlocked"),
                      })}
                    </span>
                    <span className="item-meta meta-sm">
                      {t("routines.deliveries.times", {
                        updated: when(job.updatedAt, timeZone),
                        earliest: when(job.notBefore, timeZone),
                        expires: when(job.expiresAt, timeZone),
                      })}
                    </span>
                    {job.data.error ? <span className="role-problem">{job.data.error}</span> : null}
                  </div>
                  <StatusBadge status={job.status} />
                  <div className="item-actions">
                    <RowAction
                      disabled={!acknowledged || busy !== undefined}
                      onClick={() =>
                        void change(
                          "resend",
                          { action: "retry_delivery", jobId: job.jobId, operationKey: operationKey(), acknowledgeDuplicateRisk: true },
                          t("routines.deliveries.resendDone"),
                        )
                      }
                    >
                      {t(job.data.text === undefined ? "routines.deliveries.resendPdf" : "routines.deliveries.resendMessage")}
                    </RowAction>
                    <RowAction
                      disabled={busy !== undefined}
                      onClick={() =>
                        void change(
                          "resume-delivery",
                          { action: "resume_delivery", routineId, targetId: job.data.targetId },
                          t("routines.deliveries.resumeDone"),
                        )
                      }
                    >
                      {t("routines.deliveries.resume")}
                    </RowAction>
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
