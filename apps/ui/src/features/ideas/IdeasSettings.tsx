import {
  BUILTIN_IDEAS_PROVIDER_ID,
  IDEA_CATEGORY_LABELS,
  type IdeaBasisKind,
  type IdeasListAnswer,
  type IdeaSettings,
} from "@tavi/contracts";
import { useEffect, useId, useState } from "react";

import { translateNow, useT } from "../../lib/i18n.js";
import { weekdayName, whenLocal } from "../../lib/time.js";
import { PageHead, PageNote, Pending } from "../../ui/Parts.js";
import { mapOutcome, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { Confirm } from "../../ui/Confirm.js";
import { LoadError } from "../settings/FormParts.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { BriefField } from "./BriefField.js";
import {
  changeIdeasSettings,
  getBrief,
  ideaFeedback,
  ideasSettings,
  lastLooked,
  listIdeas,
  resetIdeas,
  restoreIdea,
  setBrief,
} from "./ideas-api.js";
import { Card } from "../../ui/Card.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * Settings → Ideas: the switches — ideas on, the
 * empty chat's suggestions, what ideas may read — and the undo for every ⋯
 * action: ideas hidden for now or for good come back, muted sections unmute,
 * and sources set aside are used again. The provider is shown, and switched
 * only in a terminal.
 */

interface Loaded {
  readonly settings: IdeaSettings;
  readonly list: IdeasListAnswer;
  readonly brief: string;
}

async function loadAll(client: SettingsClient, workspaceId: string): Promise<Outcome<Loaded>> {
  const [settings, list, brief] = await Promise.all([
    ideasSettings(client, workspaceId),
    listIdeas(client, workspaceId, true),
    getBrief(client, workspaceId),
  ]);
  if (!settings.ok) return settings;
  if (!list.ok) return list;
  if (!brief.ok) return brief;
  return { ok: true, value: { settings: settings.value.settings, list: list.value, brief: brief.value.text } };
}

/** Says an action's outcome as the settings page's note: its words on success, the owner's on refusal. */
const said =
  (note: string) =>
  async (work: Promise<Outcome<unknown>>): Promise<Outcome<string | undefined>> => {
    const outcome = await work;
    return mapOutcome(outcome, () => note);
  };

const SOURCES = [
  { key: "memory", labelKey: "ideas.settings.source.memory" },
  { key: "tasks", labelKey: "ideas.settings.source.tasks" },
  { key: "brief", labelKey: "ideas.settings.source.brief" },
] as const;

/**
 * What saving the brief does, said from the switches as they stand: a look
 * reads it only while Ideas are on and may read the brief, so the note does
 * not promise a look that will not come.
 */
function briefSaved(settings: IdeaSettings): string {
  if (!settings.enabled) return translateNow("ideas.brief.savedOff");
  if (!settings.sources.brief) return translateNow("ideas.brief.savedUnread");
  return translateNow("ideas.brief.savedNext");
}

/**
 * A set-aside source, as the owner names it: a chat by its title when the
 * owner could read one, else its kind when known, its words dropped with it.
 */
function sourceLabel(source: {
  readonly ref: string;
  readonly kind?: IdeaBasisKind | undefined;
  readonly title?: string | undefined;
}): string {
  const title = source.title?.trim();
  if (title !== undefined && title !== "" && (source.kind === undefined || source.kind === "task"))
    return translateNow("ideas.settings.sourceChat", { title });
  switch (source.kind ?? (source.ref === "brief" ? "brief" : undefined)) {
    case "brief":
      return translateNow("ideas.settings.sourceBrief");
    case "task":
      return translateNow("ideas.settings.sourceTask", { ref: source.ref });
    case "memory":
      return translateNow("ideas.settings.sourceMemory", { ref: source.ref });
    default:
      return translateNow("ideas.settings.sourceOther", { ref: source.ref });
  }
}

export function IdeasSettings() {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error, loading, reload } = useLoaded(() => loadAll(client, workspaceId));
  const { busy, note, tone, run } = useAction(reload);
  const [brief, setBriefDraft] = useState<string>();
  const [confirming, setConfirming] = useState<"ledger" | "categories">();
  const ids = useId();
  // A saved brief that changed resets the draft; a reload after another action keeps what is being typed.
  useEffect(() => setBriefDraft(data?.brief), [data?.brief]);
  const heading = <PageHead className="settings-head" title={t("ideas.settings.title")} description={t("ideas.settings.description")} />;
  // A reload that failed after a good read keeps the page, and says the page may be out of date.
  const loadError = error === undefined ? null : <LoadError error={error} reload={reload} />;
  if (data === undefined) {
    return (
      <section className="settings ideas-settings" aria-label={t("ideas.settings.region")}>
        {heading}
        <Pending
          error={loading ? undefined : (error ?? t("ideas.settings.unreadable"))}
          reload={reload}
          className="notice meta-sm"
          status
        />
      </section>
    );
  }
  const { settings, list } = data;
  const hidden = list.ideas.filter((idea) => idea.status === "snoozed" || idea.status === "dismissed");
  // An older owner names the refs alone.
  const excluded = list.excludedSources ?? list.excludedBasis.map((ref) => ({ ref }));
  const change = (key: string, changes: Parameters<typeof changeIdeasSettings>[2], words: string) =>
    void run(key, () => said(words)(changeIdeasSettings(client, workspaceId, changes)));
  return (
    <section className="settings ideas-settings" aria-label={t("ideas.settings.region")}>
      {heading}
      {loadError}
      <PageNote tone={tone} note={note} />
      <Card as="div" level={2} title={t("ideas.settings.switches")}>
        <p>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy !== undefined}
              onChange={(event) =>
                change(
                  "enabled",
                  { enabled: event.target.checked },
                  event.target.checked ? t("ideas.settings.enabledOn") : t("ideas.settings.enabledOff"),
                )
              }
            />
            {t("ideas.settings.enabled")}
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={settings.chips}
              disabled={busy !== undefined}
              onChange={(event) =>
                change(
                  "chips",
                  { chips: event.target.checked },
                  event.target.checked ? t("ideas.settings.chipsOn") : t("ideas.settings.chipsOff"),
                )
              }
            />
            {t("ideas.settings.chips")}
          </label>
        </p>
        <p className="meta-sm">
          {/* Tavi's own writer is said in words; another provider by its id, which is what the command takes. */}
          {list.provider === BUILTIN_IDEAS_PROVIDER_ID
            ? t("ideas.settings.writtenByTavi")
            : withParts(t("ideas.settings.writtenBy"), { provider: <code>{list.provider}</code> })}{" "}
          {withParts(t("ideas.settings.switchProvider"), { command: <Command>tavi ideas provider</Command> })}
        </p>
        <p className="meta-sm">
          {lastLooked(list.lastRun, timeZone)}
          {list.nextAt === undefined
            ? ""
            : ` ${t("ideas.settings.next", { when: whenLocal(list.nextAt, timeZone), start: settings.hours.start, end: settings.hours.end })}`}
        </p>
        {/* The digest sends to a chat outside this page, so it is only set where the operator is: shown here, read-only. */}
        <p className="meta-sm ideas-digest">
          {settings.digest === undefined
            ? t("ideas.settings.digestOff")
            : t("ideas.settings.digestOn", { channel: settings.digest.channel, weekday: weekdayName(settings.digest.weekday) })}{" "}
          {withParts(t("ideas.settings.digestSet"), { command: <Command>tavi ideas digest</Command> })}
        </p>
      </Card>
      {/* What a look reads, apart from when it looks: each one a switch, named as the reader knows it. */}
      <Card as="div" level={2} title={t("ideas.settings.sources")}>
        {SOURCES.map((source) => (
          <p key={source.key}>
            <label>
              <input
                type="checkbox"
                checked={settings.sources[source.key]}
                disabled={busy !== undefined}
                onChange={(event) =>
                  change(
                    `source-${source.key}`,
                    { sources: { [source.key]: event.target.checked } },
                    event.target.checked ? t("ideas.settings.sourceOn") : t("ideas.settings.sourceOff"),
                  )
                }
              />
              {t(source.labelKey)}
            </label>
          </p>
        ))}
      </Card>
      <Card as="div" level={2} title={t("ideas.settings.brief")}>
        <BriefField id={`${ids}-brief`} value={brief} onChange={setBriefDraft} />
        <p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== undefined || brief === data.brief}
            onClick={() => void run("brief", () => said(briefSaved(settings))(setBrief(client, workspaceId, brief ?? "")))}
          >
            {t("ideas.settings.saveBrief")}
          </Button>
        </p>
      </Card>
      <Card as="div" level={2} title={t("ideas.settings.hidden")}>
        {hidden.length === 0 ? (
          <p className="meta-sm">{t("ideas.settings.hiddenNone")}</p>
        ) : (
          hidden.map((idea) => (
            <div key={idea.id} className="item-row">
              <span>
                {idea.title}{" "}
                <span className="meta-sm">
                  {idea.status === "snoozed" ? t("ideas.settings.hiddenNotNow") : t("ideas.settings.hiddenNotInterested")}
                </span>
              </span>
              <RowAction
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`restore-${idea.id}`, () =>
                    said(t("ideas.settings.restored", { title: idea.title }))(restoreIdea(client, workspaceId, idea.id)),
                  )
                }
                aria-label={t("ideas.settings.bringBackLabel", { title: idea.title })}
              >
                {t("ideas.settings.bringBack")}
              </RowAction>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title={t("ideas.settings.muted")}>
        {list.mutedCategories.length === 0 ? (
          <p className="meta-sm">{t("ideas.settings.none")}</p>
        ) : (
          list.mutedCategories.map((category) => (
            <div key={category} className="item-row">
              <span>{IDEA_CATEGORY_LABELS[category]}</span>
              <RowAction
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`unmute-${category}`, () =>
                    said(t("ideas.settings.unmuted", { section: IDEA_CATEGORY_LABELS[category] }))(
                      ideaFeedback(client, workspaceId, { signal: "unmute-category", category }),
                    ),
                  )
                }
                aria-label={t("ideas.settings.unmuteLabel", { section: IDEA_CATEGORY_LABELS[category] })}
              >
                {t("ideas.settings.unmute")}
              </RowAction>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title={t("ideas.settings.excluded")}>
        {excluded.length === 0 ? (
          <p className="meta-sm">{t("ideas.settings.excludedNone")}</p>
        ) : (
          excluded.map((source) => (
            <div key={source.ref} className="item-row">
              <span>{sourceLabel(source)}</span>
              <RowAction
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`include-${source.ref}`, () =>
                    said(t("ideas.settings.included"))(
                      ideaFeedback(client, workspaceId, { signal: "include-basis", basisRef: source.ref }),
                    ),
                  )
                }
                aria-label={t("ideas.settings.useAgainLabel", { source: sourceLabel(source) })}
              >
                {t("ideas.settings.useAgain")}
              </RowAction>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title={t("ideas.settings.startOver")}>
        <p className="meta-sm">
          {list.mutedCategories.length === 0 ? t("ideas.settings.startOverHint") : t("ideas.settings.startOverHintMuted")}
        </p>
        <p>
          <Button variant="secondary" size="sm" disabled={busy !== undefined} onClick={() => setConfirming("ledger")}>
            {t("ideas.settings.forget")}
          </Button>
          {/* Offered only while a section is muted: with none, it would do nothing. */}
          {list.mutedCategories.length === 0 ? null : (
            <>
              {" "}
              <Button variant="secondary" size="sm" disabled={busy !== undefined} onClick={() => setConfirming("categories")}>
                {t("ideas.settings.unmuteAll")}
              </Button>
            </>
          )}
        </p>
      </Card>
      {confirming === undefined ? null : (
        <Confirm
          title={confirming === "ledger" ? t("ideas.settings.confirmForgetTitle") : t("ideas.settings.confirmUnmuteTitle")}
          message={confirming === "ledger" ? t("ideas.settings.confirmForget") : t("ideas.settings.confirmUnmute")}
          action={confirming === "ledger" ? t("ideas.settings.forgetAction") : t("ideas.settings.unmuteAllAction")}
          onClose={() => setConfirming(undefined)}
          onConfirm={async () => {
            const what = confirming;
            setConfirming(undefined);
            await run(`reset-${what}`, () =>
              said(what === "ledger" ? t("ideas.settings.forgotten") : t("ideas.settings.allUnmuted"))(
                resetIdeas(client, workspaceId, what),
              ),
            );
          }}
        />
      )}
    </section>
  );
}
