import { useEffect, useState } from "react";

import type { WorkspaceSettingsAnswer } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useT } from "../../lib/i18n.js";
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
import { withParts } from "../welcome/WelcomeStepParts.js";

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
  const t = useT();
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
      title={t("settings.general.title")}
      description={withParts(t("settings.general.description", { workspace: workspaceWords(workspaceId) }), {
        command: <Command>tavi config</Command>,
      })}
    />
  );
  if (data === undefined || draft === undefined) {
    return (
      <section className="settings" aria-label={t("settings.general.region")}>
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
    <section className="settings" aria-label={t("settings.general.region")}>
      {heading}
      {error === undefined ? null : <LoadError error={error} reload={reload} />}
      <PageNote tone={tone} note={note} />
      {onRunSetup === undefined ? null : (
        <>
          <h2>{t("settings.general.setup")}</h2>
          <p className="muted">{t("settings.general.setupHint")}</p>
          <p className="actions">
            <Button onClick={onRunSetup}>{t("settings.general.runSetup")}</Button>
          </p>
        </>
      )}
      <h2>{t("settings.general.timezone")}</h2>
      <p className="muted">
        {withParts(t("settings.general.timezoneHint"), { command: <Command>tavi config set workspace.timezone Europe/Berlin</Command> })}
      </p>
      <p>
        <strong>{data.effective.timezone}</strong>{" "}
        <span className="muted">
          {stored === undefined
            ? t("settings.general.hostZone")
            : data.hostTimezone === stored
              ? t("settings.general.setAlsoHost")
              : t("settings.general.setHostIs", { host: data.hostTimezone })}
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
          aria-label={t("settings.general.timezoneLabel")}
          value={draft}
          searchable
          searchPlaceholder={t("settings.general.searchZones")}
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
          {busy === "set" ? t("ui.parts.saving") : t("settings.action.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== undefined || stored === undefined}
          onClick={() => void run("unset", () => workspaceSettingsActions.useHostTimezone(client, workspaceId, data.revision))}
        >
          {t("settings.general.useHostZone")}
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
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  return (
    <>
      <h2>{t("settings.redact.title")}</h2>
      <p>
        {withParts(t("settings.redact.body"), {
          placeholder: <code>[redacted:&lt;kind&gt;]</code>,
          command: <Command>tavi config set tools.redactResults off</Command>,
        })}
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            aria-label={t("settings.redact.label")}
            checked={answer.effective.redactToolResults !== false}
            disabled={busy !== undefined}
            onChange={(event) =>
              void run("redact", () =>
                workspaceSettingsActions.setRedactToolResults(client, workspaceId, event.target.checked, answer.revision),
              )
            }
          />{" "}
          {t("settings.redact.check")}
        </label>
      </p>
    </>
  );
}
