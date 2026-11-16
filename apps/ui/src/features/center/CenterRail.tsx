import { MCP_PLUGIN_PREFIX, type CenterSummaryAnswer } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "../../ui/Icon.js";
import { AppLink } from "../shell/AppLink.js";
import { Pending } from "../../ui/Parts.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { appsPath, centerPath, schedulePath, type CenterSection } from "../shell/route.js";
import { mcpReviewPath } from "../settings/McpServers.js";
import type { Outcome } from "../../lib/ipc.js";
import { WAITING_ANCHOR } from "./Inbox.js";
import { tasksInWindow, tasksToday } from "./model.js";
import { localDate, localTime, nearDay } from "../../lib/time.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";

/** One kind of thing waiting on the reader, and the section that holds it. */
const WAITING: readonly {
  readonly key: "approvals" | "reviews" | "questions" | "handoffs" | "connects" | "memoryProposals";
  readonly one: string;
  readonly many: string;
  readonly detail: string;
  readonly section: CenterSection;
  readonly icon: IconName;
}[] = [
  {
    key: "approvals",
    one: "approval",
    many: "approvals",
    detail: "Tool calls waiting for your decision",
    section: "approvals",
    icon: "center-approvals",
  },
  {
    key: "reviews",
    one: "review",
    many: "reviews",
    detail: "Results waiting for you to keep or reject",
    section: "approvals",
    icon: "check",
  },
  { key: "questions", one: "question", many: "questions", detail: "Tasks waiting for your answer", section: "approvals", icon: "info" },
  {
    key: "handoffs",
    one: "browser handoff",
    many: "browser handoffs",
    detail: "Tasks waiting for you to act in their browser",
    section: "browser",
    icon: "info",
  },
  {
    key: "connects",
    one: "app to connect",
    many: "apps to connect",
    detail: "Tasks waiting for you to sign an app in again",
    section: "approvals",
    icon: "plug",
  },
  {
    key: "memoryProposals",
    one: "memory proposal",
    many: "memory proposals",
    detail: "Things the agent would like to remember",
    section: "identity",
    icon: "sparkles",
  },
];

/** An OAuth connection whose sign-in lapsed: named by its channel, it opens Settings → Channels. */
function ReconnectLink({ item }: { readonly item: NonNullable<CenterSummaryAnswer["reconnect"]>[number] }) {
  const channels = useChannelNames();
  const name = item.label ?? channels.label(item.providerId) ?? item.providerId;
  return (
    <AppLink href="/settings/messaging" className="center-need" onFollow={undefined}>
      <span className="center-need-icon" aria-hidden="true">
        <Icon name="info" size="sm" />
      </span>
      <span className="center-need-text">
        <span className="center-need-title">Reconnect {name}</span>
        <span className="center-need-detail meta-sm">
          {item.authState === "needs-consent" ? "It asks for access it was not granted" : "Its sign-in expired or was revoked"}
        </span>
      </span>
    </AppLink>
  );
}

export type AppRepairItem = NonNullable<CenterSummaryAnswer["apps"]>[number];

/** An MCP server's *Try again* and *Turn on* need no page: the rail runs them in place. */
function repairsInPlace(item: AppRepairItem): boolean {
  return (
    item.accountId?.startsWith(MCP_PLUGIN_PREFIX) === true && (item.kind === "retry" || item.kind === "enable" || item.kind === "turn-on")
  );
}

/** A Connected app that needs the reader: its repair, run in place when `repairsInPlace`, else a link to the app's page. */
function AppRepairLink({
  item,
  onFix,
}: {
  readonly item: AppRepairItem;
  readonly onFix?: ((item: AppRepairItem) => Promise<Outcome<unknown>>) | undefined;
}) {
  const [state, setState] = useState<{ readonly busy: boolean; readonly said?: string }>({ busy: false });
  // An MCP server's review opens on arrival, as its notice's did.
  const review = item.kind === "review-tools" && item.accountId?.startsWith(MCP_PLUGIN_PREFIX) === true ? item.accountId : undefined;
  const body = (
    <>
      <span className="center-need-icon" aria-hidden="true">
        <Icon name="plug" size="sm" />
      </span>
      <span className="center-need-text">
        <span className="center-need-title">{item.title}</span>
        <span className="center-need-detail meta-sm">{state.said ?? item.detail}</span>
      </span>
    </>
  );
  if (onFix !== undefined && repairsInPlace(item)) {
    return (
      <Button
        className="center-need"
        disabled={state.busy}
        onClick={() => {
          setState({ busy: true });
          void onFix(item).then((outcome) => setState({ busy: false, said: outcome.ok ? "Done." : outcome.message }));
        }}
      >
        {body}
      </Button>
    );
  }
  return (
    <AppLink
      href={review === undefined ? appsPath({ appId: item.appId }) : mcpReviewPath(review)}
      className="center-need"
      onFollow={undefined}
    >
      {body}
    </AppLink>
  );
}

/** What an MCP server's notice asks, in Tavi's words, with the command that decides it. */
const SERVER_NOTICE_WORDS: Readonly<
  Record<NonNullable<CenterSummaryAnswer["servers"]>[number]["kind"], { readonly title: string; readonly command: string }>
> = {
  drift: { title: "its tools changed", command: "tavi mcp review" },
  failed: { title: "stopped after repeated failures", command: "tavi mcp logs" },
  budget: { title: "its tools do not fit", command: "tavi mcp review" },
  login: { title: "needs you to sign in again", command: "tavi mcp review" },
  scope: { title: "asks for more access", command: "tavi mcp review" },
};

function ServerNotice({ item }: { readonly item: NonNullable<CenterSummaryAnswer["servers"]>[number] }) {
  const words = SERVER_NOTICE_WORDS[item.kind];
  // Opens the server's review in Settings → Plugins, where a drift is read and decided.
  return (
    <AppLink href={mcpReviewPath(item.pluginId)} className="center-need" onFollow={undefined}>
      <span className="center-need-icon" aria-hidden="true">
        <Icon name="info" size="sm" />
      </span>
      <span className="center-need-text">
        <span className="center-need-title">
          {item.pluginId}: {words.title}
        </span>
        <span className="center-need-detail meta-sm">
          Review it, or{" "}
          <code>
            {words.command} {item.pluginId}
          </code>
        </span>
      </span>
    </AppLink>
  );
}

/** What needs the reader, what runs next, and a few figures: the rail beside every section. */
export function CenterRail({
  summary,
  sections,
  unseenReminders = 0,
  reminders,
  heartbeat,
  onSection,
  onOpenSchedule,
  onProposals,
  onFixApp,
  hideComingUp = false,
}: {
  readonly summary: CenterSummaryAnswer | undefined;
  /** The sections this owner offers; a count whose section is hidden is not offered as a link. Absent, every one. */
  readonly sections?: readonly CenterSection[] | undefined;
  /** How many reminder cards `reminders` shows: they wait on the reader too. */
  readonly unseenReminders?: number;
  /** Fired reminders not yet seen: cards at the top of the rail, with Done and Snooze. */
  readonly reminders?: ReactNode;
  /** The heartbeat's pill, when the owner offers it. */
  readonly heartbeat?: ReactNode;
  readonly onSection: (section: CenterSection) => void;
  /** A plain schedule's page: its entry opens there rather than at the section's lists. Absent, the section. */
  readonly onOpenSchedule?: ((scheduleId: string) => void) | undefined;
  /** The memory proposals were followed: Soul & memory, at its proposals. Absent, the section alone. */
  readonly onProposals?: (() => void) | undefined;
  /** Runs an app's repair that needs no page (`repairsInPlace`); absent, every repair is a link. */
  readonly onFixApp?: ((item: AppRepairItem) => Promise<Outcome<unknown>>) | undefined;
  /** Leave out Coming up: the Schedule section lists the same, in full. */
  readonly hideComingUp?: boolean;
}) {
  if (summary === undefined) {
    return (
      <aside className="center-rail" aria-label="Needs attention">
        <Pending className="notice" status />
      </aside>
    );
  }
  const offered = (section: CenterSection): boolean => sections === undefined || sections.includes(section);
  const waiting = WAITING.filter((item) => (summary.counts[item.key] ?? 0) > 0 && offered(item.section));
  // An owner that lists its apps' repairs says what `reconnect` and `servers` did, once; a tool budget is a server notice only.
  const apps = summary.apps ?? [];
  const reconnect = summary.apps === undefined ? (summary.reconnect ?? []) : [];
  const servers = (summary.servers ?? []).filter((item) => summary.apps === undefined || item.kind === "budget");
  const total = tasksInWindow(summary);
  const todays = tasksToday(summary);
  return (
    <aside className="center-rail" aria-label="Needs attention">
      {heartbeat}
      {reminders}
      <section>
        <h2 className="eyebrow">
          <Icon name="bell" size="sm" />
          Waiting on you
        </h2>
        {apps.length === 0 ? null : (
          <ul className="center-needs list-reset" aria-label="Connected apps">
            {apps.map((item) => (
              <li key={`${item.appId}:${item.kind}:${item.accountId ?? ""}`}>
                <AppRepairLink item={item} onFix={onFixApp} />
              </li>
            ))}
          </ul>
        )}
        {reconnect.length === 0 ? null : (
          <ul className="center-needs list-reset" aria-label="Channels to reconnect">
            {reconnect.map((item) => (
              <li key={item.connectionId}>
                <ReconnectLink item={item} />
              </li>
            ))}
          </ul>
        )}
        {servers.length === 0 ? null : (
          <ul className="center-needs list-reset" aria-label="Servers">
            {servers.map((item) => (
              <li key={`${item.pluginId}:${item.kind}`}>
                <ServerNotice item={item} />
              </li>
            ))}
          </ul>
        )}
        {waiting.length === 0 && apps.length === 0 && reconnect.length === 0 && servers.length === 0 ? (
          <Empty>{unseenReminders > 0 ? "Nothing else is waiting on you." : "Nothing is waiting on you."}</Empty>
        ) : null}
        {waiting.length === 0 ? null : (
          <ul className="center-needs list-reset">
            {waiting.map((item) => {
              const count = summary.counts[item.key];
              return (
                <li key={item.key}>
                  <AppLink
                    href={centerPath(item.section)}
                    className="center-need"
                    onFollow={() => {
                      if (item.key === "memoryProposals" && onProposals !== undefined) {
                        onProposals();
                        return;
                      }
                      onSection(item.section);
                      // Approvals lands on what waits, below the section's head.
                      if (item.section === "approvals")
                        requestAnimationFrame(() => {
                          const waiting = document.getElementById(WAITING_ANCHOR);
                          waiting?.scrollIntoView?.({ block: "start" });
                          waiting?.focus({ preventScroll: true });
                        });
                    }}
                  >
                    <span className="center-need-icon" aria-hidden="true">
                      <Icon name={item.icon} size="sm" />
                    </span>
                    <span className="center-need-text">
                      <span className="center-need-title">{plural(count ?? 0, item.one, item.many)}</span>
                      <span className="center-need-detail meta-sm">{item.detail}</span>
                    </span>
                  </AppLink>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {/* On Schedule the page beside it is the whole list: the rail does not say it twice. */}
      {hideComingUp ? null : (
        <section>
          <h2 className="eyebrow">
            <Icon name="calendar" size="sm" />
            Coming up
          </h2>
          {summary.next.length === 0 ? (
            <Empty>Nothing scheduled.</Empty>
          ) : (
            <ul className="center-next list-reset">
              {summary.next.map((item) => {
                const what = (
                  <>
                    <time dateTime={item.at}>{localTime(item.at, summary.timezone)}</time>
                    <span>
                      <span className="center-next-title">{item.title}</span>
                      <span className="center-next-detail meta-sm">
                        {item.kind === "routine" ? "Routine" : item.kind === "reminder" ? "Reminder" : "Schedule"} ·{" "}
                        {nearDay(localDate(item.at, summary.timezone), summary.today, "future")}
                      </span>
                    </span>
                  </>
                );
                const ownPage = item.kind === "schedule" && onOpenSchedule !== undefined;
                return (
                  <li key={`${item.kind}:${item.id}:${item.at}`}>
                    {offered("schedule") ? (
                      <AppLink
                        href={ownPage ? schedulePath(item.id) : centerPath("schedule")}
                        className="center-next-link"
                        onFollow={() => (ownPage ? onOpenSchedule(item.id) : onSection("schedule"))}
                      >
                        {what}
                      </AppLink>
                    ) : (
                      <span className="center-next-link">{what}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <dl className="center-stats card-flat">
        <div>
          <dt>turns today</dt>
          <dd>{todays}</dd>
        </div>
        <div>
          <dt>running now</dt>
          <dd>{summary.counts.runningTasks}</dd>
        </div>
        <div>
          <dt>turns in {summary.perDay.length} days</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>{summary.counts.reminders === undefined ? "routines and schedules" : "reminders, routines and schedules"}</dt>
          <dd>{summary.counts.activeRoutines + summary.counts.schedules + (summary.counts.reminders ?? 0)}</dd>
        </div>
      </dl>
    </aside>
  );
}
