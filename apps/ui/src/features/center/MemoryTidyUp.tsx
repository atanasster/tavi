import { useId } from "react";

import type { MemoryItem } from "@tavi/contracts";

import { translateNow, useT } from "../../lib/i18n.js";
import { decideMemory } from "./memory-api.js";
import { KIND_LABELS } from "./memory-model.js";
import { type MemoryPageContext, type Context, untilLine, RecordMeta, RecordText, RevealButton, ProvenanceLine } from "./MemoryRecord.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useMemoryDecision } from "./use-memory-decision.js";

/**
 * The *Tidy-up suggestions* group: the waiting proposals a weekly consolidation filed,
 * each with its before and after. Nothing when none waits.
 */
export function TidyUpSuggestions({
  items,
  context,
  onDecided,
}: {
  readonly items: readonly MemoryItem[];
  readonly context: MemoryPageContext;
  readonly onDecided: (recordId: string) => void;
}) {
  const t = useT();
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section className="memory-tidy" aria-labelledby={`${id}-tidy`}>
      <h4 id={`${id}-tidy`} className="eyebrow">
        {t("center.tidyUp.title")}
      </h4>
      <ul className="list-reset">
        {items.map((item) => (
          <TidyUp key={item.recordId} item={item} context={context} onDecided={onDecided} />
        ))}
      </ul>
    </section>
  );
}
/** Whether a before's excerpt (cut with a trailing `…` past its bound) holds the same words as the after's body. */
function sameWords(excerpt: string | null | undefined, body: string | null): boolean {
  if (excerpt === null || excerpt === undefined || body === null) return false;
  return excerpt.endsWith("…") ? body.startsWith(excerpt.slice(0, -1)) : excerpt === body;
}
/** What a stale tidy-up says: a record it replaces changed since, so it is suggested again on the next run. */
const tidyStale = (): string => translateNow("center.tidyUp.stale");
/**
 * One tidy-up suggestion: what it replaces (before) and what it would keep instead
 * (after). Keep approves it, which supersedes the before in one step; nothing is deleted. Never kept
 * in bulk, and never automatically.
 */
function TidyUp({
  item,
  context,
  onDecided,
}: {
  readonly item: MemoryItem;
  readonly context: Context;
  readonly onDecided: (recordId: string) => void;
}) {
  const t = useT();
  const {
    busy,
    failure,
    reveal,
    shown,
    decide: run,
  } = useMemoryDecision(item, onDecided, (outcome) => (outcome.code === "REVISION_CONFLICT" ? tidyStale() : outcome.message));
  const before = item.supersedes ?? [];
  const stale = before.some((entry) => entry.stale);
  const name = item.title ?? KIND_LABELS[item.kind];
  const until = untilLine(item, context);
  const action =
    before.length > 1
      ? t("center.tidyUp.merge", { count: before.length })
      : until !== undefined && sameWords(before[0]?.excerpt, item.body)
        ? t("center.tidyUp.end")
        : t("center.tidyUp.replace");
  const decide = (keep: boolean): void => run((client, workspaceId) => decideMemory(client, workspaceId, item.recordId, keep));
  return (
    <li className="memory-proposal memory-tidy-item">
      <div>
        <p className="meta-sm">{action}</p>
        <p className="meta-sm memory-tidy-label">{t("center.tidyUp.before")}</p>
        <ul className="list-reset memory-tidy-before" aria-label={t("center.tidyUp.beforeFor", { name })}>
          {before.map((entry) => (
            <li key={entry.recordId}>
              {entry.title === null && entry.excerpt === null ? (
                <p className="memory-text meta-sm">{t("center.tidyUp.notShown")}</p>
              ) : (
                <RecordText title={entry.title} body={entry.excerpt} masked={false} />
              )}
            </li>
          ))}
        </ul>
        <p className="meta-sm memory-tidy-label">{t("center.tidyUp.after")}</p>
        <RecordText
          title={shown.title}
          body={shown.body}
          masked={item.redacted && reveal.revealed === undefined}
          truncated={reveal.revealed === undefined && item.truncated}
        />
        <RecordMeta item={item} context={context} extra={[KIND_LABELS[item.kind], ...(until === undefined ? [] : [until])]} />
        <ProvenanceLine item={item} />
        {stale ? <p className="meta-sm memory-related">{tidyStale()}</p> : null}
        {failure === undefined && reveal.failure === undefined ? null : <Failure>{failure ?? reveal.failure}</Failure>}
      </div>
      <div className="memory-actions">
        {item.redacted ? <RevealButton reveal={reveal} disabled={busy} /> : null}
        <Button
          variant="primary"
          size="sm"
          disabled={busy || stale}
          aria-label={t("center.tidyUp.keepFor", { name })}
          onClick={() => decide(true)}
        >
          {t("center.tidyUp.keep")}
        </Button>
        <Button size="sm" disabled={busy} aria-label={t("center.tidyUp.discardFor", { name })} onClick={() => decide(false)}>
          {t("center.tidyUp.discard")}
        </Button>
      </div>
    </li>
  );
}
