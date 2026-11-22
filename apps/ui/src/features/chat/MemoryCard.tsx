import {
  memoryCardHeading,
  memoryCardItemIsPlain,
  memoryCardItemName,
  memoryCardProvenanceLine,
  memoryCardStateLabel,
  memoryKeptAllText,
  memoryMayUpdateLine,
  memoryUpdatesLine,
  type MemoryCardAnswer,
  type MemoryCardItem,
} from "@tavi/contracts";
import { useCallback, useEffect, useId, useState } from "react";

import { replaceMemory } from "../center/memory-api.js";
import { decideMemory, decideMemoryCard, keepEditedMemory, loadMemoryBody, loadMemoryCard, undoMemory } from "../chat-panel/api.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { Failure, StatusNote } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/**
 * A memory card in the transcript:
 * what a turn, or an epoch's flush, proposed — *Keep*, *Edit*, *Discard* — and
 * what is saved — *Undo*, which forgets it. The card is read from the owner
 * each time (`memory {action: "card"}`): it holds ids, and its text and state
 * are the memory rows' now, so a card decided in the Center shows as decided
 * and a forgotten record as "Forgotten". Every action is a real button named
 * with its record; the heading is a polite live region, so a new card, and
 * each decision, is announced.
 *
 * A digest's card also has *Keep all*, *Discard all* and
 * *Review*: *Keep all* keeps only the plain proposals it lists and
 * posts a *Saved · N* card whose Undo forgets exactly those.
 *
 * An update — a proposal whose preference key or fact's topic a kept
 * record holds — names what it updates and offers *Replace* (the kept record
 * corrected to it, the proposal discarded as applied) and, a fact, *Keep
 * both*, in place of *Keep* and *Edit*; *Keep all* leaves it waiting. A near
 * duplicate says what it is similar to. A tidy-up is marked to be
 * compared in the Center, where it is kept with its before and after: here it
 * has only *Discard* and *Open*, and *Keep all* leaves it waiting too.
 *
 * One proposed after its chat read untrusted content
 * says what the chat read, and is kept by its own *Keep*: *Keep all* leaves
 * it waiting.
 */
export function MemoryCard({
  noticeId,
  version,
  connected = true,
  onReview,
}: {
  readonly noticeId: string;
  /** Read again when it changes: the notice was posted again with more on it, or memory changed elsewhere. */
  readonly version?: string | undefined;
  readonly connected?: boolean;
  /** Center → Soul & memory, where everything that waits is listed; absent where the Center has no such page. */
  readonly onReview?: (() => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [card, setCard] = useState<MemoryCardAnswer | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ readonly recordId: string; readonly text: string } | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const editId = useId();

  const reload = useCallback(async (): Promise<void> => {
    const outcome = await loadMemoryCard(client, workspaceId, noticeId);
    if (outcome.ok) setCard(outcome.value);
    else setFailure(outcome.message);
  }, [client, workspaceId, noticeId]);

  useEffect(() => {
    let current = true;
    void loadMemoryCard(client, workspaceId, noticeId).then((outcome) => {
      if (!current) return;
      if (outcome.ok) setCard(outcome.value);
      else setFailure(outcome.message);
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, noticeId, version]);

  if (card === undefined) return <Failure message={failure} alert={false} />;

  /** Run one action, then read the card again: whatever happened elsewhere meanwhile shows too. */
  const act = (run: () => Promise<{ readonly ok: boolean; readonly message?: string }>): void => {
    setBusy(true);
    void run().then(async (outcome) => {
      setFailure(outcome.ok ? undefined : outcome.message);
      await reload();
      setBusy(false);
    });
  };
  const startEdit = (item: MemoryCardItem): void => {
    act(async () => {
      const body = await loadMemoryBody(client, workspaceId, item.recordId);
      if (body.ok) setEditing({ recordId: item.recordId, text: body.value });
      return body;
    });
  };
  const disabled = busy || !connected;
  const heading = memoryCardHeading(card, translateCore);
  const waiting = card.items.filter((item) => item.state === "proposed");
  const plainWaiting = waiting.filter(memoryCardItemIsPlain).length;
  /** A digest's proposals past the ten it lists. */
  const digestMore = card.digest === undefined ? 0 : Math.max(0, card.digest.waiting - card.items.length - card.forgotten);
  return (
    <article className="memory-card" aria-label={t("chat.memoryCard.label", { heading })} data-memory-card={card.noticeId}>
      <p className="memory-card-heading" role="status" aria-live="polite">
        {heading}
      </p>
      {card.items.length === 0 ? null : (
        <ul className="memory-card-items">
          {card.items.map((item) => {
            const name = memoryCardItemName(item, translateCore);
            const editingThis = editing?.recordId === item.recordId;
            return (
              <li key={item.token} className="memory-card-item" data-state={item.state}>
                <p className="memory-card-title">
                  {card.items.length > 1 ? <span className="memory-card-number">{item.number}. </span> : null}
                  {name}
                  {item.state !== "proposed" && card.items.length > 1 ? (
                    <span className="meta-sm"> · {memoryCardStateLabel(item.state, translateCore)}</span>
                  ) : null}
                </p>
                {item.excerpt === null || editingThis ? null : <p className="memory-card-excerpt">{item.excerpt}</p>}
                {item.state === "proposed" && item.updates !== undefined ? (
                  <p className="meta-sm memory-card-related">{memoryUpdatesLine(item.updates, translateCore)}</p>
                ) : item.state === "proposed" && item.mayUpdate !== undefined ? (
                  <p className="meta-sm memory-card-related">{memoryMayUpdateLine(item.mayUpdate, translateCore)}</p>
                ) : null}
                {item.state === "proposed" && item.similarTo !== undefined ? (
                  <p className="meta-sm memory-card-related">
                    {t("chat.memoryCard.similar", { title: item.similarTo.title ?? t("chat.memoryCard.aKeptMemory") })}
                  </p>
                ) : null}
                {item.state === "proposed" && item.tidyUp === true && item.updates === undefined && item.mayUpdate === undefined ? (
                  <p className="meta-sm memory-card-related">{translateCore("memory.card.tidyUpLook")}</p>
                ) : null}
                {item.state === "proposed" && memoryCardProvenanceLine(item, translateCore) !== undefined ? (
                  <p className="meta-sm memory-card-related memory-card-provenance">
                    {memoryCardProvenanceLine(item, translateCore)}
                    {waiting.length > 1 ? ` · ${translateCore("memory.card.keepAllLeavesIt")}` : ""}
                  </p>
                ) : null}
                {editingThis ? (
                  <form
                    className="memory-card-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const text = editing.text.trim();
                      if (text === "") return;
                      act(async () => {
                        const outcome = await keepEditedMemory(client, workspaceId, item, text);
                        if (outcome.ok) setEditing(undefined);
                        return outcome;
                      });
                    }}
                  >
                    <Field id={`${editId}-${item.number}`} label={t("chat.memoryCard.editName", { name })}>
                      <textarea
                        value={editing.text}
                        rows={3}
                        onChange={(event) => setEditing({ recordId: item.recordId, text: event.target.value })}
                      />
                    </Field>
                    <div className="memory-card-actions">
                      <Button size="sm" type="submit" disabled={disabled || editing.text.trim() === ""}>
                        {t("chat.memoryCard.saveKeep")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
                        {t("chat.memoryCard.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : item.state === "proposed" && (item.updates !== undefined || item.mayUpdate !== undefined) ? (
                  <div className="memory-card-actions">
                    <Button
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.replaceName", { name })}
                      onClick={() => act(() => replaceMemory(client, workspaceId, item))}
                    >
                      {t("chat.memoryCard.replace")}
                    </Button>
                    {item.kind === "fact" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={t("chat.memoryCard.keepBothName", { name })}
                        onClick={() => act(() => decideMemory(client, workspaceId, item, "approve"))}
                      >
                        {t("chat.memoryCard.keepBoth")}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.discardName", { name })}
                      onClick={() => act(() => decideMemory(client, workspaceId, item, "reject"))}
                    >
                      {t("chat.memoryCard.discard")}
                    </Button>
                  </div>
                ) : item.state === "proposed" && item.tidyUp === true ? (
                  <div className="memory-card-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.discardName", { name })}
                      onClick={() => act(() => decideMemory(client, workspaceId, item, "reject"))}
                    >
                      {t("chat.memoryCard.discard")}
                    </Button>
                    {onReview === undefined ? null : (
                      <Button variant="ghost" size="sm" aria-label={t("chat.memoryCard.openName", { name })} onClick={onReview}>
                        {t("chat.memoryCard.open")}
                      </Button>
                    )}
                  </div>
                ) : item.state === "proposed" ? (
                  <div className="memory-card-actions">
                    <Button
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.keepName", { name })}
                      onClick={() => act(() => decideMemory(client, workspaceId, item, "approve"))}
                    >
                      {t("chat.memoryCard.keep")}
                    </Button>
                    {item.sensitive ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={t("chat.memoryCard.editName", { name })}
                        onClick={() => startEdit(item)}
                      >
                        {t("chat.memoryCard.edit")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.discardName", { name })}
                      onClick={() => act(() => decideMemory(client, workspaceId, item, "reject"))}
                    >
                      {t("chat.memoryCard.discard")}
                    </Button>
                  </div>
                ) : item.state === "saved" ? (
                  <div className="memory-card-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("chat.memoryCard.undoName", { name })}
                      onClick={() => act(() => undoMemory(client, workspaceId, item.recordId))}
                    >
                      {t("chat.memoryCard.undo")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {card.forgotten > 0 && card.items.length > 0 ? (
        <p className="meta-sm memory-card-forgotten">{t("chat.memoryCard.forgotten", { count: card.forgotten })}</p>
      ) : null}
      {digestMore > 0 && waiting.length > 0 ? (
        <p className="meta-sm memory-card-more">{t("chat.memoryCard.more", { count: digestMore })}</p>
      ) : null}
      {card.digest !== undefined && (waiting.length > 0 || onReview !== undefined) ? (
        <div className="memory-card-actions">
          {plainWaiting > 0 ? (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                act(async () => {
                  const outcome = await decideMemoryCard(client, workspaceId, card.noticeId, "keep");
                  if (outcome.ok) setNote(`${memoryKeptAllText(outcome.value.kept, outcome.value.needsLook, translateCore)}.`);
                  return outcome;
                })
              }
            >
              {t("chat.memoryCard.keepAll")}
            </Button>
          ) : null}
          {waiting.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() =>
                act(async () => {
                  const outcome = await decideMemoryCard(client, workspaceId, card.noticeId, "discard");
                  if (outcome.ok) setNote(t("chat.memoryCard.discarded", { count: outcome.value.discarded }));
                  return outcome;
                })
              }
            >
              {t("chat.memoryCard.discardAll")}
            </Button>
          ) : null}
          {onReview === undefined ? null : (
            <Button variant="ghost" size="sm" onClick={onReview}>
              {t("chat.memoryCard.review")}
            </Button>
          )}
        </div>
      ) : null}
      <StatusNote note={note} className="notice status-note" />
      <Failure message={failure} alert={false} />
    </article>
  );
}
