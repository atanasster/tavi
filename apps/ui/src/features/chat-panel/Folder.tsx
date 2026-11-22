import {
  CHAT_FOLDER_ATTACHMENTS_MAX,
  managedFolderLabel,
  type BrowseEntry,
  type ChatFolderMode,
  type FolderFilesAnswer,
  type FolderView,
} from "@tavi/contracts";
import { useRef, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { saidRecord } from "../shell/said.js";
import { formatBytes } from "../../lib/format.js";
import { usePhone } from "../../hooks/page.js";
import { Icon } from "../../ui/Icon.js";
import { IconButton } from "../../ui/IconButton.js";
import { Popover } from "../../ui/Popover.js";
import { Failure, InlineConfirm, LoadState, StatusNote } from "../../ui/Parts.js";
import type { Outcome } from "../../lib/ipc.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import {
  attachFolder,
  browseFolders,
  detachFolder,
  downloadFolderFile,
  listFolderFiles,
  resetFolder,
  setFolder,
  showFolder,
  type FolderPick,
} from "./folder-api.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The chat's working folder in the chat header: a chip naming it — "Chat files", or `<label>/…` for a host folder —
 * with Reset beside it when the folder
 * is gone, so recovery never needs a terminal. It opens a panel
 * listing the folder's files to download and, off the phone, an attach picker
 * over `browse`. Nowhere is a host path typed: the picker hands the owner
 * tokens it issued (I-web).
 */

const MODE_LABELS: Readonly<Record<ChatFolderMode, string>> = saidRecord({
  ro: "chatPanel.folder.mode.ro",
  rw: "chatPanel.folder.mode.rw",
});

/** The folder button's name: what the chat works in. */
function folderChipLabel(view: FolderView): string {
  if (view.unavailable !== undefined || view.primary === undefined) return translateNow("chatPanel.folder.chipUnavailable");
  return view.primary.kind === "managed"
    ? managedFolderLabel(translateCore)
    : translateNow("chatPanel.folder.chip", { label: view.primary.label });
}

/** The chip's tooltip: where the chat works, and what unavailable means for it. */
function folderChipTitle(view: FolderView): string {
  if (view.unavailable !== undefined || view.primary === undefined)
    return translateNow("chatPanel.folder.chipTitleUnavailable", {
      reason: view.unavailable ?? translateNow("chatPanel.folder.unavailable"),
      folder: managedFolderLabel(translateCore),
    });
  return translateNow("chatPanel.folder.chipTitle", { path: view.primary.path });
}

/** An attachment's label, from its root id (`attachment:<label>`). */
const attachmentLabel = (rootId: string): string | undefined =>
  rootId.startsWith("attachment:") ? rootId.slice("attachment:".length) : undefined;

export function FolderChip({
  taskId,
  canBrowse,
  version = "",
}: {
  readonly taskId: string;
  /** Whether the owner offers `browse`: without it the panel has no picker. */
  readonly canBrowse: boolean;
  /** What changes when the folder may have changed elsewhere (a turn, another tab): it is read again then. */
  readonly version?: string;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const phone = usePhone();
  const { data, error, reload } = useLoaded(() => showFolder(client, workspaceId, taskId), [version]);
  /** The view an action here answered, until the next read. */
  const [answered, setAnswered] = useState<FolderView>();
  useResetOnChange([data], () => setAnswered(undefined));
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const view = answered ?? data;
  if (view === undefined)
    return error === undefined ? null : (
      <span className="folder-chip-wrap">
        <Button variant="ghost" size="sm" className="folder-chip" title={error} onClick={reload}>
          {t("chatPanel.folder.folder")}
        </Button>
      </span>
    );
  const unavailable = view.unavailable !== undefined || view.primary === undefined;
  /** One change at a time; its answer is the folder now. */
  const change = async (key: string, work: () => Promise<Outcome<FolderView>>, said: string): Promise<void> => {
    setBusy(key);
    setNote(undefined);
    setFailure(undefined);
    const outcome = await work();
    setBusy(undefined);
    if (outcome.ok) {
      setAnswered(outcome.value);
      setNote(said);
    } else {
      setFailure(outcome.message);
    }
  };
  const reset = () =>
    change(
      "reset",
      () => resetFolder(client, workspaceId, taskId),
      t("chatPanel.folder.resetDone", { folder: managedFolderLabel(translateCore) }),
    );
  return (
    <span className="folder-chip-wrap">
      {/* A folder icon in the header's tools: what it holds is its name, and the full path its tooltip. */}
      <Button
        variant="ghost"
        size={["icon", "sm"]}
        className={`folder-chip${unavailable ? " folder-chip-unavailable" : ""}`}
        ref={chip}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={folderChipLabel(view)}
        title={folderChipTitle(view)}
        onClick={() => {
          // Opened again, it shows the folder as it is: the last change's note was for then.
          if (!open) setNote(undefined);
          setOpen(!open);
        }}
      >
        <Icon name="folder" size="sm" />
      </Button>
      {unavailable ? (
        <Button size="sm" disabled={busy !== undefined} onClick={() => void reset()}>
          {busy === "reset" ? t("chatPanel.folder.resetting") : t("chatPanel.folder.reset")}
        </Button>
      ) : null}
      {open ? (
        <FolderPanel
          view={view}
          phone={phone}
          canBrowse={canBrowse}
          busy={busy}
          note={note}
          failure={failure}
          onChange={change}
          onReset={reset}
          onClose={() => {
            setOpen(false);
            chip.current?.focus();
          }}
        />
      ) : unavailable ? (
        <Failure message={failure} />
      ) : null}
    </span>
  );
}

/** A folder picked on an empty chat: attached by the message that starts it (`run.folderAttachments`). */
export interface DraftFolder {
  /** The `browse` token, valid on this connection only: what the run carries, never the path. */
  readonly token: string;
  readonly name: string;
  readonly path: string;
  readonly mode: ChatFolderMode;
}

/** The draft as the first message carries it: tokens and modes. */
export const draftAttachments = (draft: readonly DraftFolder[]) =>
  draft.map((folder) => ({ folder: { pick: folder.token }, mode: folder.mode }));

/**
 * The folder chip on a chat that has not started (a new chat, or Home before
 * its first message): there is no chat to change yet, so the folders picked
 * here are held by the page and go with the first message, which starts the
 * chat with them attached. Reloading the page drops them. Shown off the phone
 * only, as the attach picker is.
 */
export function DraftFolderChip({
  draft,
  onChange,
}: {
  readonly draft: readonly DraftFolder[];
  readonly onChange: (next: readonly DraftFolder[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string>();
  const chip = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
    chip.current?.focus();
  };
  const attach = (entry: BrowseEntry, mode: ChatFolderMode): void => {
    if (draft.some((folder) => folder.path === entry.path)) {
      setNote(t("chatPanel.folder.attachedAlready", { name: entry.name }));
      return;
    }
    if (draft.length >= CHAT_FOLDER_ATTACHMENTS_MAX) {
      setNote(t("chatPanel.folder.atMost", { count: CHAT_FOLDER_ATTACHMENTS_MAX }));
      return;
    }
    onChange([...draft, { token: entry.token, name: entry.name, path: entry.path, mode }]);
    setNote(t("chatPanel.folder.attachedDraft", { name: entry.name, mode: MODE_LABELS[mode] }));
  };
  return (
    <span className="folder-chip-wrap">
      <Button
        variant="ghost"
        size="sm"
        className="folder-chip"
        ref={chip}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("chatPanel.folder.draftTitle")}
        onClick={() => {
          if (!open) setNote(undefined);
          setOpen(!open);
        }}
      >
        <span className="truncate">
          {draft.length === 0 ? managedFolderLabel(translateCore) : `${managedFolderLabel(translateCore)} +${draft.length}`}
        </span>
      </Button>
      {open ? (
        <Popover
          as="section"
          className="folder-panel"
          label={t("chatPanel.folder.title")}
          initialFocus=".folder-panel-head h2"
          onClose={close}
        >
          <div className="folder-panel-head">
            <h2 tabIndex={-1}>{t("chatPanel.folder.title")}</h2>
            <IconButton icon="close" label={t("chatPanel.folder.close")} size="sm" onClick={close} />
          </div>
          <p className="meta-sm">{t("chatPanel.folder.draftNote")}</p>
          <StatusNote note={note} />
          {draft.length === 0 ? null : (
            <ul className="folder-roots" aria-label={t("chatPanel.folder.folders")}>
              {draft.map((folder) => (
                <li key={folder.token} className="folder-root">
                  <span className="truncate" title={folder.path}>
                    {folder.name}
                  </span>
                  <span className="meta-sm">{MODE_LABELS[folder.mode]}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("chatPanel.folder.detachLabel", { name: folder.name })}
                    onClick={() => {
                      onChange(draft.filter((kept) => kept.token !== folder.token));
                      setNote(t("chatPanel.folder.detached", { name: folder.name }));
                    }}
                  >
                    {t("chatPanel.folder.detach")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="folder-panel-actions cluster">
            <Button variant="ghost" size="sm" aria-expanded={picking} onClick={() => setPicking((was) => !was)}>
              {t("chatPanel.folder.attach")}
            </Button>
          </div>
          {picking ? <FolderPicker busy={false} onAttach={attach} /> : null}
        </Popover>
      ) : null}
    </span>
  );
}

function FolderPanel({
  view,
  phone,
  canBrowse,
  busy,
  note,
  failure,
  onChange,
  onReset,
  onClose,
}: {
  readonly view: FolderView;
  /** The phone layout: list and download only (a UI choice; the owner cannot tell, and I-web is the enforced line). */
  readonly phone: boolean;
  readonly canBrowse: boolean;
  readonly busy: string | undefined;
  readonly note: string | undefined;
  readonly failure: string | undefined;
  readonly onChange: (key: string, work: () => Promise<Outcome<FolderView>>, said: string) => Promise<void>;
  readonly onReset: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const taskId = view.taskId;
  const unavailable = view.unavailable !== undefined || view.primary === undefined;
  const [picking, setPicking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const working = busy !== undefined;
  return (
    <Popover
      as="section"
      className="folder-panel"
      label={t("chatPanel.folder.title")}
      initialFocus=".folder-panel-head h2"
      onClose={() => onClose()}
    >
      <div className="folder-panel-head">
        <h2 tabIndex={-1}>{t("chatPanel.folder.title")}</h2>
        <IconButton icon="close" label={t("chatPanel.folder.close")} size="sm" onClick={onClose} />
      </div>
      {unavailable ? (
        <div className="folder-unavailable" role="alert">
          <p>{view.unavailable ?? t("chatPanel.folder.unavailable")}</p>
          <Button size="sm" disabled={working} onClick={() => void onReset()}>
            {busy === "reset" ? t("chatPanel.folder.resetting") : t("chatPanel.folder.reset")}
          </Button>
        </div>
      ) : null}
      {view.managedUnavailable === undefined ? null : <Failure alert={false}>{view.managedUnavailable}</Failure>}
      <StatusNote note={note} />
      <Failure message={failure} />
      {/* A folder that is gone is not listed: the owner refuses it until Reset. Each change lists the folder afresh. */}
      {unavailable ? null : <FolderListing key={view.revision} taskId={taskId} phone={phone} working={working} onChange={onChange} />}
      {phone ? null : (
        <div className="folder-panel-actions cluster">
          {canBrowse ? (
            <Button variant="ghost" size="sm" aria-expanded={picking} onClick={() => setPicking((was) => !was)}>
              {t("chatPanel.folder.attach")}
            </Button>
          ) : null}
          {view.primary?.kind === "host" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() =>
                void onChange(
                  "set:managed",
                  () => setFolder(client, workspaceId, taskId, { managed: true }),
                  t("chatPanel.folder.nowManaged", { folder: managedFolderLabel(translateCore) }),
                )
              }
            >
              {t("chatPanel.folder.workInManaged", { folder: managedFolderLabel(translateCore) })}
            </Button>
          ) : null}
          {unavailable ? null : confirmReset ? (
            <InlineConfirm
              inline
              message={t("chatPanel.folder.resetConfirm", { folder: managedFolderLabel(translateCore) })}
              confirmLabel={busy === "reset" ? t("chatPanel.folder.resetting") : t("chatPanel.folder.reset")}
              cancelLabel={t("ui.confirm.cancel")}
              busy={working}
              onConfirm={() => void onReset().then(() => setConfirmReset(false))}
              onCancel={() => setConfirmReset(false)}
            />
          ) : (
            <Button variant="ghost" size="sm" disabled={working} onClick={() => setConfirmReset(true)}>
              {t("chatPanel.folder.resetMore")}
            </Button>
          )}
        </div>
      )}
      {!phone && canBrowse && picking ? (
        <FolderPicker
          busy={working}
          onAttach={(entry, mode) =>
            void onChange(
              `attach:${entry.token}`,
              () => attachFolder(client, workspaceId, taskId, entry.token, mode),
              t("chatPanel.folder.attached", { name: entry.name, mode: MODE_LABELS[mode] }),
            )
          }
          onWorkIn={(entry) =>
            void onChange(
              `set:${entry.token}`,
              () => setFolder(client, workspaceId, taskId, { pick: entry.token } satisfies FolderPick),
              t("chatPanel.folder.nowIn", { name: entry.name }),
            )
          }
        />
      ) : null}
    </Popover>
  );
}

/** The chat's folders and one level of the one open, with its files to download. */
function FolderListing({
  taskId,
  phone,
  working,
  onChange,
}: {
  readonly taskId: string;
  readonly phone: boolean;
  readonly working: boolean;
  readonly onChange: (key: string, work: () => Promise<Outcome<FolderView>>, said: string) => Promise<void>;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [root, setRoot] = useState<string>();
  const [dir, setDir] = useState("");
  const listing = useLoaded(() => listFolderFiles(client, workspaceId, taskId, root, dir), [`${root ?? ""}:${dir}`]);
  const [downloading, setDownloading] = useState<string>();
  const [downloadFailure, setDownloadFailure] = useState<string>();
  const shown = listing.data;
  const download = async (path: string): Promise<void> => {
    setDownloading(path);
    setDownloadFailure(undefined);
    setDownloadFailure(await downloadFolderFile(client, workspaceId, taskId, shown?.root.id, path));
    setDownloading(undefined);
  };
  const open = (next: string | undefined, nextDir = ""): void => {
    setRoot(next);
    setDir(nextDir);
  };
  return (
    <>
      {shown === undefined ? null : (
        <ul className="folder-roots" aria-label={t("chatPanel.folder.folders")}>
          {shown.roots.map((candidate) => {
            const label = attachmentLabel(candidate.id);
            return (
              <li key={candidate.id} className={candidate.id === shown.root.id ? "folder-root current" : "folder-root"}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-current={candidate.id === shown.root.id ? "true" : undefined}
                  title={candidate.path}
                  onClick={() => open(candidate.id)}
                >
                  {candidate.label}
                </Button>
                <span className="meta-sm">{MODE_LABELS[candidate.mode]}</span>
                {label === undefined || phone ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    aria-label={t("chatPanel.folder.detachLabel", { name: label })}
                    onClick={() =>
                      void onChange(
                        `detach:${label}`,
                        () => detachFolder(client, workspaceId, taskId, label),
                        t("chatPanel.folder.detached", { name: label }),
                      )
                    }
                  >
                    {t("chatPanel.folder.detach")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <FileList
        listing={shown}
        dir={dir}
        downloading={downloading}
        onOpen={(next) => open(shown?.root.id, next)}
        onDownload={(path) => void download(path)}
      />
      <LoadState error={listing.error} reload={listing.reload} loading={listing.loading} className="empty" />
      <Failure message={downloadFailure} />
    </>
  );
}

/** One level of a folder: folders to open, files to download (as `application/octet-stream`, whatever their name). */
function FileList({
  listing,
  dir,
  downloading,
  onOpen,
  onDownload,
}: {
  readonly listing: FolderFilesAnswer | undefined;
  readonly dir: string;
  readonly downloading: string | undefined;
  readonly onOpen: (dir: string) => void;
  readonly onDownload: (path: string) => void;
}) {
  const t = useT();
  if (listing === undefined) return null;
  const within = (name: string): string => (dir === "" ? name : `${dir}/${name}`);
  return (
    <div className="folder-files">
      <p className="folder-where meta-sm" title={listing.root.path}>
        {listing.root.path}
        {dir === "" ? "" : `/${dir}`}
      </p>
      {dir === "" ? null : (
        <Button variant="ghost" size="sm" onClick={() => onOpen(dir.split("/").slice(0, -1).join("/"))}>
          {t("chatPanel.folder.up")}
        </Button>
      )}
      {listing.entries.length === 0 ? (
        <Empty>{t("chatPanel.folder.emptyFolder")}</Empty>
      ) : (
        <ul aria-label={t("chatPanel.folder.files")}>
          {listing.entries.map((entry) => (
            <li key={entry.name} className="folder-entry" data-kind={entry.kind}>
              {entry.kind === "directory" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("chatPanel.folder.openLabel", { name: entry.name })}
                  onClick={() => onOpen(within(entry.name))}
                >
                  {entry.name}/
                </Button>
              ) : (
                <>
                  <span className="truncate">{entry.name}</span>
                  <span className="meta-sm">{formatBytes(entry.size)}</span>
                  {entry.kind === "file" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("chatPanel.folder.downloadLabel", { name: entry.name })}
                      disabled={downloading !== undefined}
                      onClick={() => onDownload(within(entry.name))}
                    >
                      {downloading === within(entry.name) ? t("chatPanel.folder.downloading") : t("chatPanel.folder.download")}
                    </Button>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {listing.truncated ? <p className="meta-sm">{t("chatPanel.folder.firstEntries", { count: listing.entries.length })}</p> : null}
    </div>
  );
}

/**
 * The attach picker: the folders `browse` offers, opened a level at a
 * time by token, each attachable read-only or read-write, or made the chat's
 * working folder. No path is typed or sent: only the owner's tokens.
 */
function FolderPicker({
  busy,
  onAttach,
  onWorkIn,
}: {
  readonly busy: boolean;
  readonly onAttach: (entry: BrowseEntry, mode: ChatFolderMode) => void;
  /** Absent, a folder is attached only (a chat not started yet). */
  readonly onWorkIn?: (entry: BrowseEntry) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  /** The token of the folder listed; absent, the `--fs-root` folders. */
  const [under, setUnder] = useState<string>();
  const { data, error, loading, reload } = useLoaded(() => browseFolders(client, workspaceId, under), [under ?? ""]);
  return (
    <section className="folder-picker" aria-label={t("chatPanel.folder.pickerLabel")}>
      <p className="folder-where meta-sm">{data?.at?.path ?? t("chatPanel.folder.pickerTop")}</p>
      {under === undefined ? null : (
        <p>
          <Button variant="ghost" size="sm" onClick={() => setUnder(data?.parent?.token)}>
            {t("chatPanel.folder.up")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setUnder(undefined)}>
            {t("chatPanel.folder.top")}
          </Button>
        </p>
      )}
      {data === undefined ? null : data.entries.length === 0 ? (
        <Empty>{t("chatPanel.folder.noFolders")}</Empty>
      ) : (
        <ul aria-label={t("chatPanel.folder.toAttach")}>
          {data.entries.map((entry) => (
            <li key={entry.token} className="folder-entry">
              {entry.opens ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title={entry.path}
                  aria-label={t("chatPanel.folder.openLabel", { name: entry.name })}
                  onClick={() => setUnder(entry.token)}
                >
                  {entry.name}/
                </Button>
              ) : (
                <span className="truncate" title={entry.path}>
                  {entry.name}/
                </span>
              )}
              <span className="folder-entry-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t("chatPanel.folder.attachRoLabel", { name: entry.name })}
                  onClick={() => onAttach(entry, "ro")}
                >
                  {t("chatPanel.folder.attachRo")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t("chatPanel.folder.attachRwLabel", { name: entry.name })}
                  onClick={() => onAttach(entry, "rw")}
                >
                  {t("chatPanel.folder.attachRw")}
                </Button>
                {onWorkIn === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={t("chatPanel.folder.workInLabel", { name: entry.name })}
                    onClick={() => onWorkIn(entry)}
                  >
                    {t("chatPanel.folder.workIn")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data?.truncated === true ? <p className="meta-sm">{t("chatPanel.folder.firstFolders", { count: data.entries.length })}</p> : null}
      <LoadState error={error} reload={reload} loading={loading} className="empty" />
    </section>
  );
}
