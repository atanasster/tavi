import { useEffect, useRef, useState, type ReactNode, type FormEvent, type KeyboardEvent } from "react";

import type { PluginCommandView } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { useRowKeys } from "../../hooks/use-row-keys.js";
import { nextPart } from "../../lib/parts.js";
import { Icon } from "../../ui/Icon.js";
import { IconButton } from "../../ui/IconButton.js";
import { Failure } from "../../ui/Parts.js";
import {
  FILES_ONLY_PROMPT,
  FILE_ACCEPT,
  composePrompt,
  uploadsOf,
  readAttachment,
  MAX_ATTACHMENTS,
  type Attachment,
  type UploadAttachment,
} from "./attachments.js";
import { Button } from "../../ui/Button.js";

export function Composer({
  modelTarget,
  onModels,
  modelPicker,
  unconfigured = false,
  disabled,
  placeholder,
  onSubmit,
  onUpload,
  onStop,
  retryPrompt,
  onRetry,
  seed,
  commands,
  onEmptyChange,
  onCleared,
}: {
  readonly modelTarget?: string | undefined;
  readonly onModels?: (() => void) | undefined;
  readonly modelPicker?: ReactNode;
  /** The owner would refuse the run: sending is held, the prompt kept, until it restarts with a model. */
  readonly unconfigured?: boolean;
  readonly disabled: boolean;
  /** Who the next prompt goes to, or that it is queued behind the running turn. */
  readonly placeholder: string;
  readonly onStop?: (() => void) | undefined;
  readonly retryPrompt?: string | undefined;
  readonly onRetry: (prompt: string) => void;
  /** `false`: the prompt was not sent, and stays in the box. */
  readonly onSubmit: (
    prompt: string,
    sent?: { readonly attachments?: readonly string[]; readonly attachmentNames?: readonly string[] },
  ) => boolean | void;
  /** A PDF, video or GIF attached here, uploaded as the message is sent: its artifact id. Absent, they are refused. */
  readonly onUpload?: ((file: UploadAttachment) => Promise<string>) | undefined;
  /** A rewound message, put in the box to edit and send again; a new `key` puts it there again. `placeholder`: select its first [part] to type over. */
  readonly seed?: { readonly text: string; readonly key: number; readonly placeholder?: boolean } | undefined;
  /** Whether the box is empty, as it changes: the empty chat's chips hide once something is typed. */
  readonly onEmptyChange?: ((empty: boolean) => void) | undefined;
  /**
   * The box went from words to empty — sent, or cleared by hand. Not said for
   * its first, empty state: words seeded from outside land after it mounts.
   */
  readonly onCleared?: (() => void) | undefined;
  /** Plugins' slash commands: offered while the prompt is a `/` word being typed. */
  readonly commands?: readonly PluginCommandView[] | undefined;
}) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Two files can share a name: each attachment's key is its own, so removing one leaves the rest in place.
  const { keyOf: attachmentKey } = useRowKeys<Attachment>();
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  /** The box holds an idea's words: Tab goes through their [parts]. */
  const parts = useRef(false);
  useEffect(() => {
    if (seed === undefined) return;
    setPrompt(seed.text);
    parts.current = seed.placeholder === true;
    // Focus goes where the words are, the caret after them: the next keystroke edits the message.
    const frame = requestAnimationFrame(() => {
      const field = box.current;
      if (field === null) return;
      field.focus();
      // An idea's [part] is selected, so typing replaces it; otherwise the caret goes after the words.
      const part = seed.placeholder === true ? nextPart(field.value) : undefined;
      if (part !== undefined) field.setSelectionRange(part.start, part.end);
      else field.setSelectionRange(field.value.length, field.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [seed?.key]);
  const empty = prompt.trim() === "";
  useEffect(() => onEmptyChange?.(empty), [empty, onEmptyChange]);
  const wasEmpty = useRef(true);
  // Only the change is news: a new `onCleared` arrow each render is not.
  const cleared = useRef(onCleared);
  cleared.current = onCleared;
  useEffect(() => {
    if (empty && !wasEmpty.current) {
      cleared.current?.();
      parts.current = false;
    }
    wasEmpty.current = empty;
  }, [empty]);
  // A slash word being typed: the commands it may begin, until a space ends the word.
  const slash = /^\/(\S*)$/.exec(prompt)?.[1]?.toLowerCase();
  const offered = slash === undefined ? [] : (commands ?? []).filter((command) => command.name.toLowerCase().startsWith(slash));
  /** A command picked from the list: in the box with a space after it, the caret at the end, for its arguments. */
  const pickCommand = (name: string): void => {
    const text = `/${name} `;
    setPrompt(text);
    requestAnimationFrame(() => {
      const field = box.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(text.length, text.length);
    });
  };
  const send = (): void => {
    if (disabled || reading) return;
    let text: string;
    try {
      text = composePrompt(prompt, attachments);
    } catch (error) {
      setFileError(errorMessage(error));
      return;
    }
    const uploads = uploadsOf(attachments);
    if (uploads.length > 0) {
      // Uploaded first, then named by the message; a refusal keeps the prompt and its files in the box.
      if (unconfigured) return;
      if (onUpload === undefined) {
        setFileError("PDFs, photos, videos and GIFs cannot be attached here.");
        return;
      }
      setReading(true);
      setFileError("");
      void (async () => {
        const ids: string[] = [];
        for (const file of uploads) ids.push(await onUpload(file));
        return ids;
      })()
        .then((ids) => {
          if (onSubmit(text || FILES_ONLY_PROMPT, { attachments: ids, attachmentNames: uploads.map((file) => file.name) }) === false)
            return;
          setPrompt("");
          setAttachments([]);
          box.current?.focus();
        })
        .catch((error: unknown) => setFileError(errorMessage(error)))
        .finally(() => setReading(false));
      return;
    }
    if (text === "" && onStop !== undefined) {
      onStop();
      return;
    }
    // A stop still goes through; a new run would only be refused, so the prompt is kept.
    if (unconfigured) return;
    const sent = text || retryPrompt;
    if (!sent) return;
    if (text === "") onRetry(sent);
    else if (onSubmit(sent) === false) return;
    setPrompt("");
    setAttachments([]);
    setFileError("");
    // Sent from the button, focus would otherwise fall to `<body>`: it belongs
    // in the prompt box, which is where the next prompt is typed.
    box.current?.focus();
  };
  return (
    <form
      className="composer"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="composer-box">
        <textarea
          rows={3}
          ref={box}
          // Named as its placeholder says ("Message Home"), not "prompt".
          aria-label={composerName(disabled ? undefined : placeholder)}
          value={prompt}
          placeholder={
            disabled ? "Waiting for the owner…" : unconfigured ? "No model is running: restart `tavi serve` with one to send" : placeholder
          }
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            // Enter that confirms an input method's composition is not a send.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (prompt.trim() !== "" || attachments.length > 0) send();
            }
            // On to the next [part] while one is ahead; then Tab leaves the box as ever, so no keyboard is held here.
            if (
              event.key === "Tab" &&
              parts.current &&
              !event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.nativeEvent.isComposing
            ) {
              const part = nextPart(prompt, event.currentTarget.selectionEnd);
              if (part === undefined) return;
              event.preventDefault();
              event.currentTarget.setSelectionRange(part.start, part.end);
            }
          }}
        />
        {offered.length === 0 ? null : (
          <ul className="command-list list-reset" aria-label="Plugin commands">
            {offered.map((command) => (
              <li key={command.name}>
                <Button variant="bare" title={command.pluginId} onClick={() => pickCommand(command.name)}>
                  <code>/{command.name}</code> <span className="muted truncate">{command.description}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {attachments.length > 0 ? (
          <ul className="attachment-list list-reset" aria-label="Attached files">
            {attachments.map((file, index) => (
              <li key={attachmentKey(file)}>
                <span title={file.name}>{file.name}</span>
                <IconButton
                  icon="close"
                  className="button-sm"
                  label={`Remove ${file.name}`}
                  disabled={reading}
                  onClick={() => setAttachments((files) => files.filter((_, i) => i !== index))}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <Failure message={fileError || undefined} />
        <div className="composer-toolbar">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (!files.length) return;
              if (attachments.length + files.length > MAX_ATTACHMENTS) {
                setFileError("Attach up to 5 files.");
                return;
              }
              setReading(true);
              setFileError("");
              void Promise.all(files.map(readAttachment))
                .then((added) => {
                  const next = [...attachments, ...added];
                  composePrompt(prompt, next);
                  setAttachments(next);
                })
                .catch((error: unknown) => setFileError(errorMessage(error)))
                .finally(() => setReading(false));
            }}
          />
          <IconButton
            icon="paperclip"
            label={reading ? "Reading files…" : "Attach PDF, video, GIF, text and code files"}
            aria-busy={reading}
            disabled={disabled || reading}
            tooltip={
              reading
                ? "Reading files…"
                : "Attach PDFs (up to 20 MB), videos and GIFs (up to 50 MB), or text and code files (up to 48 KB each)"
            }
            onClick={() => fileInput.current?.click()}
          />
          {modelPicker ?? (
            <Button
              variant="ghost"
              size="sm"
              className="model-selector truncate"
              title="Owner model. Open model settings; changes may require restarting the owner. Responses show the model actually used."
              onClick={onModels}
              disabled={!onModels}
            >
              {modelTarget || "Configure model"}
              <Icon name="chevron-down" size="sm" />
            </Button>
          )}
          {/* Always focusable and in the tab order: an empty send is a
          no-op in `send`, so it is marked unavailable rather than disabled —
          a control that disables itself on activation loses the reader's place. */}
          <Button
            variant="primary"
            type="submit"
            aria-disabled={
              disabled ||
              reading ||
              (unconfigured && !(onStop !== undefined && attachments.length === 0 && prompt.trim() === "")) ||
              (attachments.length === 0 && prompt.trim() === "" && onStop === undefined && !retryPrompt)
                ? true
                : undefined
            }
          >
            {prompt.trim() !== "" || attachments.length > 0 ? "Send" : onStop !== undefined ? "Stop" : retryPrompt ? "Retry" : "Send"}
          </Button>
        </div>
      </div>
      <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
    </form>
  );
} /** The message box's accessible name: its placeholder's words without the trailing ellipsis, else "Message". */
export function composerName(placeholder: string | undefined): string {
  const words = placeholder?.replace(/(…|\.\.\.)$/, "").trim();
  return words === undefined || words === "" ? "Message" : words;
}
