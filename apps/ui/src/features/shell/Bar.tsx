import type { ClientState } from "@tavi/client/browser";

import { TaviMark, Wordmark } from "../../ui/TaviMark.js";
import { Tabs } from "../../ui/Tabs.js";
import type { CanvasState } from "../chat/store/types.js";
import { ROUTES, type Route } from "./route.js";
import { Failure } from "../../ui/Parts.js";
import { useWorkspace } from "./Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * The header: the routes, what needs the reader, and the connection — said
 * by Tavi's mark itself, in its colours when connected, grey when not, and
 * breathing while it connects.
 *
 * With the Command Center offered (`center`), what is waiting is its tab's
 * badge — approvals, reviews, questions and memory proposals across the
 * workspace — and the page's own needs pill is not shown beside it as a
 * second count. Without it, the Center tab is absent and the pill stays.
 */
export function Bar({
  state,
  route,
  onRoute,
  needs,
  center,
  scheduleOnly = false,
  ideas = false,
  focused = false,
}: {
  readonly state: CanvasState;
  readonly route: Route;
  readonly onRoute: (route: Route) => void;
  readonly needs: number;
  readonly center?: { readonly waiting: number } | undefined;
  /** The owner offers Schedule but not the Command Center: the Center tab holds Schedule alone, with no count. */
  readonly scheduleOnly?: boolean;
  /** The owner offers Ideas. */
  readonly ideas?: boolean;
  /** Setup is on screen: the routes step aside, and the header names where the reader is. */
  readonly focused?: boolean;
}) {
  const { workspaceId } = useWorkspace();
  const routes = ROUTES.filter(
    (item) => (item.value !== "center" || center !== undefined || scheduleOnly) && (item.value !== "ideas" || ideas),
  ).map((item) =>
    item.value === "center" && center !== undefined && center.waiting > 0
      ? {
          ...item,
          badge: (
            <span className="view-count">
              <span aria-hidden="true">{center.waiting}</span>
              <span className="visually-hidden">, {center.waiting} waiting</span>
            </span>
          ),
        }
      : item,
  );
  return (
    <>
      <header className="bar">
        <span className={`brand brand-${state.connection}`} title={`Tavi: ${CONNECTION_LABELS[state.connection]}`}>
          <TaviMark />
          <Wordmark />
          {/* Not a live region: the page has one, in `index.html`, and `announcementOf` puts the connection through it. */}
          <span className="visually-hidden">, {CONNECTION_LABELS[state.connection]}</span>
        </span>
        {focused ? (
          <span className="bar-context">Setup</span>
        ) : (
          <Tabs label="pages" className="views" items={routes} current={route} onPick={onRoute} />
        )}
        <span className="bar-spacer" />
        {/* Seen, not announced here: the page has one live region
            (`index.html`), and `announcementOf` carries this count through it. */}
        {center === undefined && needs > 0 ? (
          <span className="needs-count">
            {needs}
            {state.directory?.needsTruncated ? "+" : ""} {needs === 1 ? "chat needs" : "chats need"} you
            {workspaceId ? ` in workspace ${workspaceId}` : " on this page"}
          </span>
        ) : null}
      </header>
      {state.failure !== undefined ? (
        <Failure alert={false} className="bar-failure">
          {/* The owner's reason is a clause ("no tavi owner is serving: …"): a full stop ends it before the advice. */}
          {/[.!?]$/.test(state.failure) ? state.failure : `${state.failure}.`} Press Enter where <Command>tavi ui</Command> runs for a new
          link.
        </Failure>
      ) : null}
    </>
  );
}
const CONNECTION_LABELS: Readonly<Record<ClientState, string>> = {
  idle: "not connected",
  connecting: "connecting…",
  ready: "connected",
  reconnecting: "reconnecting…",
  closed: "disconnected",
};
