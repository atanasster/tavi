import { useEffect, useId, useState } from "react";

import { type MemoryItem, MAX_MEMORY_TITLE_CHARS, memoryPendingProvidersNote } from "@tavi/contracts";

import { translateCore, useT } from "../../lib/i18n.js";
import { Failure, InlineConfirm, StatusNote } from "../../ui/Parts.js";
import { FormActions } from "../settings/FormParts.js";
import { correctMemory, forgetMemory, forgetWaitsFor, getMemory } from "./memory-api.js";
import { readOnly } from "./memory-model.js";
import { type Context, untilLine, RecordMeta, RecordText, useReveal, RevealButton } from "./MemoryRecord.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

type RowMode =
  | { readonly kind: "view" }
  | { readonly kind: "forget" }
  | { readonly kind: "correct"; readonly base: MemoryItem; readonly title: string; readonly body: string };
/** One record: its text (masked when sensitive), where it lives, and Reveal, Correct and Forget. */
export function MemoryRow({
  item,
  context,
  onReplaced,
  onRemoved,
  onStale,
  onEditing,
}: {
  readonly item: MemoryItem;
  readonly context: Context;
  readonly onReplaced: (record: MemoryItem) => void;
  /** With what its receipt says of the providers its removal waits for, when it names any. */
  readonly onRemoved: (recordId: string, waiting?: string) => void;
  readonly onStale: () => void;
  /** Whether the row is open for correction, so a refresh keeps it. Stable across renders. */
  readonly onEditing: (recordId: string, open: boolean) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const reveal = useReveal(client, workspaceId, item);
  const revealed = reveal.revealed;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [note, setNote] = useState<string>();
  const ids = useId();
  const locked = readOnly(item);
  const until = untilLine(item, context);

  const correcting = mode.kind === "correct";
  useEffect(() => {
    onEditing(item.recordId, correcting);
    return () => onEditing(item.recordId, false);
  }, [onEditing, item.recordId, correcting]);

  /** Open the correction on the whole record, as it is now (a listed body may be cut). */
  const startCorrect = (message?: string): void => {
    setBusy(true);
    setFailure(undefined);
    void getMemory(client, workspaceId, item.recordId, item.sensitivity === "sensitive").then((outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      const record = outcome.value.record;
      setMode({ kind: "correct", base: record, title: record.title ?? "", body: record.body ?? "" });
      setNote(message);
    });
  };

  const saveCorrection = (): void => {
    if (mode.kind !== "correct") return;
    const title = mode.title.trim() === "" || mode.title === (mode.base.title ?? "") ? undefined : mode.title;
    const body = mode.body === (mode.base.body ?? "") ? undefined : mode.body;
    if (title === undefined && body === undefined) {
      setFailure(t("center.memoryRow.nothingChanged"));
      return;
    }
    if (body !== undefined && body.trim() === "") {
      setFailure(t("center.memoryRow.needsBody"));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setNote(undefined);
    void correctMemory(client, workspaceId, mode.base, { title, body }).then((outcome) => {
      setBusy(false);
      if (outcome.ok) {
        setMode({ kind: "view" });
        // What was revealed before the correction is not what is stored now.
        reveal.hide();
        onReplaced(outcome.value);
        return;
      }
      if (outcome.code === "REVISION_CONFLICT" || outcome.code === "CONFLICT") {
        // Someone (or the agent) changed it meanwhile: show the newer version to correct instead.
        onStale();
        startCorrect(t("center.memoryRow.stale"));
        return;
      }
      setFailure(outcome.message);
    });
  };

  const forget = (): void => {
    setBusy(true);
    setFailure(undefined);
    void forgetMemory(client, workspaceId, item.recordId).then((outcome) => {
      setBusy(false);
      if (outcome.ok) onRemoved(item.recordId, memoryPendingProvidersNote(forgetWaitsFor(outcome.value), translateCore));
      else if (outcome.code === "NOT_FOUND") onRemoved(item.recordId);
      else setFailure(outcome.message);
    });
  };

  const shown = revealed ?? item;
  return (
    <li className="memory-row">
      {mode.kind === "correct" ? (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveCorrection();
          }}
        >
          <Field id={`${ids}-title`} label={t("center.memoryRow.title")}>
            <input
              value={mode.title}
              maxLength={MAX_MEMORY_TITLE_CHARS}
              disabled={busy}
              onChange={(event) => setMode({ ...mode, title: event.target.value })}
            />
          </Field>
          <Field id={`${ids}-body`} label={mode.base.kind === "preference" ? t("center.memoryRow.value") : t("center.memoryRow.text")}>
            <textarea rows={4} value={mode.body} disabled={busy} onChange={(event) => setMode({ ...mode, body: event.target.value })} />
          </Field>
          <p className="memory-hint meta-sm">{t("center.memoryRow.historyHint")}</p>
          <FormActions
            small
            saving={busy}
            disabled={busy}
            cancelDisabled={busy}
            label={t("center.memoryRow.save")}
            onCancel={() => {
              setMode({ kind: "view" });
              setFailure(undefined);
              setNote(undefined);
            }}
          />
        </form>
      ) : (
        <div className="memory-row-main">
          <RecordText
            title={shown.title}
            body={shown.body}
            masked={item.redacted && revealed === undefined}
            truncated={revealed === undefined && item.truncated}
          />
          <RecordMeta
            item={item}
            context={context}
            extra={[...(until === undefined ? [] : [until]), ...(locked ? [t("center.memoryRow.readOnly")] : [])]}
          />
        </div>
      )}
      {mode.kind === "view" ? (
        <div className="memory-actions">
          {item.redacted ? <RevealButton reveal={reveal} disabled={busy} /> : null}
          {locked ? null : (
            <>
              <RowAction disabled={busy} onClick={() => startCorrect()}>
                {t("center.memoryRow.correct")}
              </RowAction>
              <RowAction tone="danger" disabled={busy} onClick={() => setMode({ kind: "forget" })}>
                {t("center.memoryRow.forget")}
              </RowAction>
            </>
          )}
        </div>
      ) : null}
      {mode.kind === "forget" ? (
        <InlineConfirm
          focusCancel
          className="memory-confirm"
          message={t("center.memoryRow.forgetConfirm", { unreached: translateCore("memory.forget.unreached") })}
          confirmLabel={busy ? t("center.memoryRow.forgetting") : t("center.memoryRow.forgetIt")}
          cancelLabel={t("center.memoryRow.keepIt")}
          busy={busy}
          onConfirm={forget}
          onCancel={() => setMode({ kind: "view" })}
        />
      ) : null}
      <StatusNote note={note} className="notice memory-row-note" />
      {failure === undefined && reveal.failure === undefined ? null : (
        <Failure className="memory-row-note">{failure ?? reveal.failure}</Failure>
      )}
    </li>
  );
}
