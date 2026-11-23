import { useEffect, useRef, useState } from "react";

import type { AppCategory, AppHealth, ConnectableApp } from "@tavi/contracts";

import { ANNOUNCER_ID } from "../shell/a11y.js";
import { useT } from "../../lib/i18n.js";
import { FilterChip, LoadState, PageHead, PageNote, SearchField } from "../../ui/Parts.js";
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
  groupOf,
  HEALTH_BADGE,
  accountsLine,
  appMatches,
  groupApps,
  CATEGORY_WORDS,
  healthChanges,
  nextSignInLine,
  pageFix,
  primaryRepair,
  repairDetail,
  repairTitle,
} from "./model.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../../ui/with-parts.js";

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
  const t = useT();
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
      <PageHead className="settings-head" title={t("apps.page.title")} description={t("apps.page.description")}>
        <nav className="segmented" aria-label={t("apps.page.title")}>
          <Button
            className="segment"
            aria-current={where.tab === "connected" ? "page" : undefined}
            onClick={() => onWhere({ tab: "connected" })}
          >
            {t("apps.page.connected")}
          </Button>
          <Button
            className="segment"
            aria-current={where.tab === "discover" ? "page" : undefined}
            onClick={() => onWhere({ tab: "discover" })}
          >
            {t("apps.page.discover")}
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

/** How many apps make the Connected list worth searching and filtering when every one works. */
const APPS_FILTER_FROM = 6;

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
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  // A plugin installed or removed elsewhere shows here without a reload.
  const { data, error, loading, reload } = useLoaded(() => appActions.list(client, workspaceId), [revision]);
  const [category, setCategory] = useState<AppCategory | undefined>();
  const { busy, note, tone, run } = useAction(reload);
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
  // A few apps that all work need no search or filters: they show once the list is long or something needs you.
  const filtered = apps.length >= APPS_FILTER_FROM || apps.some((app) => groupOf(app.health) !== "connected");
  return (
    <>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
      </LoadState>
      {data !== undefined && apps.length === 0 ? <EmptyApps onDiscover={onDiscover} /> : null}
      {!filtered ? null : (
        <div className="apps-filters">
          <SearchField value={query} placeholder={t("apps.list.search")} label={t("apps.list.search")} onChange={setQuery} />
          <FilterChip pressed={needsYou} onPick={() => setNeedsYou((current) => !current)}>
            {t("apps.list.needsYouOnly")}
          </FilterChip>
          {categories.length < 2
            ? null
            : categories.map((each) => (
                <FilterChip
                  key={each}
                  pressed={category === each}
                  onPick={() => setCategory((current) => (current === each ? undefined : each))}
                >
                  {t(CATEGORY_WORDS[each])}
                </FilterChip>
              ))}
        </div>
      )}
      {groupApps(shown).map(({ group, apps: members }) => (
        <section key={group} aria-labelledby={`apps-group-${group}`}>
          <h2 id={`apps-group-${group}`} className="settings-section-title">
            {t(GROUP_TITLES[group])}
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
          {withParts(t("apps.list.killSwitch"), {
            button: (
              <Button
                variant="danger"
                size="sm"
                disabled={busy !== undefined}
                onClick={() => void run("mcp:off", () => mcpActions.off(client))}
              >
                {t("apps.list.allOff")}
              </Button>
            ),
            command: <Command>tavi mcp on</Command>,
          })}
        </p>
      ) : null}
    </>
  );
}

/** Nothing connected yet: Tavi's presets, read from the owner's catalog (which sends nothing out), each opening Discover on it. */
function EmptyApps({ onDiscover }: { readonly onDiscover: (query?: string) => void }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const featured = useLoaded(() => appActions.catalog(client, workspaceId, ""));
  const presets = (featured.data?.catalog.sections ?? []).find((section) => section.section === "presets")?.entries ?? [];
  return (
    <div className="empty apps-empty">
      <p>{t("apps.list.empty")}</p>
      {presets.length === 0 ? null : (
        <ul className="actions list-reset" aria-label={t("apps.list.featured")}>
          {presets.map((entry) => (
            <li key={entry.name}>
              <Button size="sm" onClick={() => onDiscover(entry.name)}>
                {t("apps.list.add", { app: entry.name })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="primary" onClick={() => onDiscover()}>
        {t("apps.list.discover")}
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
  const t = useT();
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
          {/* A working app sits under Connected: its badge would say the heading again. */}
          {app.health === "ready" ? null : <span className={`badge badge-${badge.tone}`}>{t(badge.textKey)}</span>}
        </span>
        {/* An account named like its app (a channel's) says nothing the title does not. */}
        {accounts === app.name ? null : <span className="meta-sm">{accounts}</span>}
        {next === undefined ? null : <span className="meta-sm">{next}</span>}
        {repair === undefined ? null : <span className="meta-sm">{repairDetail(repair)}</span>}
      </span>
      {repair === undefined || repair.kind === "cli-only" ? null : (
        <span className="actions">
          <RowAction
            onClick={() =>
              onOpen(
                app.appId,
                pageFix(app, repair) === "connect" ? (repair.accountId === undefined ? {} : { accountId: repair.accountId }) : undefined,
              )
            }
          >
            {repairTitle(repair)}
          </RowAction>
        </span>
      )}
    </li>
  );
}
