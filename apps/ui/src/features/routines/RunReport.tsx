import { routineFileSlug, type RoutineGrantView, type RoutineNewsReport } from "@tavi/contracts";

import type { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { saveFile } from "../../lib/download.js";
import { useT } from "../../lib/i18n.js";
import { when } from "../../lib/time.js";
import { attempt } from "../../lib/ipc.js";
import { Failure, Section } from "../../ui/Parts.js";
import { listed, readArtifact, webUrl, type RunInspection } from "./api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

type Runner = ReturnType<typeof useAction>["run"];
export function ResearchAuthority({
  policy,
  revocable,
  busy,
  onRevoke,
}: {
  readonly policy: RoutineGrantView;
  readonly revocable: boolean;
  readonly busy: string | undefined;
  readonly onRevoke: () => void;
}) {
  const t = useT();
  const narrowed = policy.narrowedTools ?? [];
  return (
    <div>
      <p>
        {t("routines.authority.grant", {
          grant: policy.grantId,
          policy: policy.policyRevision,
          revision: policy.revision,
          mode: policy.mode,
          network: policy.networkMode,
          state: policy.revokedAt
            ? t("routines.authority.revoked", {
                at: policy.revokedAt,
                reason: policy.revokedReason ?? t("routines.authority.noReason"),
              })
            : t("routines.authority.live"),
        })}
      </p>
      <p>
        {t("routines.authority.scope", {
          hosts: listed(policy.allowedHosts),
          tools: listed(policy.researchTools),
          destinations: listed(policy.destinationIds),
        })}
      </p>
      {narrowed.length > 0 ? <p>{t("routines.authority.narrowed", { tools: narrowed.join(", ") })}</p> : null}
      {revocable ? (
        <Button disabled={busy !== undefined} onClick={onRevoke}>
          {t("routines.authority.revoke")}
        </Button>
      ) : null}
    </div>
  );
}
/** The published report: downloads, and the report itself read (and verified) in place. */
export function RunReport({
  runId,
  publication,
  busy,
  run,
  timeZone,
}: {
  readonly runId: string;
  readonly publication: RunInspection["publication"];
  /** The workspace's zone, the one its coverage is said in. */
  readonly timeZone: string | undefined;
  readonly busy: string | undefined;
  readonly run: Runner;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const artifactId = publication?.reportArtifactId;
  const { data: report, error: reportError } = useLoaded(
    () =>
      attempt(async () => {
        const { bytes } = await readArtifact(client, workspaceId, runId, "json");
        return JSON.parse(new TextDecoder().decode(bytes)) as RoutineNewsReport;
      }),
    [artifactId, client, workspaceId, runId],
    { enabled: artifactId !== undefined },
  );

  const download = (kind: "json" | "pdf") =>
    run("download", () =>
      attempt(async () => {
        const { bytes, type } = await readArtifact(client, workspaceId, runId, kind);
        saveFile(bytes, type, `${routineFileSlug(report?.title ?? "")}-${runId}.${kind}`);
        return t("routines.report.downloaded");
      }),
    );

  return (
    <Section title={t("routines.report.title")}>
      {publication ? (
        <div className="actions">
          <Button disabled={busy !== undefined} onClick={() => void download("json")}>
            {t("routines.report.downloadJson")}
          </Button>
          {publication.pdfArtifactId ? (
            <Button disabled={busy !== undefined} onClick={() => void download("pdf")}>
              {t("routines.report.downloadPdf")}
            </Button>
          ) : null}
          {publication.pdfError ? <p>{publication.pdfError}</p> : null}
        </div>
      ) : (
        <p className="muted">{t("routines.report.none")}</p>
      )}
      <Failure message={reportError || undefined} />
      {report ? <ReportView report={report} timeZone={timeZone} /> : null}
    </Section>
  );
}
function ReportView({ report, timeZone }: { readonly report: RoutineNewsReport; readonly timeZone: string | undefined }) {
  const t = useT();
  return (
    <div className="routine-report">
      {report.quiet ? (
        <p>{t("routines.report.quiet")}</p>
      ) : (
        (report.stories ?? []).map((story) => (
          <article key={story.storyId}>
            <h4>{story.title}</h4>
            {(story.claims ?? []).map((claim, index) => {
              const source = (report.sources ?? []).find((item) => item.sourceId === claim.sourceId);
              return (
                <p key={index}>
                  {claim.text}{" "}
                  {source?.canonicalUrl.startsWith("https://") ? <SourceLink url={source.canonicalUrl} label={source.publisher} /> : null}
                </p>
              );
            })}
            {(story.caveats ?? []).map((caveat) => (
              <p key={caveat}>{caveat}</p>
            ))}
          </article>
        ))
      )}
      <p>{t("routines.report.coverage", { from: when(report.coverage.from, timeZone), to: when(report.coverage.to, timeZone) })}</p>
      {(report.coverage.gaps ?? []).map((gap) => (
        <p key={gap}>{gap}</p>
      ))}
    </div>
  );
}
/** A source's publisher, linked only when its URL is a web address. */
export function SourceLink({ url, label }: { readonly url: string; readonly label: string }) {
  const href = webUrl(url);
  return href === undefined ? (
    <span>{label}</span>
  ) : (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}
