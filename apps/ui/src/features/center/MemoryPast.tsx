import { useEffect, useId, useRef, useState } from "react";

import { type MemoryItem, MEMORY_IPC_LIST_MAX } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { mergeBy, useOlderPage } from "../../lib/paging.js";
import { localDate, shortDay } from "../../lib/time.js";
import { Failure, LoadMore } from "../../ui/Parts.js";
import { FormActions } from "../settings/FormParts.js";
import { keepMemoryLonger, listPastMemory } from "./memory-api.js";
import { KIND_LABELS, readOnly } from "./memory-model.js";
import { recordKey, type Context, endDay, RecordMeta, RecordText } from "./MemoryRecord.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/**
 * *Past*: ended facts, kept as history,
 * and expired preferences and lessons, erased `limits.proposalDays` after
 * they expired — each with *Keep longer*, a new end date that returns an
 * expired one to what is remembered.
 */
export function PastMemory({
  context,
  revision,
  onKept,
}: {
  readonly context: Context;
  readonly revision: number;
  readonly onKept: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [past, setPast] = useState<{ readonly records: readonly MemoryItem[]; readonly nextCursor: string | undefined }>();
  const [error, setError] = useState<string>();
  const id = useId();
  const generation = useRef(0);
  const older = useOlderPage(generation);
  useEffect(() => {
    let live = true;
    const current = ++generation.current;
    void listPastMemory(client, workspaceId, { limit: MEMORY_IPC_LIST_MAX }).then((outcome) => {
      if (!live || current !== generation.current) return;
      if (outcome.ok) {
        setPast({ records: outcome.value.records, nextCursor: outcome.value.nextCursor });
        setError(undefined);
      } else setError(outcome.message);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, revision]);
  const loadMore = (): void =>
    older.load(
      past?.nextCursor,
      (cursor) => listPastMemory(client, workspaceId, { cursor, limit: MEMORY_IPC_LIST_MAX }),
      (page) => {
        setError(undefined);
        setPast((held) => ({ records: mergeBy([held?.records, page.records], recordKey), nextCursor: page.nextCursor }));
      },
      setError,
    );
  if (error !== undefined && past === undefined)
    return (
      <Failure alert={false} className="memory-status">
        {error}
      </Failure>
    );
  if (past === undefined || past.records.length === 0) return null;
  return (
    <section className="memory-group memory-past" aria-labelledby={`${id}-past`}>
      <h3 className="eyebrow" id={`${id}-past`}>
        <span>{t("center.memoryPast.title")}</span>
        <span className="soul-figure">{past.nextCursor === undefined ? past.records.length : `${past.records.length}+`}</span>
      </h3>
      <ul className="list-reset">
        {past.records.map((item) => (
          <PastRow key={item.recordId} item={item} context={context} onKept={onKept} />
        ))}
      </ul>
      {error === undefined ? null : (
        <Failure alert={false} className="memory-status">
          {error}
        </Failure>
      )}
      {past.nextCursor === undefined ? null : <LoadMore busy={older.busy} onLoad={loadMore} label={t("center.memoryPast.loadMore")} />}
    </section>
  );
}
/** One past record: what it was, when it ended or expired and when it is erased, and *Keep longer*. */
function PastRow({ item, context, onKept }: { readonly item: MemoryItem; readonly context: Context; readonly onKept: () => void }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [until, setUntil] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const ids = useId();
  const locked = readOnly(item);
  const end = item.expiryAt ?? item.validTo;
  const ended = end === undefined ? undefined : shortDay(endDay(end, context.timeZone), context.today);
  const erased = item.erasesAt === undefined ? undefined : shortDay(localDate(item.erasesAt, context.timeZone), context.today);
  const when =
    item.expiryAt === undefined && item.validTo !== undefined
      ? t("center.memoryPast.ended", { day: ended ?? "" })
      : ended === undefined
        ? erased === undefined
          ? t("center.memoryPast.expired")
          : t("center.memoryPast.expiredErased", { erased })
        : erased === undefined
          ? t("center.memoryPast.expiredOn", { day: ended })
          : t("center.memoryPast.expiredOnErased", { day: ended, erased });
  const save = (): void => {
    if (until === undefined || until === "") {
      setFailure(t("center.memoryPast.pickDay"));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    void keepMemoryLonger(client, workspaceId, item, until).then((outcome) => {
      setBusy(false);
      if (outcome.ok) {
        setUntil(undefined);
        onKept();
        return;
      }
      setFailure(outcome.code === "MEMORY_CONFLICT" ? t("center.memoryPast.conflict") : outcome.message);
    });
  };
  return (
    <li className="memory-row">
      <div className="memory-row-main">
        <RecordText title={item.title} body={item.body} masked={item.redacted} truncated={item.truncated} />
        <RecordMeta item={item} context={context} extra={[KIND_LABELS[item.kind], when]} />
      </div>
      {locked ? null : until === undefined ? (
        <div className="memory-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setUntil(context.today)}
            aria-label={t("center.memoryPast.keepLongerFor", { name: item.title ?? KIND_LABELS[item.kind] })}
          >
            {t("center.memoryPast.keepLonger")}
          </Button>
        </div>
      ) : (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field id={`${ids}-until`} label={t("center.memoryPast.keepUntil")}>
            <input type="date" value={until} min={context.today} disabled={busy} onChange={(event) => setUntil(event.target.value)} />
          </Field>
          <FormActions
            small
            saving={busy}
            disabled={busy}
            cancelDisabled={busy}
            label={t("center.memoryPast.keepLonger")}
            onCancel={() => {
              setUntil(undefined);
              setFailure(undefined);
            }}
          />
        </form>
      )}
      {failure === undefined ? null : <Failure className="memory-row-note">{failure}</Failure>}
    </li>
  );
}
