import { TaviError, memoryProvenanceUntrusted, type MemoryItem, type MemoryPayload } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

/**
 * How a person decides waiting memory, in one place for every surface: a
 * card's buttons on a channel, `/memory keep | discard`, and a card's or a
 * digest's *Keep all* / *Discard all* in the app.
 *
 * **The one *Keep all* rule.** A bulk keep keeps only the plain proposals it
 * was given — the ones listed at that moment. A sensitive proposal, an update
 * (a record in force holds its preference key or fact's topic key,
 * `MemoryItem.updates`, decided by *Replace* or *Keep both* in the app), a
 * tidy-up (`MemoryItem.supersedes`: it changes records already kept,
 * so its before and after are read first), one proposed after its chat read
 * untrusted content (`MemoryItem.provenance`: what the
 * chat read is shown with it, and only a person's own look keeps it), or one
 * another kept value took the key of meanwhile (`MEMORY_CONFLICT`), stays
 * waiting and is counted as needing a look. *Discard all* has no exclusions:
 * discarding loses nothing the person cannot add again. The caller posts the
 * *Saved · N* receipt of what was kept, whose Undo forgets exactly those.
 */

/**
 * What deciding one record came to: done, refused for another kept value, a tidy-up kept from somewhere other than
 * the Center (`tidy`: its before and after are compared there first), a tidy-up whose input changed since it was
 * suggested (`stale`), or what it already is in a person's words.
 */
export type MemoryDecision = "done" | "conflict" | "tidy" | "stale" | "Already kept" | "Already discarded" | "No longer waiting";

/** What a stale tidy-up tells the person, in the Center's words. */
export const MEMORY_TIDY_STALE = coreEnglish("channel.memory.tidyStale");

/** A record that no longer waits, as a press or a command says it in `t`'s words. */
export function memoryDecisionWords(
  outcome: Exclude<MemoryDecision, "done" | "conflict" | "tidy" | "stale">,
  t: CoreT = coreEnglish,
): string {
  return t(
    outcome === "Already kept"
      ? "channel.memory.already.kept"
      : outcome === "Already discarded"
        ? "channel.memory.already.discarded"
        : "channel.memory.already.noLongerWaiting",
  );
}

/** A record's state as a press or a command says it once it no longer waits. */
function memoryStatusWords(status: string | undefined): Exclude<MemoryDecision, "done" | "conflict" | "tidy" | "stale"> {
  return status === "approved" ? "Already kept" : status === "rejected" ? "Already discarded" : "No longer waiting";
}

/**
 * Keep or discard one record held to its current revision. A record that no
 * longer waits, or one decided elsewhere meanwhile (its compare-and-set lost
 * the race), answers what it is now; an update, or another value kept
 * for its key, answers `conflict` — it needs a look in the app, where it is
 * replaced, so the person never meets `MEMORY_CONFLICT` for it. A tidy-up
 * is never kept from a card, a channel or a command: it answers
 * `tidy`, and is kept in the Center with its before and after.
 */
export async function decideMemoryRecord(input: {
  readonly record: MemoryItem;
  readonly decision: "approve" | "reject";
  /** The `memory` command, as the deciding person. */
  readonly run: (payload: MemoryPayload) => Promise<unknown>;
  /** The record as it is now, after a lost race. */
  readonly reread: () => Promise<MemoryItem | undefined>;
}): Promise<MemoryDecision> {
  const { record, decision } = input;
  if (record.status !== "proposed") return memoryStatusWords(record.status);
  if (decision === "approve" && (record.updates !== undefined || record.mayUpdate !== undefined)) return "conflict";
  if (decision === "approve" && record.supersedes !== undefined) return "tidy";
  try {
    await input.run({
      action: decision,
      recordId: record.recordId,
      ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
    } as MemoryPayload);
    return "done";
  } catch (error) {
    const failure = TaviError.from(error);
    if (failure.code === "MEMORY_CONFLICT") return "conflict";
    // A tidy-up whose input changed since it was suggested still waits: it is stale, and a new run suggests it again.
    if (failure.code === "REVISION_CONFLICT" && record.supersedes !== undefined && (await input.reread())?.status === "proposed")
      return "stale";
    if (failure.code === "REVISION_CONFLICT" || failure.code === "CONFLICT") return memoryStatusWords((await input.reread())?.status);
    throw failure;
  }
}

/**
 * *Keep all* under the one rule: of `records`, the waiting plain ones are
 * kept; a waiting sensitive one, an update, a tidy-up, one with untrusted
 * provenance, and one refused for another kept value, are counted in
 * `needsLook`. Records that no longer wait are passed over.
 */
export async function keepAllPlain(
  records: readonly MemoryItem[],
  decide: (record: MemoryItem) => Promise<MemoryDecision>,
): Promise<{ readonly kept: readonly string[]; readonly needsLook: number }> {
  const kept: string[] = [];
  let needsLook = 0;
  for (const record of records) {
    if (record.status !== "proposed") continue;
    // A sensitive proposal is read first, an update is replaced, a tidy-up's before and after are
    // compared, and one proposed after its chat read untrusted content is looked at: none is kept in bulk.
    if (
      record.sensitivity === "sensitive" ||
      record.updates !== undefined ||
      record.mayUpdate !== undefined ||
      record.supersedes !== undefined ||
      memoryProvenanceUntrusted(record.provenance)
    ) {
      needsLook += 1;
      continue;
    }
    const outcome = await decide(record);
    if (outcome === "done") kept.push(record.recordId);
    else if (outcome === "conflict" || outcome === "tidy" || outcome === "stale") needsLook += 1;
  }
  return { kept, needsLook };
}

/** *Discard all*: every waiting record of `records`, with no exclusions; how many were discarded. */
export async function discardAll(records: readonly MemoryItem[], decide: (record: MemoryItem) => Promise<MemoryDecision>): Promise<number> {
  let discarded = 0;
  for (const record of records) if (record.status === "proposed" && (await decide(record)) === "done") discarded += 1;
  return discarded;
}
