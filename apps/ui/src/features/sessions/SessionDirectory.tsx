import { rowTitle } from "../center/model.js";
import { IconButton } from "../../ui/IconButton.js";
import { Icon } from "../../ui/Icon.js";
import { SidebarFrame } from "../shell/SidebarFrame.js";
import { directoryRows, TASK_STATUS_LABELS } from "../shell/shell.js";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useAnnounce } from "../../hooks/use-announce.js";
import type { TaskListFilters, TaskListRow } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";
import {
  directoryLayout,
  fetchSessionPreferences,
  groupHeading,
  loadSessionPreferences,
  saveSessionPreferences,
  sessionFilters,
  storeSessionPreferences,
  type SessionPreferences,
} from "./sessions.js";
import type { CanvasState, CanvasStore } from "../chat/store/types.js";
import { Failure, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { spoken } from "../chat/store/said.js";

export function SessionDirectory({
  state,
  store,
  homeChat = false,
  principal,
  selected,
  onSelect,
  onNew,
  newLabel,
  onNewOwn,
  onNewPrivate,
  onHome,
  onCollapse,
}: {
  readonly state: CanvasState;
  readonly store: CanvasStore;
  /** `chat.home` is on: Home pinned on top, side chats under their parent, runs under Activity. */
  readonly homeChat?: boolean;
  /** Whose Home is pinned: another person's is listed as an ordinary chat. */
  readonly principal?: string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onNew?: (() => void) | undefined;
  readonly newLabel?: string | undefined;
  /** *New chat* of its own, beside *New side chat* while Home is on. */
  readonly onNewOwn?: (() => void) | undefined;
  /** *New private chat*. */
  readonly onNewPrivate?: (() => void) | undefined;
  /** Home before its first message, which has no chat to list yet. */
  readonly onHome?: (() => void) | undefined;
  readonly onCollapse?: (() => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const [archived, setArchived] = useState(false);
  const [preferences, setPreferences] = useState(() => loadSessionPreferences());
  // The owner's copy is the one that outlives a restart. Until it answers, the
  // reader works on the local copy; a change made meanwhile wins over the
  // answer, and nothing is written back before the answer — or its failure —
  // so an empty page never overwrites what the owner remembers.
  const owner = useRef<"loading" | "ready" | "unreachable">("loading");
  const touched = useRef(false);
  const filters = useRef<TaskListFilters>({});
  useEffect(() => {
    let live = true;
    owner.current = "loading";
    touched.current = false;
    void fetchSessionPreferences(client, workspaceId).then((value) => {
      if (!live) return;
      owner.current = value === undefined ? "unreachable" : "ready";
      if (value !== undefined && !touched.current) setPreferences(value);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  useEffect(() => {
    saveSessionPreferences(preferences);
    if (touched.current && owner.current === "ready") void storeSessionPreferences(client, workspaceId, preferences);
  }, [preferences, client, workspaceId]);
  const change = (update: (value: SessionPreferences) => SessionPreferences) => {
    touched.current = true;
    setPreferences(update);
  };
  useEffect(() => {
    try {
      filters.current = sessionFilters(search);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    void store.loadSessions(filters.current);
  }, [search, store]);
  const directory = state.directory;
  // Said once, before the directory first answers: an empty list's later refreshes (every few seconds) stay quiet.
  const answered = useRef(false);
  if (directory !== undefined && !directory.loading) answered.current = true;
  const rows = directoryRows(state, workspaceId);
  useEffect(() => {
    const row = rows.find((row) => row.taskId === selected);
    if (row !== undefined && preferences.seen[row.taskId] !== row.updatedAt)
      change((value) => ({ ...value, seen: { ...value.seen, [row.taskId]: row.updatedAt } }));
  }, [rows, selected, preferences.seen]);
  // Archiving wins over an open need: the Center's Needs queue still lists it.
  const visible = rows
    .filter((row) => preferences.archived.includes(row.taskId) === archived)
    .slice()
    .sort((a, b) => Number(preferences.pins.includes(b.taskId)) - Number(preferences.pins.includes(a.taskId)));
  const layout = directoryLayout(visible, homeChat, timeZone, principal);
  // Home has no task until its first message: listed anyway, so a reader who began with + can reach it.
  const homePlaceholder =
    homeChat &&
    onHome !== undefined &&
    directory !== undefined &&
    !(directory.loading && directory.rows.length === 0) &&
    !archived &&
    search.trim() === "" &&
    !layout.sections.some((section) => section.kind === "home");
  // A search's result is said once typing settles: how many chats it found, or none.
  const [found, setFound] = useState<string>();
  const searching = search.trim() !== "" && directory?.loading !== true;
  const count = visible.length;
  useEffect(() => {
    if (!searching) {
      setFound(undefined);
      return undefined;
    }
    const timer = setTimeout(() => setFound(count === 0 ? t("sessions.noMatch") : t("sessions.found", { count })), SEARCH_SAID_AFTER_MS);
    return () => clearTimeout(timer);
  }, [searching, count, search]);
  useAnnounce(found);
  const toggle = (key: "pins" | "archived", id: string) =>
    change((value) => ({ ...value, [key]: value[key].includes(id) ? value[key].filter((item) => item !== id) : [...value[key], id] }));
  /** One chat's row, and the side chats opened from it beneath it. */
  const item = (row: TaskListRow, side = false): ReactNode => (
    <Fragment key={row.taskId}>
      <div className={`session-item${side ? " side-chat" : ""}${selected === row.taskId ? " current" : ""}`}>
        <Button
          variant="bare"
          className={`session${selected === row.taskId ? " current" : ""}`}
          aria-current={selected === row.taskId ? "true" : undefined}
          onClick={() => {
            void store
              .openTask(row.taskId)
              .then(() => onSelect(row.taskId))
              .catch((failure: unknown) => setError(errorMessage(failure)));
          }}
        >
          <span className="session-title truncate" title={rowTitle(row)}>
            {rowTitle(row)}
          </span>
          <span className="session-meta">
            <span className={`badge badge-plain status-${row.needs.length > 0 ? "input-required" : row.status}`}>
              {row.needs.length > 0 ? TASK_STATUS_LABELS["input-required"] : TASK_STATUS_LABELS[row.status]}
            </span>
            <ChatMarks row={row} />
            {preferences.seen[row.taskId] !== row.updatedAt ? (
              <span className="unread-dot" role="img" aria-label={t("sessions.unread")} />
            ) : null}
          </span>
        </Button>
        <div className="actions session-actions">
          <IconButton
            icon={preferences.pins.includes(row.taskId) ? "unpin" : "pin"}
            size="sm"
            className="button-xs"
            label={preferences.pins.includes(row.taskId) ? t("sessions.unpin") : t("sessions.pin")}
            onClick={() => toggle("pins", row.taskId)}
            aria-pressed={preferences.pins.includes(row.taskId)}
            aria-label={t(preferences.pins.includes(row.taskId) ? "sessions.unpinLabel" : "sessions.pinLabel", { title: rowTitle(row) })}
          />
          <IconButton
            icon={preferences.archived.includes(row.taskId) ? "unarchive" : "archive"}
            size="sm"
            className="button-xs"
            label={preferences.archived.includes(row.taskId) ? t("sessions.unarchive") : t("sessions.archive")}
            aria-label={t(preferences.archived.includes(row.taskId) ? "sessions.unarchiveLabel" : "sessions.archiveLabel", {
              title: rowTitle(row),
            })}
            onClick={() => toggle("archived", row.taskId)}
          />
        </div>
      </div>
      {(layout.sides.get(row.taskId) ?? []).map((child) => item(child, true))}
    </Fragment>
  );
  return (
    <SidebarFrame onNew={onNew} newLabel={newLabel} onNewOwn={onNewOwn} onNewPrivate={onNewPrivate} onCollapse={onCollapse}>
      <p className="scope meta-sm">{withParts(t("sessions.workspace"), { id: <code>{workspaceId}</code> })}</p>
      <div className="sidebar-tools">
        <label className="field">
          <span>{t("sessions.search.label")}</span>
          <input
            id="session-search"
            type="search"
            value={search}
            placeholder={t("sessions.search.placeholder")}
            aria-describedby="session-search-hint"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {/* Shown while the box has focus or words: the syntax is help for typing, not a fixture of the list. */}
        <p id="session-search-hint" className="search-hint meta-sm muted">
          {t("sessions.search.hint", { example: "status:failed, origin:schedule" })}
        </p>
      </div>
      {error || directory?.error ? (
        <Failure alert={false}>{error ?? (directory?.error === undefined ? undefined : spoken(directory.error, t))}</Failure>
      ) : null}
      {/* Only the first load says so: the background refresh keeps the rows it
        has on screen, so the list does not jump every few seconds. */}
      {directory?.loading && directory.rows.length === 0 ? (
        <Pending label={t("sessions.loading")} className="notice" status={!answered.current} />
      ) : null}
      {/* Only an answer that came back says the list is empty: not before the first, nor beside a refusal, nor
        above the Home row listed below it. */}
      {directory !== undefined &&
      !directory.loading &&
      error === undefined &&
      directory.error === undefined &&
      visible.length === 0 &&
      !(homePlaceholder && rows.length === 0) ? (
        <p className="muted">
          {search.trim() !== ""
            ? t("sessions.noMatch")
            : archived
              ? t("sessions.noArchived")
              : rows.length > 0
                ? directory.nextCursor
                  ? t("sessions.allLoadedArchived")
                  : t("sessions.allArchived")
                : t("sessions.noChats")}
        </p>
      ) : null}
      {homePlaceholder ? (
        <section className="group home-group">
          <h3>{t("sessions.group.home")}</h3>
          <div className="session-item">
            <Button variant="bare" className="session" onClick={onHome}>
              <span className="session-title truncate">{t("sessions.group.home")}</span>
              <span className="session-meta muted">{t("sessions.noMessages")}</span>
            </Button>
          </div>
        </section>
      ) : null}
      {layout.sections.map((section) =>
        section.kind === "pinned" ? (
          // With `chat.home` off, the reader's Home is an ordinary chat pinned on top: no heading of its own.
          <section key={section.label} className="group pinned-group" aria-label={groupHeading(section.label)}>
            {section.rows.map((row) => item(row))}
          </section>
        ) : (
          <section key={section.label} className={section.kind === "home" ? "group home-group" : "group"}>
            <h3>{groupHeading(section.label)}</h3>
            {section.rows.map((row) => item(row))}
          </section>
        ),
      )}
      {directory?.nextCursor ? (
        <Button size="sm" className="sessions-more" onClick={() => void store.loadSessions(filters.current, true)}>
          {t("sessions.loadOlder")}
        </Button>
      ) : null}
      {directory?.needsTruncated ? <p>{t("sessions.needsTruncated")}</p> : null}
      {/* Below the list, so Home stays first; one fixed name, whether the archive is shown is its pressed state. */}
      <Button variant="ghost" size="sm" className="archived-toggle" aria-pressed={archived} onClick={() => setArchived((value) => !value)}>
        {t("sessions.archived")}
      </Button>
    </SidebarFrame>
  );
}

/** What a chat keeps of its own: its instructions, and how many notes. */
function ChatMarks({ row }: { readonly row: TaskListRow }) {
  const t = useT();
  // The chat app a chat came from (Telegram, Slack…), by its descriptor's label: none for the front ends,
  // a routine or a reminder, whose kinds name no installed channel.
  const channel = useChannelNames().label(row.channel?.kind ?? "");
  if (row.chatInstructions !== true && row.chatNotes === undefined && row.conversationHome === undefined && channel === undefined)
    return null;
  const kind = row.conversationHome === undefined ? undefined : row.conversationHome.kind === "group" ? "group" : "direct";
  const home = kind === undefined ? undefined : t(kind === "group" ? "sessions.mark.group" : "sessions.mark.dm");
  return (
    <span className="session-marks">
      {/* The channel, and for a conversation's Home its kind, by the conversation's ids: "Telegram DM". */}
      {channel === undefined && home === undefined ? null : (
        <span
          className="session-mark"
          title={
            kind === undefined
              ? t("sessions.mark.from", { channel: channel ?? "" })
              : channel === undefined
                ? t(kind === "group" ? "sessions.mark.groupHome" : "sessions.mark.directHome")
                : t(kind === "group" ? "sessions.mark.channelGroupHome" : "sessions.mark.channelDirectHome", { channel: channel ?? "" })
          }
        >
          {[channel, home].filter((part) => part !== undefined).join(" ")}
        </span>
      )}
      {row.chatInstructions === true ? (
        <span className="session-mark" role="img" aria-label={t("sessions.mark.instructionsLabel")} title={t("sessions.mark.instructions")}>
          <Icon name="instructions" size="sm" />
        </span>
      ) : null}
      {row.chatNotes === undefined ? null : (
        <span
          className="session-mark"
          role="img"
          aria-label={t("sessions.mark.notes", { count: row.chatNotes })}
          title={t("sessions.mark.notes", { count: row.chatNotes })}
        >
          <Icon name="center-soul" size="sm" />
          {row.chatNotes}
        </span>
      )}
    </span>
  );
}

/** How long typing in the search rests before what it found is said. */
const SEARCH_SAID_AFTER_MS = 500;
