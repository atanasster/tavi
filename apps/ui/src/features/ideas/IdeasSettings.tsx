import {
  BUILTIN_IDEAS_PROVIDER_ID,
  IDEA_CATEGORY_LABELS,
  type IdeaBasisKind,
  type IdeasListAnswer,
  type IdeaSettings,
} from "@tavi/contracts";
import { useEffect, useId, useState } from "react";

import { whenLocal } from "../../lib/time.js";
import { PageHead, Pending, StatusNote } from "../../ui/Parts.js";
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
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

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
  { key: "memory", label: "What you have told me (approved, non-sensitive memory)" },
  { key: "tasks", label: "Your recent chats (titles and summaries)" },
  { key: "brief", label: "Your brief" },
] as const;

/**
 * What saving the brief does, said from the switches as they stand: a look
 * reads it only while Ideas are on and may read the brief, so the note does
 * not promise a look that will not come.
 */
function briefSaved(settings: IdeaSettings): string {
  if (!settings.enabled) return "Brief saved. Ideas are off: no look reads it until they are on.";
  if (!settings.sources.brief) return "Brief saved. Ideas do not read it while “Your brief” is off above.";
  return "Brief saved: the next look reads it.";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

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
  if (title !== undefined && title !== "" && (source.kind === undefined || source.kind === "task")) return `Chat “${title}”`;
  switch (source.kind ?? (source.ref === "brief" ? "brief" : undefined)) {
    case "brief":
      return "Your brief";
    case "task":
      return `A chat (${source.ref})`;
    case "memory":
      return `Something you told me (${source.ref})`;
    default:
      return `A source (${source.ref})`;
  }
}

export function IdeasSettings() {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error, loading, reload } = useLoaded(() => loadAll(client, workspaceId));
  const { busy, note, run } = useAction(reload);
  const [brief, setBriefDraft] = useState<string>();
  const [confirming, setConfirming] = useState<"ledger" | "categories">();
  const ids = useId();
  // A saved brief that changed resets the draft; a reload after another action keeps what is being typed.
  useEffect(() => setBriefDraft(data?.brief), [data?.brief]);
  const heading = (
    <PageHead
      className="settings-head"
      title="Ideas"
      description="What Ideas may read and show, and everything you hid with an idea's ⋯ menu, to bring back."
    />
  );
  // A reload that failed after a good read keeps the page, and says the page may be out of date.
  const loadError = error === undefined ? null : <LoadError error={error} reload={reload} />;
  if (data === undefined) {
    return (
      <section className="settings ideas-settings" aria-label="ideas">
        {heading}
        <Pending error={loading ? undefined : (error ?? "Ideas could not be read.")} reload={reload} className="notice meta-sm" status />
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
    <section className="settings ideas-settings" aria-label="ideas">
      {heading}
      {loadError}
      <StatusNote note={note} />
      <Card as="div" level={2} title="Switches">
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
                  event.target.checked ? "Ideas are on." : "Ideas are off: none are looked for or shown.",
                )
              }
            />{" "}
            Look for ideas
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={settings.chips}
              disabled={busy !== undefined}
              onChange={(event) =>
                change("chips", { chips: event.target.checked }, event.target.checked ? "Suggestions are on." : "Suggestions are off.")
              }
            />{" "}
            Suggest prompts in an empty chat
          </label>
        </p>
        <p className="meta-sm">Ideas may read:</p>
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
                    event.target.checked ? "Ideas may read it again." : "Ideas no longer read it, and stop quoting it.",
                  )
                }
              />{" "}
              {source.label}
            </label>
          </p>
        ))}
        <p className="meta-sm">
          {/* Tavi's own writer is said in words; another provider by its id, which is what the command takes. */}
          {list.provider === BUILTIN_IDEAS_PROVIDER_ID ? (
            "Written by Tavi itself."
          ) : (
            <>
              Written by <code>{list.provider}</code>.
            </>
          )}{" "}
          Switch it with <Command>tavi ideas provider</Command> in a terminal.
        </p>
        <p className="meta-sm">
          {lastLooked(list.lastRun, timeZone)}
          {list.nextAt === undefined
            ? ""
            : ` Next ${whenLocal(list.nextAt, timeZone)}, between ${settings.hours.start} and ${settings.hours.end}.`}
        </p>
        {/* The digest sends to a chat outside this page, so it is only set where the operator is: shown here, read-only. */}
        <p className="meta-sm ideas-digest">
          {settings.digest === undefined
            ? "Weekly digest: off."
            : `Weekly digest: on, to connection ${settings.digest.channel} every ${WEEKDAYS[settings.digest.weekday] ?? "week"}.`}{" "}
          Set it with <Command>tavi ideas digest</Command> in a terminal.
        </p>
      </Card>
      <Card as="div" level={2} title="Your brief">
        <BriefField id={`${ids}-brief`} value={brief} onChange={setBriefDraft} />
        <p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== undefined || brief === data.brief}
            onClick={() => void run("brief", () => said(briefSaved(settings))(setBrief(client, workspaceId, brief ?? "")))}
          >
            Save brief
          </Button>
        </p>
      </Card>
      <Card as="div" level={2} title="Hidden ideas">
        {hidden.length === 0 ? (
          <p className="meta-sm">None: nothing was set aside with Not now or Not interested.</p>
        ) : (
          hidden.map((idea) => (
            <div key={idea.id} className="item-row">
              <span>
                {idea.title} <span className="meta-sm">({idea.status === "snoozed" ? "not now" : "not interested"})</span>
              </span>
              <Button
                size="sm"
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`restore-${idea.id}`, () => said(`${idea.title}: back.`)(restoreIdea(client, workspaceId, idea.id)))
                }
                aria-label={`Bring back ${idea.title}`}
              >
                Bring back
              </Button>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title="Muted sections">
        {list.mutedCategories.length === 0 ? (
          <p className="meta-sm">None.</p>
        ) : (
          list.mutedCategories.map((category) => (
            <div key={category} className="item-row">
              <span>{IDEA_CATEGORY_LABELS[category]}</span>
              <Button
                size="sm"
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`unmute-${category}`, () =>
                    said(`${IDEA_CATEGORY_LABELS[category]} is back.`)(
                      ideaFeedback(client, workspaceId, { signal: "unmute-category", category }),
                    ),
                  )
                }
                aria-label={`Unmute ${IDEA_CATEGORY_LABELS[category]}`}
              >
                Unmute
              </Button>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title="Sources not used">
        {excluded.length === 0 ? (
          <p className="meta-sm">None: every source ideas may read is used.</p>
        ) : (
          excluded.map((source) => (
            <div key={source.ref} className="item-row">
              <span>{sourceLabel(source)}</span>
              <Button
                size="sm"
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`include-${source.ref}`, () =>
                    said("It is used for ideas again.")(
                      ideaFeedback(client, workspaceId, { signal: "include-basis", basisRef: source.ref }),
                    ),
                  )
                }
                aria-label={`Use ${sourceLabel(source)} again`}
              >
                Use again
              </Button>
            </div>
          ))
        )}
      </Card>
      <Card as="div" level={2} title="Start over">
        <p className="meta-sm">
          Forget everything hidden and set aside{list.mutedCategories.length === 0 ? "" : ", or unmute every section at once"}.
        </p>
        <p>
          <Button variant="secondary" size="sm" disabled={busy !== undefined} onClick={() => setConfirming("ledger")}>
            Forget what I hid
          </Button>
          {/* Offered only while a section is muted: with none, it would do nothing. */}
          {list.mutedCategories.length === 0 ? null : (
            <>
              {" "}
              <Button variant="secondary" size="sm" disabled={busy !== undefined} onClick={() => setConfirming("categories")}>
                Unmute every section
              </Button>
            </>
          )}
        </p>
      </Card>
      {confirming === undefined ? null : (
        <Confirm
          title={confirming === "ledger" ? "Forget what you hid?" : "Unmute every section?"}
          message={
            confirming === "ledger"
              ? "Every idea you said Not interested or Not now to may be offered again, every source you set aside is used again, and the prompts you rewrote are no longer kept as examples."
              : "Ideas from every section may be offered again."
          }
          action={confirming === "ledger" ? "Forget" : "Unmute all"}
          onClose={() => setConfirming(undefined)}
          onConfirm={async () => {
            const what = confirming;
            setConfirming(undefined);
            await run(`reset-${what}`, () =>
              said(what === "ledger" ? "Forgotten: hidden ideas and set-aside sources may come back." : "Every section is unmuted.")(
                resetIdeas(client, workspaceId, what),
              ),
            );
          }}
        />
      )}
    </section>
  );
}
