import {
  CHAT_FOLDER_ATTACHMENTS_MAX,
  MANAGED_FOLDER_LABEL,
  type BrowseEntry,
  type ChatFolderMode,
  type FolderFilesAnswer,
  type FolderView,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useRef, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
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

const MODE_LABELS: Readonly<Record<ChatFolderMode, string>> = { ro: "read-only", rw: "read-write" };

/** The folder button's name: what the chat works in. */
function folderChipLabel(view: FolderView): string {
  if (view.unavailable !== undefined || view.primary === undefined) return "Folder unavailable";
  return view.primary.kind === "managed" ? MANAGED_FOLDER_LABEL : `Folder ${view.primary.label}`;
}

/** The chip's tooltip: where the chat works, and what unavailable means for it. */
function folderChipTitle(view: FolderView): string {
  if (view.unavailable !== undefined || view.primary === undefined)
    return `${view.unavailable ?? "This chat's folder is unavailable."} Reset puts the chat back in its own ${MANAGED_FOLDER_LABEL}.`;
  return `Working folder: ${view.primary.path}`;
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
          Folder
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
      `Reset: the chat works in its own ${MANAGED_FOLDER_LABEL} with the default attachments.`,
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
          {busy === "reset" ? "Resetting…" : "Reset"}
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
      setNote(`${entry.name} is attached already: detach it to change how.`);
      return;
    }
    if (draft.length >= CHAT_FOLDER_ATTACHMENTS_MAX) {
      setNote(`A chat attaches at most ${CHAT_FOLDER_ATTACHMENTS_MAX} folders: detach one first.`);
      return;
    }
    onChange([...draft, { token: entry.token, name: entry.name, path: entry.path, mode }]);
    setNote(`Attached ${entry.name}, ${MODE_LABELS[mode]}, from this chat's first message.`);
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
        title="This chat starts with the folders attached here"
        onClick={() => {
          if (!open) setNote(undefined);
          setOpen(!open);
        }}
      >
        <span className="truncate">{draft.length === 0 ? MANAGED_FOLDER_LABEL : `${MANAGED_FOLDER_LABEL} +${draft.length}`}</span>
      </Button>
      {open ? (
        <Popover as="section" className="folder-panel" label="Chat folder" initialFocus=".folder-panel-head h2" onClose={close}>
          <div className="folder-panel-head">
            <h2 tabIndex={-1}>Chat folder</h2>
            <IconButton icon="close" label="Close" size="sm" onClick={close} />
          </div>
          <p className="meta-sm">
            This chat hasn't started: the folders you attach here go with its first message. Reloading the page drops them.
          </p>
          <StatusNote note={note} />
          {draft.length === 0 ? null : (
            <ul className="folder-roots" aria-label="Folders">
              {draft.map((folder) => (
                <li key={folder.token} className="folder-root">
                  <span className="truncate" title={folder.path}>
                    {folder.name}
                  </span>
                  <span className="meta-sm">{MODE_LABELS[folder.mode]}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Detach ${folder.name}`}
                    onClick={() => {
                      onChange(draft.filter((kept) => kept.token !== folder.token));
                      setNote(`Detached ${folder.name}.`);
                    }}
                  >
                    Detach
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="folder-panel-actions cluster">
            <Button variant="ghost" size="sm" aria-expanded={picking} onClick={() => setPicking((was) => !was)}>
              Attach a folder…
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
  const { client, workspaceId } = useWorkspace();
  const taskId = view.taskId;
  const unavailable = view.unavailable !== undefined || view.primary === undefined;
  const [picking, setPicking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const working = busy !== undefined;
  return (
    <Popover as="section" className="folder-panel" label="Chat folder" initialFocus=".folder-panel-head h2" onClose={() => onClose()}>
      <div className="folder-panel-head">
        <h2 tabIndex={-1}>Chat folder</h2>
        <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
      </div>
      {unavailable ? (
        <div className="folder-unavailable" role="alert">
          <p>{view.unavailable ?? "This chat's folder is unavailable."}</p>
          <Button size="sm" disabled={working} onClick={() => void onReset()}>
            {busy === "reset" ? "Resetting…" : "Reset"}
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
              Attach a folder…
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
                  `The chat now works in its own ${MANAGED_FOLDER_LABEL}.`,
                )
              }
            >
              Work in {MANAGED_FOLDER_LABEL}
            </Button>
          ) : null}
          {unavailable ? null : confirmReset ? (
            <InlineConfirm
              inline
              message={`Back to this chat's defaults: its own ${MANAGED_FOLDER_LABEL} and the default attachments. No file is deleted.`}
              confirmLabel={busy === "reset" ? "Resetting…" : "Reset"}
              cancelLabel="Cancel"
              busy={working}
              onConfirm={() => void onReset().then(() => setConfirmReset(false))}
              onCancel={() => setConfirmReset(false)}
            />
          ) : (
            <Button variant="ghost" size="sm" disabled={working} onClick={() => setConfirmReset(true)}>
              Reset…
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
              `Attached ${entry.name}, ${MODE_LABELS[mode]}.`,
            )
          }
          onWorkIn={(entry) =>
            void onChange(
              `set:${entry.token}`,
              () => setFolder(client, workspaceId, taskId, { pick: entry.token } satisfies FolderPick),
              `The chat now works in ${entry.name}.`,
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
        <ul className="folder-roots" aria-label="Folders">
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
                    aria-label={`Detach ${label}`}
                    onClick={() =>
                      void onChange(`detach:${label}`, () => detachFolder(client, workspaceId, taskId, label), `Detached ${label}.`)
                    }
                  >
                    Detach
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
          Up
        </Button>
      )}
      {listing.entries.length === 0 ? (
        <Empty>Nothing here yet.</Empty>
      ) : (
        <ul aria-label="Files">
          {listing.entries.map((entry) => (
            <li key={entry.name} className="folder-entry" data-kind={entry.kind}>
              {entry.kind === "directory" ? (
                <Button variant="ghost" size="sm" aria-label={`Open ${entry.name}`} onClick={() => onOpen(within(entry.name))}>
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
                      aria-label={`Download ${entry.name}`}
                      disabled={downloading !== undefined}
                      onClick={() => onDownload(within(entry.name))}
                    >
                      {downloading === within(entry.name) ? "Downloading…" : "Download"}
                    </Button>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {listing.truncated ? <p className="meta-sm">Only the first {plural(listing.entries.length, "entry", "entries")} are shown.</p> : null}
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
  const { client, workspaceId } = useWorkspace();
  /** The token of the folder listed; absent, the `--fs-root` folders. */
  const [under, setUnder] = useState<string>();
  const { data, error, loading, reload } = useLoaded(() => browseFolders(client, workspaceId, under), [under ?? ""]);
  return (
    <section className="folder-picker" aria-label="Attach a folder">
      <p className="folder-where meta-sm">{data?.at?.path ?? "The folders tavi may use"}</p>
      {under === undefined ? null : (
        <p>
          <Button variant="ghost" size="sm" onClick={() => setUnder(data?.parent?.token)}>
            Up
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setUnder(undefined)}>
            Top
          </Button>
        </p>
      )}
      {data === undefined ? null : data.entries.length === 0 ? (
        <Empty>No folders here.</Empty>
      ) : (
        <ul aria-label="Folders to attach">
          {data.entries.map((entry) => (
            <li key={entry.token} className="folder-entry">
              {entry.opens ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title={entry.path}
                  aria-label={`Open ${entry.name}`}
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
                  aria-label={`Attach read-only: ${entry.name}`}
                  onClick={() => onAttach(entry, "ro")}
                >
                  Attach read-only
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Attach read-write: ${entry.name}`}
                  onClick={() => onAttach(entry, "rw")}
                >
                  Attach read-write
                </Button>
                {onWorkIn === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Work in this folder: ${entry.name}`}
                    onClick={() => onWorkIn(entry)}
                  >
                    Work in this folder
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data?.truncated === true ? <p className="meta-sm">Only the first {plural(data.entries.length, "folder")} are shown.</p> : null}
      <LoadState error={error} reload={reload} loading={loading} className="empty" />
    </section>
  );
}
