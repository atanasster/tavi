import type { BrowserLiveMessage } from "@tavi/contracts";
import type { KeyboardEvent, RefObject } from "react";

import { useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";
import { StatusNote } from "../../ui/Parts.js";

/**
 * What the page opens, drawn over the takeover surface: its own dropdown, its
 * file chooser and its dialogs. Each answers the page through Takeover.
 */

/** The page's own dropdown, drawn here at the select's box. */
export function TakeoverPicker({
  picker,
  boxRef,
  onKeyDown,
  onPick,
  onCancel,
}: {
  readonly picker: Extract<BrowserLiveMessage, { kind: "select" }>;
  readonly boxRef: RefObject<HTMLDivElement | null>;
  /** Arrows move through its options; Escape closes it. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onPick: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      ref={boxRef}
      className="takeover-picker surface-popover"
      role="group"
      aria-label={t("takeover.picker.label")}
      onKeyDown={onKeyDown}
      style={picker.box === undefined ? undefined : { left: `${picker.box.x}px`, top: `${picker.box.y + picker.box.height}px` }}
    >
      {picker.options.map((option) => (
        <Button
          key={option.value}
          aria-current={option.selected ? "true" : undefined}
          disabled={option.disabled === true}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </Button>
      ))}
      <Button onClick={onCancel}>{t("ui.confirm.cancel")}</Button>
    </div>
  );
}

/** The page's file chooser: the person's files go to the page from here. */
export function TakeoverChooser({
  id,
  chooser,
  uploading,
  onFiles,
  onCancel,
}: {
  /** The surface's id prefix. */
  readonly id: string;
  readonly chooser: Extract<BrowserLiveMessage, { kind: "chooser" }>;
  /** What is being sent, while it is. */
  readonly uploading: string | undefined;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="takeover-dialog surface-popover" role="alertdialog" aria-labelledby={`${id}-chooser`}>
      <p id={`${id}-chooser`}>{chooser.multiple ? t("takeover.chooser.files") : t("takeover.chooser.file")}</p>
      <input
        type="file"
        aria-label={t("takeover.chooser.label")}
        multiple={chooser.multiple}
        {...(chooser.accept === undefined ? {} : { accept: chooser.accept })}
        disabled={uploading !== undefined}
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          // Cleared at once: the same file can be chosen again after a failure.
          event.target.value = "";
          onFiles(chosen);
        }}
      />
      <StatusNote note={uploading} className="muted" />
      <Button disabled={uploading !== undefined} onClick={onCancel}>
        {t("ui.confirm.cancel")}
      </Button>
    </div>
  );
}

/** The page's alert, confirm or prompt. */
export function TakeoverDialog({
  id,
  dialog,
  text,
  onText,
  onOk,
  onCancel,
}: {
  /** The surface's id prefix. */
  readonly id: string;
  readonly dialog: Extract<BrowserLiveMessage, { kind: "dialog" }>;
  /** A prompt's answer, as typed. */
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly onOk: () => void;
  readonly onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="takeover-dialog surface-popover" role="alertdialog" aria-labelledby={`${id}-dialog`}>
      <p id={`${id}-dialog`}>{dialog.message}</p>
      {dialog.type === "prompt" ? (
        <input aria-label={t("takeover.dialog.answer")} value={text} onChange={(event) => onText(event.target.value)} />
      ) : null}
      <Button variant="primary" onClick={onOk}>
        {t("takeover.dialog.ok")}
      </Button>{" "}
      {dialog.type === "alert" ? null : <Button onClick={onCancel}>{t("ui.confirm.cancel")}</Button>}
    </div>
  );
}
