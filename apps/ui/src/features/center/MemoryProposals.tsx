import { useId, useState } from "react";

import {
  type MemoryItem,
  MEMORY_FORGET_UNREACHED,
  memoryMayUpdateLine,
  memoryPendingProvidersNote,
  memoryProvenanceUntrusted,
  memoryUpdatesLine,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { localDate, shortDay } from "../../lib/time.js";
import { Failure, InlineConfirm, StatusNote } from "../../ui/Parts.js";
import { decideAllMemory, decideMemory, forgetMemory, forgetWaitsFor, replaceMemory } from "./memory-api.js";
import { KIND_LABELS } from "./memory-model.js";
import { type Context, untilLine, RecordMeta, RecordText, RevealButton, ProvenanceLine } from "./MemoryRecord.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { useMemoryDecision } from "./use-memory-decision.js";

/** "3 things the agent would like to remember", with "at least" when more wait than are counted. */
export function proposalsHeadline(count: number, atLeast: boolean): string {
  const figure = `${atLeast ? "At least " : ""}${count}`;
  return count === 1 && !atLeast ? "1 thing the agent would like to remember" : `${figure} things the agent would like to remember`;
}
/**
 * One proposal: what the agent would keep, where, and on what evidence — Keep or Discard. An update
 * names the kept record it updates and offers *Replace* — and, a fact, *Keep both* — in place
 * of Keep; a near duplicate says what it is similar to.
 */
export function Proposal({
  item,
  context,
  onDecided,
}: {
  readonly item: MemoryItem;
  readonly context: Context;
  readonly onDecided: (recordId: string) => void;
}) {
  const { busy, failure, reveal, shown, decide: run } = useMemoryDecision(item, onDecided);
  const decide = (keep: boolean | "replace"): void =>
    run((client, workspaceId) =>
      keep === "replace" ? replaceMemory(client, workspaceId, item) : decideMemory(client, workspaceId, item.recordId, keep),
    );
  const source = item.sourceCount === 0 ? undefined : `From ${plural(item.sourceCount, "source")}`;
  const expires =
    item.expiresAt === undefined ? undefined : `Expires ${shortDay(localDate(item.expiresAt, context.timeZone), context.today)}`;
  const until = untilLine(item, context);
  const name = item.title ?? KIND_LABELS[item.kind];
  return (
    <li className="memory-proposal">
      <div>
        <RecordText
          title={shown.title}
          body={shown.body}
          masked={item.redacted && reveal.revealed === undefined}
          truncated={reveal.revealed === undefined && item.truncated}
        />
        <RecordMeta
          item={item}
          context={context}
          extra={[
            KIND_LABELS[item.kind],
            ...(source === undefined ? [] : [source]),
            ...(until === undefined ? [] : [until]),
            ...(expires === undefined ? [] : [expires]),
          ]}
        />
        {item.updates !== undefined ? (
          <p className="meta-sm memory-related">{memoryUpdatesLine(item.updates)}</p>
        ) : item.mayUpdate !== undefined ? (
          <p className="meta-sm memory-related">{memoryMayUpdateLine(item.mayUpdate)}</p>
        ) : null}
        {item.similarTo === undefined ? null : (
          <p className="meta-sm memory-related">similar to: {item.similarTo.title ?? "a kept memory"}</p>
        )}
        <ProvenanceLine item={item} />
        {failure === undefined && reveal.failure === undefined ? null : <Failure>{failure ?? reveal.failure}</Failure>}
      </div>
      <div className="memory-actions">
        {item.redacted ? <RevealButton reveal={reveal} disabled={busy} /> : null}
        {item.updates === undefined && item.mayUpdate === undefined ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => decide(true)}>
            Keep
          </Button>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} aria-label={`Replace: ${name}`} onClick={() => decide("replace")}>
              Replace
            </Button>
            {item.kind === "fact" ? (
              <Button size="sm" disabled={busy} aria-label={`Keep both: ${name}`} onClick={() => decide(true)}>
                Keep both
              </Button>
            ) : null}
          </>
        )}
        <Button size="sm" disabled={busy} onClick={() => decide(false)}>
          Discard
        </Button>
      </div>
    </li>
  );
}
/**
 * Whether a listed proposal is plain (the one *Keep all* rule): not sensitive, not an update, not a
 * tidy-up, and not proposed after its chat read untrusted content.
 */
function plainProposal(item: MemoryItem): boolean {
  return (
    item.status === "proposed" &&
    item.sensitivity !== "sensitive" &&
    item.updates === undefined &&
    item.mayUpdate === undefined &&
    item.supersedes === undefined &&
    !memoryProvenanceUntrusted(item.provenance)
  );
}
/**
 * The proposals' bulk *Keep all* / *Discard all*, over
 * exactly the ones listed. *Keep all* keeps the plain ones only: an update, a
 * sensitive proposal, a tidy-up, one proposed after its chat read untrusted
 * content, or one another kept value took the key of
 * stays waiting and is counted ("Kept 4 · 1 needs a look"); its *Saved · N*
 * receipt's *Undo* forgets exactly what that press kept. *Discard all* asks
 * once, then discards every listed one. What each press came to is announced
 * politely; the receipt outlives the list, which a keep may empty.
 */
export function MemoryBulkDecide({ items, onDone }: { readonly items: readonly MemoryItem[]; readonly onDone: () => void }) {
  const { client, workspaceId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string>();
  const [failure, setFailure] = useState<string>();
  /** What the last *Keep all* kept: what its receipt's Undo forgets. */
  const [saved, setSaved] = useState<readonly string[]>();
  const id = useId();
  const plain = items.filter(plainProposal).length;
  const ids = items.map((item) => item.recordId);
  const keepAll = (): void => {
    setBusy(true);
    setFailure(undefined);
    void decideAllMemory(client, workspaceId, ids, "keep").then((outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      const { kept, needsLook } = outcome.value;
      setSaved(kept.length === 0 ? undefined : kept);
      setNote(`Kept ${kept.length}${needsLook === 0 ? "" : ` · ${needsLook} needs a look`}.`);
      onDone();
    });
  };
  const discardAll = (): void => {
    setConfirming(false);
    setBusy(true);
    setFailure(undefined);
    void decideAllMemory(client, workspaceId, ids, "discard").then((outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setNote(`Discarded ${outcome.value.discarded}.`);
      onDone();
    });
  };
  const undo = (): void => {
    if (saved === undefined) return;
    setBusy(true);
    setFailure(undefined);
    void (async () => {
      let forgotten = 0;
      let refused: string | undefined;
      const waiting = new Set<string>();
      for (const recordId of saved) {
        const outcome = await forgetMemory(client, workspaceId, recordId);
        if (outcome.ok) {
          forgotten += 1;
          for (const provider of forgetWaitsFor(outcome.value)) waiting.add(provider);
        } else refused ??= outcome.message;
      }
      setBusy(false);
      setSaved(undefined);
      const providers = memoryPendingProvidersNote([...waiting].sort());
      setNote(`Forgotten ${forgotten}. ${MEMORY_FORGET_UNREACHED}${providers === undefined ? "" : ` ${providers}`}`);
      setFailure(refused);
      onDone();
    })();
  };
  if (items.length === 0 && note === undefined && saved === undefined) return null;
  return (
    <div className="memory-bulk" role="group" aria-labelledby={`${id}-bulk`}>
      <span id={`${id}-bulk`} className="visually-hidden">
        Every listed proposal
      </span>
      {items.length === 0 ? null : confirming ? (
        <div className="memory-actions">
          <InlineConfirm
            inline
            focusCancel
            message={`Discard all ${items.length} listed? Nothing of them is kept.`}
            confirmLabel="Discard all"
            cancelLabel="Cancel"
            busy={busy}
            onConfirm={discardAll}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : (
        <div className="memory-actions">
          {plain === 0 ? null : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              aria-label={`Keep all: the ${plural(plain, "plain proposal")} listed`}
              onClick={keepAll}
            >
              Keep all
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            aria-label={`Discard all: the ${plural(items.length, "proposal")} listed`}
            onClick={() => setConfirming(true)}
          >
            Discard all
          </Button>
        </div>
      )}
      {saved === undefined ? null : (
        <div className="memory-actions memory-receipt">
          <span>Saved · {saved.length}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Undo: forget the ${plural(saved.length, "memory", "memories")} just kept`}
            onClick={undo}
          >
            Undo
          </Button>
        </div>
      )}
      <StatusNote note={note} className="meta-sm" />
      {failure === undefined ? null : <Failure>{failure}</Failure>}
    </div>
  );
}
