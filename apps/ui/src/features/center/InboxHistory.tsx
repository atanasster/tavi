import { useEffect, useRef, useState } from "react";

import type { ApprovalHistoryItem, ApprovalHistoryKind } from "@tavi/contracts";

import { appendPage, refreshFirstPage, useOlderPage, type Paged } from "../../lib/paging.js";
import { Empty } from "../../ui/Empty.js";
import { FilterChip, LoadMore, LoadState, PersonChips } from "../../ui/Parts.js";
import { AppLink } from "../shell/AppLink.js";
import { settingsPath, taskPath } from "../shell/route.js";
import { listHistory } from "./approvals-api.js";
import {
  deciderLabel,
  historyFilters,
  historyKey,
  KIND_FILTERS,
  SCOPE_LABELS,
  VERDICT_LABELS,
  verdictFilters,
  verdictOf,
  whenLabel,
  type VerdictFilter,
} from "./inbox-model.js";
import { manyPeople } from "./model.js";
import { useWorkspace } from "../shell/Workspace.js";
import { useT } from "../../lib/i18n.js";

const decidedAt = (item: ApprovalHistoryItem): string => item.decidedAt;
/** The decisions made before, newest first, a page at a time. */
export function HistoryTable({
  revision,
  timeZone,
  today,
  people,
  onOpen,
  onPermissions,
}: {
  readonly revision: number;
  readonly timeZone: string | undefined;
  readonly today: string;
  readonly people: Readonly<Record<string, string>>;
  readonly onOpen: (taskId: string) => void;
  readonly onPermissions: (ruleId?: string) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [kind, setKind] = useState<ApprovalHistoryKind | "all">("all");
  const [verdict, setVerdict] = useState<VerdictFilter | "all">("all");
  const [person, setPerson] = useState<string>("all");
  const [tool, setTool] = useState<string>("all");
  /** Every tool an approval loaded here was for, in the order first seen: the tool chips. */
  const [tools, setTools] = useState<readonly string[]>([]);
  const [history, setHistory] = useState<Paged<ApprovalHistoryItem>>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  /** The read whose answer counts; an older one's answer is dropped. */
  const generation = useRef(0);
  const older = useOlderPage(generation);
  /** The filters the held items answer, so a refresh knows it may lay a page over them. */
  const heldFilters = useRef<string | undefined>(undefined);
  const many = manyPeople(people);
  const filters = historyFilters(kind, verdict, many ? person : "all", tool);
  const seeTools = (items: readonly ApprovalHistoryItem[]): void =>
    setTools((held) => {
      const fresh = items.flatMap((item) => (item.kind === "approval" && !held.includes(item.toolId) ? [item.toolId] : []));
      return fresh.length === 0 ? held : [...held, ...new Set(fresh)];
    });

  useEffect(() => {
    const current = ++generation.current;
    const asked = historyFilters(kind, verdict, many ? person : "all", tool);
    const key = JSON.stringify(asked);
    void listHistory(client, workspaceId, asked).then((outcome) => {
      if (current !== generation.current) return;
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setError(undefined);
      const same = heldFilters.current === key;
      heldFilters.current = key;
      seeTools(outcome.value.items);
      setHistory((held) => refreshFirstPage(same ? held : undefined, outcome.value, historyKey, decidedAt));
    });
  }, [client, workspaceId, kind, verdict, person, tool, many, revision, attempt]);

  const loadMore = (): void =>
    older.load(
      history?.nextCursor,
      (cursor) => listHistory(client, workspaceId, filters, cursor),
      (page) => {
        setError(undefined);
        seeTools(page.items);
        setHistory((held) => appendPage(held, page, historyKey));
      },
      setError,
    );

  const pickKind = (next: ApprovalHistoryKind | "all"): void => {
    setKind(next);
    if (verdict !== "all" && !verdictFilters(next).includes(verdict)) setVerdict("all");
    // A tool names approvals only.
    if (next !== "all" && next !== "approval") setTool("all");
  };
  const items = history?.items ?? [];
  const toolChips = kind === "all" || kind === "approval" ? tools : [];
  const filtered = kind !== "all" || verdict !== "all" || (many && person !== "all") || tool !== "all";

  return (
    <>
      <h2 className="center-subhead">{t("center.inboxHistory.title")}</h2>
      <div className="center-chips" role="group" aria-label={t("center.inboxHistory.filterByKind")}>
        {KIND_FILTERS.map((item) => (
          <FilterChip key={item.value} pressed={kind === item.value} onPick={() => pickKind(item.value)}>
            {t(item.labelKey)}
          </FilterChip>
        ))}
      </div>
      <div className="center-chips" role="group" aria-label={t("center.inboxHistory.filterByDecision")}>
        <FilterChip pressed={verdict === "all"} onPick={() => setVerdict("all")}>
          {t("center.inboxHistory.anyDecision")}
        </FilterChip>
        {verdictFilters(kind).map((item) => (
          <FilterChip key={item} pressed={verdict === item} onPick={() => setVerdict(item)}>
            {VERDICT_LABELS[item]}
          </FilterChip>
        ))}
      </div>
      {toolChips.length > 1 || tool !== "all" ? (
        <div className="center-chips" role="group" aria-label={t("center.inboxHistory.filterByTool")}>
          <FilterChip pressed={tool === "all"} onPick={() => setTool("all")}>
            {t("center.inboxHistory.anyTool")}
          </FilterChip>
          {toolChips.map((toolId) => (
            <FilterChip key={toolId} pressed={tool === toolId} onPick={() => setTool(toolId)}>
              <code>{toolId}</code>
            </FilterChip>
          ))}
        </div>
      ) : null}
      {many ? <PersonChips people={people} person={person} onPick={setPerson} /> : null}
      <LoadState
        error={error}
        reload={() => setAttempt((value) => value + 1)}
        loading={history === undefined && error === undefined}
        label={t("center.inboxHistory.loading")}
        status
      />
      {history !== undefined && items.length === 0 ? (
        <Empty className="center-empty">{filtered ? t("center.inboxHistory.noMatch") : t("center.inboxHistory.empty")}</Empty>
      ) : null}
      {items.length === 0 ? null : (
        <div className="center-table-wrap card-flat">
          <table className="center-history">
            <thead>
              <tr>
                <th scope="col">{t("center.inboxHistory.column.decision")}</th>
                <th scope="col">{t("center.inboxHistory.column.request")}</th>
                <th scope="col">{t("center.inboxHistory.column.task")}</th>
                <th scope="col">{t("center.inboxHistory.column.byVia")}</th>
                <th scope="col">{t("center.inboxHistory.column.scope")}</th>
                <th scope="col">{t("center.inboxHistory.column.when")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <HistoryRow
                  key={historyKey(item)}
                  item={item}
                  timeZone={timeZone}
                  today={today}
                  people={people}
                  onOpen={onOpen}
                  onPermissions={onPermissions}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history?.nextCursor === undefined ? null : (
        <LoadMore busy={older.busy} onLoad={loadMore} label={t("center.inboxHistory.loadMore")} />
      )}
    </>
  );
}
function HistoryRow({
  item,
  timeZone,
  today,
  people,
  onOpen,
  onPermissions,
}: {
  readonly item: ApprovalHistoryItem;
  readonly timeZone: string | undefined;
  readonly today: string;
  readonly people: Readonly<Record<string, string>>;
  readonly onOpen: (taskId: string) => void;
  readonly onPermissions: (ruleId?: string) => void;
}) {
  const t = useT();
  const verdict = verdictOf(item.state);
  // A question answered before who and how were recorded names neither.
  const by = deciderLabel(item.decidedBy, people);
  const through = item.kind === "review" || item.kind === "connect" ? undefined : (item.channel ?? item.via);
  // The policy is named in the page's language, by and via alike.
  const via = through === "policy" ? t("center.inboxModel.policy") : through;
  return (
    <tr>
      <td>
        <span className={`center-verdict center-verdict-${verdict}`}>{VERDICT_LABELS[verdict]}</span>
      </td>
      <td>
        {/* The stack is a div of its own: a cell set to grid stops being a cell, and the row's border breaks there. */}
        <div className="center-history-request">
          {item.kind === "approval" ? (
            <>
              {item.summary === undefined ? null : <div>{item.summary}</div>}
              <code className="center-tool">{item.toolId}</code>
            </>
          ) : item.kind === "review" ? (
            <>
              <div>{t("center.inboxHistory.reviewOfResult")}</div>
              <code className="center-tool">{item.contentType}</code>
            </>
          ) : item.kind === "connect" ? (
            <div>{t("center.inboxHistory.signInAgain", { app: item.appName })}</div>
          ) : (
            <>
              <div>{item.question}</div>
              <div className="center-history-note meta-sm">
                {item.answer === null ? item.state === "answered" ? t("center.inboxModel.verdict.answered") : null : <>→ {item.answer}</>}
              </div>
            </>
          )}
          {(item.kind === "approval" || item.kind === "review") && item.note !== null && item.note !== "" ? (
            <div className="center-history-note meta-sm">{t("center.inboxHistory.quoted", { text: item.note })}</div>
          ) : null}
        </div>
      </td>
      <td className="center-history-task">
        {item.taskId === undefined ? (
          "—"
        ) : (
          <AppLink href={taskPath(item.taskId)} onFollow={() => onOpen(item.taskId as string)}>
            {item.taskTitle ?? item.taskId}
          </AppLink>
        )}
      </td>
      {/* A decision made by policy is "policy" by and via: said once. */}
      <td>{[by ?? "—", ...(via === undefined || via === by ? [] : [via])].join(" · ")}</td>
      <td>
        {item.kind === "approval" && item.scope !== undefined ? (
          <>
            <span className={`center-scope center-scope-${item.scope}`}>{SCOPE_LABELS[item.scope]}</span>
            {item.scope === "always" && item.ruleId !== undefined ? (
              <div>
                <AppLink
                  href={settingsPath("permissions", `rule-${encodeURIComponent(item.ruleId)}`)}
                  onFollow={() => onPermissions(item.ruleId)}
                >
                  {t("center.inboxHistory.revoke")}
                </AppLink>
              </div>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="center-history-when">
        <time dateTime={item.decidedAt}>{whenLabel(item.decidedAt, timeZone, today)}</time>
      </td>
    </tr>
  );
}
