import { useState } from "react";

import { type MemoryItem, MEMORY_PROVENANCE_KEEP_ALONE, memoryProvenanceLine } from "@tavi/contracts";

import { translateNow, useT } from "../../lib/i18n.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { localDate, shortDay } from "../../lib/time.js";
import { getMemory } from "./memory-api.js";
import { revealKey, scopeLabel } from "./memory-model.js";
import { Button } from "../../ui/Button.js";

export const recordKey = (record: MemoryItem): string => record.recordId;
/** What the page says about a person or a date: the feed's summary, or nothing yet. */
export type MemoryPageContext = Context;
export interface Context {
  readonly timeZone: string | undefined;
  readonly today: string;
  readonly agentNames: Readonly<Record<string, string>>;
}
/** "Until Fri 17 Oct" for a record with an end date: a fact's `validTo`, a preference's or lesson's `expiryAt`. */
export function untilLine(item: MemoryItem, context: Context): string | undefined {
  const end = item.expiryAt ?? item.validTo;
  return end === undefined
    ? undefined
    : translateNow("center.memoryRecord.until", { day: shortDay(endDay(end, context.timeZone), context.today) });
}
/** The last day an end date covers, in the zone: "until Friday" ends as Saturday begins. */
export function endDay(iso: string, timeZone: string | undefined): string {
  return localDate(new Date(Date.parse(iso) - 1).toISOString(), timeZone);
}
/** A record's scope chip and its date. */
export function RecordMeta({
  item,
  context,
  extra,
}: {
  readonly item: MemoryItem;
  readonly context: Context;
  readonly extra?: readonly string[] | undefined;
}) {
  const t = useT();
  return (
    <span className="memory-meta">
      <span className="memory-scope">{scopeLabel(item.target, context.agentNames)}</span>
      <time dateTime={item.updatedAt}>{shortDay(localDate(item.updatedAt, context.timeZone), context.today)}</time>
      {item.sensitivity === "sensitive" ? <span>{t("center.memoryRecord.sensitive")}</span> : null}
      {(extra ?? []).map((part) => (
        <span key={part}>{part}</span>
      ))}
    </span>
  );
}
/** A record's text: title and body, or a mask for a sensitive one not revealed. */
export function RecordText({
  title,
  body,
  masked,
  truncated,
}: {
  readonly title: string | null;
  readonly body: string | null;
  readonly masked: boolean;
  readonly truncated?: boolean;
}) {
  const t = useT();
  if (masked) {
    return (
      <p className="memory-text">
        <span className="memory-masked" aria-hidden="true">
          ••••••••••••••
        </span>
        <span className="visually-hidden">{t("center.memoryRecord.hidden")}</span>
      </p>
    );
  }
  return (
    <div className="memory-text">
      {title === null || title === "" ? null : <p className="memory-title">{title}</p>}
      {body === null ? null : (
        <p className="memory-body">
          {body}
          {truncated ? "…" : null}
        </p>
      )}
    </div>
  );
}
/**
 * A sensitive record's text, asked for with `get { reveal: true }` and shown
 * until hidden — or until a refresh shows the record moved on (another
 * revision, or no longer redacted), when the text revealed is no longer its own.
 */
export function useReveal(client: SettingsClient, workspaceId: string, item: MemoryItem) {
  const [revealed, setRevealed] = useState<{ readonly record: MemoryItem; readonly at: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const shown = revealed !== undefined && item.redacted && revealed.at === revealKey(item) ? revealed.record : undefined;
  // A reveal of an older revision is dropped while rendering, never shown for this one.
  if (revealed !== undefined && shown === undefined) setRevealed(undefined);
  const toggle = (): void => {
    if (shown !== undefined) {
      setRevealed(undefined);
      return;
    }
    const at = revealKey(item);
    setBusy(true);
    setFailure(undefined);
    void getMemory(client, workspaceId, item.recordId, true).then((outcome) => {
      setBusy(false);
      if (outcome.ok) setRevealed({ record: outcome.value.record, at });
      else setFailure(outcome.message);
    });
  };
  return { revealed: shown, busy, failure, toggle, hide: () => setRevealed(undefined) };
}
/** Reveal / Hide for a redacted record. */
export function RevealButton({ reveal, disabled }: { readonly reveal: ReturnType<typeof useReveal>; readonly disabled: boolean }) {
  const t = useT();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled || reveal.busy}
      aria-pressed={reveal.revealed !== undefined}
      onClick={reveal.toggle}
    >
      {reveal.revealed === undefined ? t("center.memoryRecord.reveal") : t("center.memoryRecord.hide")}
    </Button>
  );
}
/**
 * What a proposal made after its chat read untrusted content — or a tidy-up of one — says it read:
 * the hosts Tavi parsed first, a page's own title only as what it calls itself.
 */
export function ProvenanceLine({ item }: { readonly item: MemoryItem }) {
  const read = memoryProvenanceLine(item.provenance, { tidyUp: item.supersedes !== undefined });
  return read === undefined ? null : (
    <p className="meta-sm memory-related memory-provenance">{`${read} · ${MEMORY_PROVENANCE_KEEP_ALONE}`}</p>
  );
}
