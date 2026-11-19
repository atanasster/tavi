import { useEffect, useState } from "react";

import type { WorkspaceSettingsAnswer } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import type { Outcome } from "../../lib/ipc.js";
import { PageHead, PageNote, Pending } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { BrowserProfile, NoThumbnailHosts } from "./BrowserSettings.js";
import { LoadError } from "./FormParts.js";
import { VideoTools, FlightSearch, SkillSuggestions, TaskSummaries, TasksHomeChoice, ToolDeferralChoice } from "./GeneralToolSettings.js";
import { ResetInstance } from "./ResetInstance.js";
import { timeZoneOptions, workspaceSettingsActions } from "./workspace-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { workspaceWords } from "./common.js";

/**
 * Settings → General: the workspace timezone,
 * task summaries and the hosts whose pages get no browser
 * thumbnail, the agent's browser profile, then resetting the whole instance. The summaries switch is not under Models; it
 * is a workspace setting, and General is where those live. A part an older
 * owner does not answer for is left out rather than shown with a guess.
 *
 * The zone is the owner's setting, not this browser's: the agent states the
 * current local time in it, and "today" means the same day here and in a chat
 * on another device. Unset, the owner host's zone applies, which the answer
 * names so the page never guesses it from the browser.
 */
export function GeneralSettings({
  onReset,
  onRunSetup,
}: {
  /** The owner accepted a reset: the page starts over once it is back. */
  readonly onReset?: (() => void) | undefined;
  /** Setup's every step again (`/welcome?all=1`, the canvas's `tavi setup`); absent where the owner offers no setup. */
  readonly onRunSetup?: (() => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const { data, error, loading, reload } = useLoaded<WorkspaceSettingsAnswer>(() => workspaceSettingsActions.load(client, workspaceId));
  const { busy, note, tone, run } = useAction(reload);
  const [draft, setDraft] = useState<string | undefined>();
  // Each answer resets the picker to what is in effect, so after a save (or a
  // refused one) it shows the owner's value rather than the last pick.
  useEffect(() => setDraft(data?.effective.timezone), [data]);

  const heading = (
    <PageHead
      className="settings-head"
      title="General"
      description={
        <>
          How {workspaceWords(workspaceId)} works: its timezone, summaries, browser, video and the other settings below. Each also has a{" "}
          <Command>tavi config</Command> command, named with it.
        </>
      }
    />
  );
  if (data === undefined || draft === undefined) {
    return (
      <section className="settings" aria-label="general">
        {heading}
        {loading || error !== undefined ? <Pending error={error} reload={reload} className="notice" status /> : null}
      </section>
    );
  }
  const stored = data.settings.timezone;
  const off = (pluginId: string): boolean => data.disabledPlugins?.includes(pluginId) === true;
  // Unchanged means the zone in force: with nothing stored, choosing the host zone is not a change.
  const unchanged = draft === (stored ?? data.effective.timezone);
  return (
    <section className="settings" aria-label="general">
      {heading}
      {error === undefined ? null : <LoadError error={error} reload={reload} />}
      <PageNote tone={tone} note={note} />
      {onRunSetup === undefined ? null : (
        <>
          <h2>Setup</h2>
          <p className="muted">
            Go through every setup step again: the model, about you, apps, channels, search and first ideas. What is set up stays as it is
            unless you change it.
          </p>
          <p className="actions">
            <Button onClick={onRunSetup}>Run setup again</Button>
          </p>
        </>
      )}
      <h2>Timezone</h2>
      <p className="muted">
        The zone the agent tells the time in, and reads &ldquo;tomorrow&rdquo; or &ldquo;next Monday at 10&rdquo; against. Or use{" "}
        <Command>tavi config set workspace.timezone Europe/Berlin</Command>.
      </p>
      <p>
        <strong>{data.effective.timezone}</strong>{" "}
        <span className="muted">
          {stored === undefined
            ? "(the host zone, used until you choose one)"
            : data.hostTimezone === stored
              ? "(set; also the host zone)"
              : `(set; the host zone is ${data.hostTimezone})`}
        </span>
      </p>
      <form
        className="actions timezone-actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (unchanged) return;
          void run("set", () => workspaceSettingsActions.setTimezone(client, workspaceId, draft, data.revision));
        }}
      >
        <Select
          aria-label="timezone"
          value={draft}
          searchable
          searchPlaceholder="Search zones…"
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy !== undefined}
        >
          {timeZoneOptions(draft).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        <Button variant="primary" type="submit" disabled={busy !== undefined || unchanged}>
          {busy === "set" ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== undefined || stored === undefined}
          onClick={() => void run("unset", () => workspaceSettingsActions.useHostTimezone(client, workspaceId, data.revision))}
        >
          Use host zone
        </Button>
      </form>
      {/* A setting only a turned-off plugin reads changes nothing: not shown while it is off. */}
      {data.effective.activitySummaries === undefined ? null : (
        <TaskSummaries answer={data} on={data.effective.activitySummaries} busy={busy} run={run} />
      )}
      {data.effective.browserNoThumbnailHosts === undefined || off("tavi.browser") ? null : (
        <NoThumbnailHosts answer={data} hosts={data.effective.browserNoThumbnailHosts} busy={busy} run={run} />
      )}
      {data.effective.travelFlightSearch === undefined || off("tavi.flights") ? null : <FlightSearch answer={data} busy={busy} run={run} />}
      {data.effective.skillSuggestions === undefined ? null : <SkillSuggestions answer={data} busy={busy} run={run} />}
      {data.effective.toolDeferral === undefined ? null : <ToolDeferralChoice answer={data} busy={busy} run={run} />}
      {data.effective.tasksHome === undefined ? null : <TasksHomeChoice answer={data} busy={busy} run={run} />}
      {data.effective.redactToolResults === undefined ? null : <ToolResultRedaction answer={data} busy={busy} run={run} />}
      {data.effective.videoEnabled === undefined || off("tavi.video") ? null : <VideoTools answer={data} busy={busy} run={run} />}
      {off("tavi.browser") ? null : <BrowserProfile busy={busy} run={run} />}
      <ResetInstance onReset={onReset} />
    </section>
  );
}

/**
 * Masking credential shapes in tool results: on by
 * default, and a write that would put a placeholder back is refused either way.
 */
function ToolResultRedaction({
  answer,
  busy,
  run,
}: {
  readonly answer: WorkspaceSettingsAnswer;
  readonly busy: string | undefined;
  readonly run: (key: string, work: () => Promise<Outcome<string | undefined>>) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  return (
    <>
      <h2>Secrets in tool results</h2>
      <p>
        Keys and tokens a tool returns &mdash; AWS keys, GitHub and Slack tokens, private keys, JWTs &mdash; are masked as{" "}
        <code>[redacted:&lt;kind&gt;]</code> before the model, the archive or this page sees them, and a write that would put a placeholder
        back into a file is refused. Or use <Command>tavi config set tools.redactResults off</Command>.
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label="mask secrets in tool results"
            checked={answer.effective.redactToolResults !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("redact", () =>
                workspaceSettingsActions.setRedactToolResults(client, workspaceId, event.target.checked, answer.revision),
              )
            }
          />{" "}
          Mask secrets in tool results
        </label>
      </p>
    </>
  );
}
