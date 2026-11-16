import { routineFileSlug, type RoutineGrantView, type RoutineNewsReport } from "@tavi/contracts";

import type { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { saveFile } from "../../lib/download.js";
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
  const narrowed = policy.narrowedTools ?? [];
  return (
    <div>
      <p>
        Grant {policy.grantId} · policy revision {policy.policyRevision} · pinned from revision {policy.revision} · {policy.mode} · egress{" "}
        {policy.networkMode}. {policy.revokedAt ? `Revoked ${policy.revokedAt}: ${policy.revokedReason ?? "no reason recorded"}.` : "Live."}
      </p>
      <p>
        Fetch hosts: {listed(policy.allowedHosts)}. Research tools: {listed(policy.researchTools)}. Delivery destinations:{" "}
        {listed(policy.destinationIds)}.
      </p>
      {narrowed.length > 0 ? <p>Tools the revision declared that no research path exposes: {narrowed.join(", ")}.</p> : null}
      {revocable ? (
        <Button disabled={busy !== undefined} onClick={onRevoke}>
          Revoke this run's grant
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
        return "Report downloaded";
      }),
    );

  return (
    <Section title="Report">
      {publication ? (
        <div className="actions">
          <Button disabled={busy !== undefined} onClick={() => void download("json")}>
            Download report JSON
          </Button>
          {publication.pdfArtifactId ? (
            <Button disabled={busy !== undefined} onClick={() => void download("pdf")}>
              Download PDF
            </Button>
          ) : null}
          {publication.pdfError ? <p>{publication.pdfError}</p> : null}
        </div>
      ) : (
        <p className="muted">No report published.</p>
      )}
      <Failure message={reportError || undefined} />
      {report ? <ReportView report={report} timeZone={timeZone} /> : null}
    </Section>
  );
}
function ReportView({ report, timeZone }: { readonly report: RoutineNewsReport; readonly timeZone: string | undefined }) {
  return (
    <div className="routine-report">
      {report.quiet ? (
        <p>No qualifying news verified.</p>
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
      <p>
        Coverage: {when(report.coverage.from, timeZone)} — {when(report.coverage.to, timeZone)}
      </p>
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
