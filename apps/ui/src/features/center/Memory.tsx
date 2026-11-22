import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryUsageAnswer,
  MEMORY_IPC_LIST_MAX,
  MEMORY_PARTIAL_MATCHES,
  memoryRecordIsPast,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

import { useT } from "../../lib/i18n.js";
import { useSearchQuery } from "../../hooks/page.js";
import { mergeBy, useOlderPage } from "../../lib/paging.js";
import { Empty } from "../../ui/Empty.js";
import { Icon } from "../../ui/Icon.js";
import { LoadMore, Pending, SearchField, StatusNote } from "../../ui/Parts.js";
import { LoadError } from "../settings/FormParts.js";
import { listMemory, MEMORY_PAGE_SIZE, memoryUsage, type AgentSummary } from "./memory-api.js";
import { groupByKind, otherPeopleLine, otherProposalsLine, refreshRecords, usageLine, type ListedRecords } from "./memory-model.js";
import { PastMemory } from "./MemoryPast.js";
import { proposalsHeadline, Proposal, MemoryBulkDecide } from "./MemoryProposals.js";
import { recordKey, type Context } from "./MemoryRecord.js";
import { RememberForm } from "./MemoryRememberForm.js";
import { MemoryRow } from "./MemoryRow.js";
import { MemorySettingsCard, type MemoryMode } from "./MemorySettingsCard.js";
import { TidyUpSuggestions } from "./MemoryTidyUp.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The Memory pane: what the agent proposes
 * to remember, for the reader to keep or discard, then what it remembers,
 * grouped by kind with where each record lives. Sensitive records stay masked
 * until revealed, one at a time. Shared records are the workspace's, changed
 * by an explicit share only, so they are read-only here.
 */

/** The id the proposals heading carries, so the rail's memory proposals land on it. */
export const MEMORY_PROPOSALS_ANCHOR = "memory-proposals";

interface Listed extends ListedRecords {
  readonly otherPeople: MemoryListAnswer["otherPeople"];
  readonly coverage: MemoryListAnswer["coverage"];
  /** `any` when no record held every word and these are partial matches. */
  readonly match?: MemoryListAnswer["match"] | undefined;
}

/** The proposals as loaded: every page read so far, where the next begins, and other people's still waiting. */
interface Proposals extends ListedRecords {
  readonly otherProposals: MemoryListAnswer["otherProposals"];
}

export function MemoryPane({
  agents,
  people,
  timeZone,
  today,
  revision,
  proposalCount,
  focusProposals,
  onProposalsFocused,
  onModels,
}: {
  readonly agents: readonly AgentSummary[];
  /** Settings → Models, where the capture model (the `extraction` role) is chosen; absent, its link is followed as an address. */
  readonly onModels?: (() => void) | undefined;
  /** How many proposals wait in all, from the feed's summary: "showing 50 of 120". */
  readonly proposalCount?: number | undefined;
  /** People's names by principal id, from the feed's summary. */
  readonly people: Readonly<Record<string, string>>;
  readonly timeZone: string | undefined;
  readonly today: string;
  /** Moves when the feed reports `memory`: the lists and the usage are read again. */
  readonly revision: number;
  /** The rail's memory proposals were followed: the proposals heading takes focus once shown. */
  readonly focusProposals: boolean;
  /** The focus request was served (or there were no proposals to land on). */
  readonly onProposalsFocused: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [search, setSearch] = useState("");
  const query = useSearchQuery(search);
  const [listed, setListed] = useState<Listed>();
  const [proposed, setProposed] = useState<Proposals>();
  const [usage, setUsage] = useState<MemoryUsageAnswer>();
  const [error, setError] = useState<string>();
  const [remembering, setRemembering] = useState(false);
  /** What the last forget here said of the providers its removal waits for. */
  const [forgotNote, setForgotNote] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const olderRecords = useOlderPage(generation);
  const olderProposals = useOlderPage(generation);
  const proposalsHeading = useRef<HTMLHeadingElement>(null);
  /** What is held, so a refresh reads as deep as the reader loaded. */
  const heldListed = useRef(listed);
  heldListed.current = listed;
  const heldProposals = useRef(proposed);
  heldProposals.current = proposed;
  /** The query the held records answer; a refresh lays itself over them only for the same listing. */
  const heldQuery = useRef<string | undefined>(undefined);
  /** Records open for correction, kept through a refresh that no longer lists them. */
  const editing = useRef(new Set<string>());
  const markEditing = useCallback((recordId: string, open: boolean): void => {
    if (open) editing.current.add(recordId);
    else editing.current.delete(recordId);
  }, []);
  const rememberId = useId();
  const agentNames = Object.fromEntries(agents.map((agent) => [agent.agentId, agent.name]));
  const context: Context = { timeZone, today, agentNames };

  const refresh = (): void => setAttempt((value) => value + 1);

  useEffect(() => {
    const current = ++generation.current;
    // A search is one page of best matches; a listing keeps the depth loaded.
    const same = heldQuery.current === query && query === "";
    const limit = same
      ? Math.min(MEMORY_IPC_LIST_MAX, Math.max(MEMORY_PAGE_SIZE, heldListed.current?.records.length ?? 0))
      : MEMORY_PAGE_SIZE;
    // The proposals keep the depth loaded too, so a refresh does not drop a page the reader opened.
    const proposalLimit = Math.min(MEMORY_IPC_LIST_MAX, Math.max(MEMORY_PAGE_SIZE, heldProposals.current?.records.length ?? 0));
    void Promise.all([
      listMemory(client, workspaceId, { status: "approved", query, limit }),
      listMemory(client, workspaceId, { status: "proposed", limit: proposalLimit }),
      memoryUsage(client, workspaceId),
    ]).then(([records, proposals, used]) => {
      if (current !== generation.current) return;
      const failure = !records.ok ? records.message : !proposals.ok ? proposals.message : !used.ok ? used.message : undefined;
      setError(failure);
      if (records.ok) {
        const page: Listed = {
          records: records.value.records,
          nextCursor: records.value.nextCursor,
          otherPeople: records.value.otherPeople,
          coverage: records.value.coverage,
          match: records.value.match,
        };
        heldQuery.current = query;
        setListed((before) => (same ? refreshRecords(before, page, limit, editing.current) : page));
      }
      if (proposals.ok) {
        const page: Proposals = {
          records: proposals.value.records,
          nextCursor: proposals.value.nextCursor,
          otherProposals: proposals.value.otherProposals,
        };
        setProposed((before) => refreshRecords(before, page, proposalLimit, new Set()));
      }
      if (used.ok) setUsage(used.value);
    });
  }, [client, workspaceId, query, revision, attempt]);

  const proposals = proposed?.records;
  useEffect(() => {
    if (!focusProposals || proposals === undefined) return;
    const heading = proposalsHeading.current;
    heading?.scrollIntoView?.({ block: "start" });
    heading?.focus({ preventScroll: true });
    onProposalsFocused();
  }, [focusProposals, proposals, onProposalsFocused]);

  const loadMore = (): void =>
    olderRecords.load(
      listed?.nextCursor,
      (cursor) => listMemory(client, workspaceId, { status: "approved", query, cursor }),
      (page) => {
        setError(undefined);
        setListed((held) => ({
          records: mergeBy([held?.records, page.records], recordKey),
          nextCursor: page.nextCursor,
          otherPeople: page.otherPeople,
          coverage: page.coverage,
        }));
      },
      setError,
    );

  const loadMoreProposals = (): void =>
    olderProposals.load(
      proposed?.nextCursor,
      (cursor) => listMemory(client, workspaceId, { status: "proposed", cursor }),
      (page) => {
        setError(undefined);
        setProposed((held) => ({
          records: mergeBy([held?.records, page.records], recordKey),
          nextCursor: page.nextCursor,
          otherProposals: page.otherProposals ?? held?.otherProposals,
        }));
      },
      setError,
    );

  /** A record changed here: shown as the owner answered, then everything read again. */
  const replaced = (record: MemoryItem): void => {
    setListed((held) =>
      held === undefined ? held : { ...held, records: held.records.map((item) => (item.recordId === record.recordId ? record : item)) },
    );
    refresh();
  };
  const removed = (recordId: string, waiting?: string): void => {
    // A forget whose removal a provider could not take now says which, as every forget's receipt does.
    setForgotNote(waiting);
    setListed((held) => (held === undefined ? held : { ...held, records: held.records.filter((item) => item.recordId !== recordId) }));
    setProposed((held) => (held === undefined ? held : { ...held, records: held.records.filter((item) => item.recordId !== recordId) }));
    refresh();
  };

  // What ended or expired is listed under *Past*, not as memory in force.
  const nowIso = nowTimestamp();
  const records = (listed?.records ?? []).filter((item) => !memoryRecordIsPast(item, nowIso));
  const groups = groupByKind(records);
  const others = listed === undefined ? undefined : otherPeopleLine(listed.otherPeople, people);
  const othersProposing = otherProposalsLine(proposed?.otherProposals, people);
  // The summary's count, once it is at least what is loaded: it trails a decision made here by a moment.
  const proposalTotal =
    proposals !== undefined && proposalCount !== undefined && proposalCount >= proposals.length ? proposalCount : undefined;
  const loaded = listed !== undefined && proposals !== undefined;
  /** Whether memory is on and proposes, as the settings card read it: the empty text says what will happen. */
  const [mode, setMode] = useState<MemoryMode>();
  const nothing = loaded && records.length === 0 && (proposals?.length ?? 0) === 0 && query === "";

  return (
    <section className="soul-pane card-flat" aria-labelledby="memory-title">
      <header className="soul-pane-head">
        <span className="soul-glyph soul-glyph-memory" aria-hidden="true">
          <Icon name="center-soul" size="sm" />
        </span>
        <div>
          <h2 id="memory-title">{t("center.memory.title")}</h2>
          <p className="soul-pane-sub meta-sm soul-figure">{usage === undefined ? " " : usageLine(usage)}</p>
        </div>
        {/* Opens only: a half-filled form is closed by its own Cancel, never by a second press here. */}
        <Button size="sm" aria-expanded={remembering} aria-controls={rememberId} onClick={() => setRemembering(true)}>
          <Icon name="plus" size="sm" />
          {t("center.memory.remember")}
        </Button>
      </header>

      <MemorySettingsCard onModels={onModels} onMode={setMode} />

      {remembering ? (
        <RememberForm
          id={rememberId}
          agents={agents}
          onDone={(saved) => {
            setRemembering(false);
            if (saved) refresh();
          }}
        />
      ) : null}

      {error === undefined ? null : (
        <div className="memory-status">
          <LoadError error={error} reload={refresh} />
        </div>
      )}

      {proposals === undefined || proposals.length === 0 ? null : (
        <section className="memory-proposals" aria-labelledby={MEMORY_PROPOSALS_ANCHOR}>
          <h3 id={MEMORY_PROPOSALS_ANCHOR} tabIndex={-1} ref={proposalsHeading}>
            <Icon name="sparkles" size="sm" />
            {proposalsHeadline(
              proposed?.nextCursor === undefined ? proposals.length : (proposalTotal ?? proposals.length),
              proposed?.nextCursor !== undefined && proposalTotal === undefined,
            )}
          </h3>
          <ul className="list-reset">
            {proposals
              .filter((item) => item.supersedes === undefined)
              .map((item) => (
                <Proposal key={item.recordId} item={item} context={context} onDecided={removed} />
              ))}
          </ul>
          <TidyUpSuggestions items={proposals.filter((item) => item.supersedes !== undefined)} context={context} onDecided={removed} />
          {proposed?.nextCursor === undefined ? null : (
            <LoadMore
              busy={olderProposals.busy}
              onLoad={loadMoreProposals}
              label={t("center.memory.loadMore")}
              className="center-more memory-proposals-more"
            >
              <span className="muted">
                {proposalTotal === undefined
                  ? t("center.memory.showingFirst", { count: proposals.length })
                  : t("center.memory.showingOf", { count: proposals.length, total: proposalTotal })}
              </span>
            </LoadMore>
          )}
        </section>
      )}
      {proposals === undefined ? null : <MemoryBulkDecide items={proposals} onDone={refresh} />}
      {othersProposing === undefined ? null : <p className="memory-others meta-sm">{othersProposing}</p>}

      <div className="memory-search">
        <SearchField value={search} placeholder={t("center.memory.search")} label={t("center.memory.search")} onChange={setSearch} />
      </div>

      {!loaded && error === undefined ? <Pending label={t("center.memory.loading")} className="notice memory-status" status /> : null}
      {nothing ? (
        <Empty className="memory-status">
          {mode?.enabled === false
            ? t("center.memory.emptyPaused")
            : mode?.capture === "off"
              ? t("center.memory.emptyNoSuggestions")
              : t("center.memory.empty")}
        </Empty>
      ) : null}
      {listed !== undefined && query !== "" && records.length === 0 ? (
        <Empty className="memory-status">
          {listed.coverage === "unavailable" ? t("center.memory.searchUnavailable") : t("center.memory.noMatches", { query })}
        </Empty>
      ) : null}
      {listed?.match === "any" && query !== "" && records.length > 0 ? (
        <p className="memory-status meta-sm" role="status">
          {MEMORY_PARTIAL_MATCHES}
        </p>
      ) : null}
      <StatusNote note={forgotNote} className="notice memory-status" />

      {groups.map((group) => (
        <section key={group.kind} className="memory-group" aria-labelledby={`memory-group-${group.kind}`}>
          <h3 className="eyebrow" id={`memory-group-${group.kind}`}>
            <span>{group.label}</span>
            <span className="soul-figure">{group.records.length}</span>
          </h3>
          <ul className="list-reset">
            {group.records.map((item) => (
              <MemoryRow
                key={item.recordId}
                item={item}
                context={context}
                onReplaced={replaced}
                onRemoved={removed}
                onStale={refresh}
                onEditing={markEditing}
              />
            ))}
          </ul>
        </section>
      ))}

      {listed?.nextCursor === undefined ? null : (
        <LoadMore busy={olderRecords.busy} onLoad={loadMore} label={t("center.memory.loadMore")} />
      )}
      {query === "" ? <PastMemory context={context} revision={revision + attempt} onKept={refresh} /> : null}
      {others === undefined ? null : <p className="memory-others meta-sm">{others}</p>}
    </section>
  );
}
