import type { CenterSummaryAnswer } from "@tavi/contracts";

import { Icon, type IconName } from "../../ui/Icon.js";
import { CENTER_SECTIONS, type CenterSection } from "../shell/route.js";
import { SidebarFrame } from "../shell/SidebarFrame.js";
import { decisionCount, tasksToday } from "./model.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Button } from "../../ui/Button.js";
import { useCurrentNavInView } from "../../ui/useCurrentNavInView.js";

const SECTION_ICONS: Readonly<Record<CenterSection, IconName>> = {
  activity: "center-activity",
  approvals: "center-approvals",
  schedule: "center-schedule",
  heartbeat: "center-heartbeat",
  identity: "center-soul",
  browser: "center-browser",
};

/**
 * The sections an owner offers: each needs the
 * command its lists come from, since the canvas and the owner can be
 * different builds. Activity needs only `center` itself.
 */
export function offeredSections(features: readonly string[]): readonly CenterSection[] {
  const has = (feature: string): boolean => features.includes(feature);
  return CENTER_SECTIONS.map((item) => item.value).filter((section) => {
    switch (section) {
      case "activity":
        return true;
      case "approvals":
        return has("approvals");
      case "schedule":
        return has("routines") || has("schedules");
      case "heartbeat":
        return has("heartbeat");
      case "identity":
        return has("memory");
      case "browser":
        return has("browser");
    }
  });
}

/** A nav item's count: the figure shown, what it says out loud, and whether it waits on the reader. */
interface SectionCount {
  readonly value: number;
  readonly spoken: string;
  readonly waiting: boolean;
}

/** What each section's nav item counts; nothing for a section with nothing to count yet. */
export function sectionCount(section: CenterSection, summary: CenterSummaryAnswer | undefined): SectionCount | undefined {
  if (summary === undefined) return undefined;
  const count = (value: number, spoken: string, waiting: boolean): SectionCount | undefined =>
    value > 0 ? { value, spoken: `${value} ${spoken}`, waiting } : undefined;
  switch (section) {
    case "activity":
      return count(tasksToday(summary), "today", false);
    case "approvals":
      return count(decisionCount(summary), "waiting", true);
    case "schedule":
      return count(summary.counts.activeRoutines + summary.counts.schedules + (summary.counts.reminders ?? 0), "scheduled", false);
    case "heartbeat":
      return undefined;
    case "identity":
      return count(summary.counts.memoryProposals, "to review", true);
    case "browser":
      return count(summary.counts.liveBrowserSessions ?? 0, "open now", false);
  }
}

/** A count seen as a figure and heard as words ("2 waiting"). */
function Count({ count, className }: { readonly count: SectionCount; readonly className: string }) {
  return (
    <span className={count.waiting ? `${className} waiting` : className}>
      <span aria-hidden="true">{count.value}</span>
      <span className="visually-hidden">{count.spoken}</span>
    </span>
  );
}

/** The section nav, in the sessions column's frame (and its width key). */
export function CenterNav({
  section,
  summary,
  sections,
  onSection,
  onCollapse,
}: {
  readonly section: CenterSection;
  readonly summary: CenterSummaryAnswer | undefined;
  /** The sections this owner offers; absent, every one. */
  readonly sections?: readonly CenterSection[] | undefined;
  readonly onSection: (section: CenterSection) => void;
  readonly onCollapse?: (() => void) | undefined;
}) {
  const { workspaceId } = useWorkspace();
  useCurrentNavInView(section);
  return (
    <SidebarFrame title="Command Center" label="Command Center sections" className="center-nav" onCollapse={onCollapse}>
      <ul className="center-nav-list list-reset">
        {CENTER_SECTIONS.filter((item) => sections === undefined || sections.includes(item.value)).map((item) => {
          const count = sectionCount(item.value, summary);
          return (
            <li key={item.value}>
              <Button
                variant="bare"
                className="center-nav-item"
                aria-current={item.value === section ? "page" : undefined}
                onClick={() => onSection(item.value)}
              >
                <Icon name={SECTION_ICONS[item.value]} size="sm" />
                <span className="center-nav-label">{item.label}</span>
                {count === undefined ? null : <Count count={count} className="center-count meta-sm" />}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="scope meta-sm center-nav-foot">
        Workspace <code>{workspaceId}</code>
        {summary === undefined ? null : <> · {summary.timezone}</>}
      </p>
    </SidebarFrame>
  );
}
