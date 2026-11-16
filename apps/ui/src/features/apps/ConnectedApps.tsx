import { useEffect, useRef, useState } from "react";

import type { AppCategory, AppHealth, ConnectableApp } from "@tavi/contracts";

import { ANNOUNCER_ID } from "../shell/a11y.js";
import { FilterChip, LoadState, PageHead, SearchField, StatusNote } from "../../ui/Parts.js";
import { mcpActions } from "../settings/plugins-api.js";
import { appActions } from "./apps-api.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { AppDetail } from "./AppDetail.js";
import { Discover } from "./Discover.js";
import { AppIcon } from "./AppIcon.js";
import {
  GROUP_TITLES,
  HEALTH_BADGE,
  accountsLine,
  appMatches,
  groupApps,
  CATEGORY_WORDS,
  healthChanges,
  nextSignInLine,
  pageFix,
  primaryRepair,
} from "./model.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";

/**
 * Settings → Connected apps: the
 * apps the owner holds, the catalog to add more, and each app's page. The
 * view is drawn from the owner's read model only, so an app a plugin adds
 * appears here with no change to the page.
 */

export interface AppsWhere {
  readonly tab: "connected" | "discover";
  readonly appId?: string | undefined;
  readonly connect?: boolean | undefined;
  /** Discover's search, filled in when it opens at an entry (a chat's *Add and connect*). */
  readonly query?: string | undefined;
}

/** The plugin an old link names: `?review=<pluginId>` (Center notices, `mcpReviewPath`). */
function reviewQuery(): string | undefined {
  try {
    return new URLSearchParams(window.location.search).get("review") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The link is used once: its query leaves the address, so going back reaches the list. */
function dropReviewQuery(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("review");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // An address that cannot be rewritten keeps its query; the review is still used once.
  }
}

export function ConnectedApps({
  where,
  onWhere,
  onOpenTask,
  revision = 0,
}: {
  readonly where: AppsWhere;
  readonly onWhere: (where: AppsWhere) => void;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
  /** The Center feed's `plugin` revision: an install or removal elsewhere re-reads the list. */
  readonly revision?: number;
}) {
  const [review, setReview] = useState(reviewQuery);
  // The app an old link's review opens on, and only that app.
  const [reviewFor, setReviewFor] = useState<{ readonly appId: string; readonly pluginId: string }>();
  const [connectFor, setConnectFor] = useState<{ readonly accountId?: string; readonly addAccount?: boolean }>({});
  if (where.appId !== undefined) {
    return (
      <AppDetail
        key={where.appId}
        appId={where.appId}
        connecting={where.connect === true ? connectFor : undefined}
        review={reviewFor?.appId === where.appId ? reviewFor.pluginId : undefined}
        onConnect={(connect) => {
          setConnectFor(connect ?? {});
          onWhere({ tab: "connected", appId: where.appId, connect: connect !== undefined });
        }}
        onOpenTask={onOpenTask}
        onBack={() => {
          setReviewFor(undefined);
          onWhere({ tab: "connected" });
        }}
      />
    );
  }
  return (
    <section className="settings">
      <PageHead
        className="settings-head"
        title="Connected apps"
        description="The accounts and apps Tavi works with. Nothing is read until you connect, and you choose what each may change."
      >
        <nav className="segmented" aria-label="Connected apps">
          <Button
            className="segment"
            aria-current={where.tab === "connected" ? "page" : undefined}
            onClick={() => onWhere({ tab: "connected" })}
          >
            Connected
          </Button>
          <Button
            className="segment"
            aria-current={where.tab === "discover" ? "page" : undefined}
            onClick={() => onWhere({ tab: "discover" })}
          >
            Discover
          </Button>
        </nav>
      </PageHead>
      {where.tab === "discover" ? (
        <Discover
          initialQuery={where.query}
          onOpen={(appId, connect) => {
            setConnectFor({});
            onWhere({ tab: "connected", appId, connect });
          }}
        />
      ) : (
        <ConnectedList
          revision={revision}
          review={review}
          onReview={(appId, pluginId) => {
            setReview(undefined);
            dropReviewQuery();
            setReviewFor({ appId, pluginId });
            onWhere({ tab: "connected", appId });
          }}
          onOpen={(appId, connect) => {
            setConnectFor(connect ?? {});
            onWhere({ tab: "connected", appId, connect: connect !== undefined });
          }}
          onDiscover={(query) => onWhere({ tab: "discover", ...(query === undefined ? {} : { query }) })}
        />
      )}
    </section>
  );
}

function ConnectedList({
  revision,
  review,
  onReview,
  onOpen,
  onDiscover,
}: {
  readonly revision: number;
  readonly review: string | undefined;
  readonly onReview: (appId: string, pluginId: string) => void;
  readonly onOpen: (appId: string, connect?: { readonly accountId?: string }) => void;
  readonly onDiscover: (query?: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  // A plugin installed or removed elsewhere shows here without a reload.
  const { data, error, loading, reload } = useLoaded(() => appActions.list(client, workspaceId), [revision]);
  const [category, setCategory] = useState<AppCategory | undefined>();
  const { busy, note, run } = useAction(reload);
  const [query, setQuery] = useState("");
  const [needsYou, setNeedsYou] = useState(false);
  const apps = data?.apps ?? [];
  // A health change is said once, through the page's one live region; the first read says nothing.
  const healths = useRef<ReadonlyMap<string, AppHealth> | undefined>(undefined);
  useEffect(() => {
    if (data === undefined) return;
    const said = healthChanges(healths.current, data.apps);
    healths.current = new Map(data.apps.map((app) => [app.appId, app.health]));
    const region = said.length === 0 ? null : document.getElementById(ANNOUNCER_ID);
    if (region !== null) region.textContent = `${said.join(". ")}.`;
  }, [data]);
  // An old link names a plugin: its app's page opens, with that review.
  useEffect(() => {
    if (review === undefined) return;
    const app = apps.find((candidate) => candidate.source.pluginIds.includes(review));
    if (app !== undefined) onReview(app.appId, review);
  }, [review, apps, onReview]);
  const shown = apps.filter(
    (app) => appMatches(app, query) && (!needsYou || app.health !== "ready") && (category === undefined || app.category === category),
  );
  const categories = [...new Set(apps.map((app) => app.category))];
  return (
    <>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      {data !== undefined && apps.length === 0 ? <EmptyApps onDiscover={onDiscover} /> : null}
      {apps.length === 0 ? null : (
        <div className="apps-filters">
          <SearchField value={query} placeholder="Search your apps" label="Search your apps" onChange={setQuery} />
          <FilterChip pressed={needsYou} onPick={() => setNeedsYou((current) => !current)}>
            Needs you only
          </FilterChip>
          {categories.length < 2
            ? null
            : categories.map((each) => (
                <FilterChip
                  key={each}
                  pressed={category === each}
                  onPick={() => setCategory((current) => (current === each ? undefined : each))}
                >
                  {CATEGORY_WORDS[each]}
                </FilterChip>
              ))}
        </div>
      )}
      {groupApps(shown).map(({ group, apps: members }) => (
        <section key={group} aria-labelledby={`apps-group-${group}`}>
          <h2 id={`apps-group-${group}`} className="settings-section-title">
            {GROUP_TITLES[group]}
          </h2>
          <ul className="rows">
            {members.map((app) => (
              <AppRow key={app.appId} app={app} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
      {apps.some((app) => app.source.kind === "mcp" && app.health !== "off") ? (
        <p className="muted">
          The kill switch:{" "}
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => void run("mcp:off", () => mcpActions.off(client))}
          >
            Turn every MCP app off
          </Button>{" "}
          (turning it on again is <Command>tavi mcp on</Command>).
        </p>
      ) : null}
    </>
  );
}

/** Nothing connected yet: Tavi's presets, read from the owner's catalog (which sends nothing out), each opening Discover on it. */
function EmptyApps({ onDiscover }: { readonly onDiscover: (query?: string) => void }) {
  const { client, workspaceId } = useWorkspace();
  const featured = useLoaded(() => appActions.catalog(client, workspaceId, ""));
  const presets = (featured.data?.catalog.sections ?? []).find((section) => section.section === "presets")?.entries ?? [];
  return (
    <div className="empty apps-empty">
      <p>No apps yet. Connect your calendar, to-dos and home so Tavi can plan around your day.</p>
      {presets.length === 0 ? null : (
        <ul className="actions list-reset" aria-label="Featured apps">
          {presets.map((entry) => (
            <li key={entry.name}>
              <Button size="sm" onClick={() => onDiscover(entry.name)}>
                Add {entry.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="primary" onClick={() => onDiscover()}>
        Discover apps
      </Button>
    </div>
  );
}

function AppRow({
  app,
  onOpen,
}: {
  readonly app: ConnectableApp;
  readonly onOpen: (appId: string, connect?: { readonly accountId?: string }) => void;
}) {
  const timeZone = useTimeZone();
  const badge = HEALTH_BADGE[app.health];
  const repair = primaryRepair(app);
  const next = nextSignInLine(app, timeZone);
  const accounts = accountsLine(app);
  return (
    <li className="row apps-row">
      <AppIcon name={app.name} icon={app.icon} />
      <span className="apps-row-info">
        <span className="apps-title-line cluster">
          <Button variant="link" className="item-title" onClick={() => onOpen(app.appId)}>
            {app.name}
          </Button>
          <span className={`badge badge-${badge.tone}`}>{badge.text}</span>
        </span>
        {/* An account named like its app (a channel's) says nothing the title does not. */}
        {accounts === app.name ? null : <span className="meta-sm">{accounts}</span>}
        {next === undefined ? null : <span className="meta-sm">{next}</span>}
        {repair === undefined ? null : <span className="meta-sm">{repair.detail}</span>}
      </span>
      {repair === undefined || repair.kind === "cli-only" ? null : (
        <span className="actions">
          <Button
            size="sm"
            onClick={() =>
              onOpen(
                app.appId,
                pageFix(app, repair) === "connect" ? (repair.accountId === undefined ? {} : { accountId: repair.accountId }) : undefined,
              )
            }
          >
            {repair.title}
          </Button>
        </span>
      )}
    </li>
  );
}
