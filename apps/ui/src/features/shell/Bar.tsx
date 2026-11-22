import type { ClientState } from "@tavi/client/browser";

import { TaviMark, Wordmark } from "../../ui/TaviMark.js";
import { Tabs } from "../../ui/Tabs.js";
import type { CanvasState } from "../chat/store/types.js";
import { ROUTES, type Route } from "./route.js";
import { Failure } from "../../ui/Parts.js";
import { useWorkspace } from "./Workspace.js";
import { Command } from "../../ui/Command.js";
import { Button } from "../../ui/Button.js";
import { Icon } from "../../ui/Icon.js";
import { useT } from "../../lib/i18n.js";
import { withParts } from "../../ui/with-parts.js";
import type { UiKey } from "../../locales/en.js";

/**
 * The header: the routes, what needs the reader, the way to the keyboard
 * sheet, and the connection — said
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
  onKeys,
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
  /** Opens the `Cmd+/` sheet: its chord is the browser's to overrule, so it is reachable without it. */
  readonly onKeys?: () => void;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const connection = t(CONNECTION_KEYS[state.connection]);
  const routes = ROUTES.filter(
    (item) => (item.value !== "center" || center !== undefined || scheduleOnly) && (item.value !== "ideas" || ideas),
  ).map((item) =>
    item.value === "center" && center !== undefined && center.waiting > 0
      ? {
          ...item,
          badge: (
            <span className="view-count">
              <span aria-hidden="true">{center.waiting}</span>
              <span className="visually-hidden">, {t("shell.bar.centerWaiting", { count: center.waiting })}</span>
            </span>
          ),
        }
      : item,
  );
  return (
    <>
      <header className="bar">
        <span className={`brand brand-${state.connection}`} title={t("shell.bar.brandTitle", { connection })}>
          <TaviMark />
          <Wordmark />
          {/* Not a live region: the page has one, in `index.html`, and `announcementOf` puts the connection through it. */}
          <span className="visually-hidden">, {connection}</span>
        </span>
        {focused ? (
          <span className="bar-context">{t("shell.bar.setup")}</span>
        ) : (
          <Tabs label={t("shell.bar.pages")} className="views" items={routes} current={route} onPick={onRoute} />
        )}
        <span className="bar-spacer" />
        {/* Seen, not announced here: the page has one live region
            (`index.html`), and `announcementOf` carries this count through it. */}
        {center === undefined && needs > 0 ? (
          <span className="needs-count">
            {t(workspaceId ? "shell.bar.needsInWorkspace" : "shell.bar.needsOnPage", {
              count: needs,
              more: state.directory?.needsTruncated ? "+" : "",
              workspace: workspaceId,
            })}
          </span>
        ) : null}
        {onKeys === undefined ? null : (
          <Button
            variant="ghost"
            size={["icon", "sm"]}
            className="bar-keys"
            aria-label={t("shell.bar.keys")}
            aria-keyshortcuts="Meta+/"
            title={t("shell.bar.keysTitle")}
            onClick={onKeys}
          >
            <Icon name="keyboard" size="sm" />
          </Button>
        )}
      </header>
      {state.failure !== undefined ? (
        <Failure alert={false} className="bar-failure">
          {/* The owner's reason is a clause ("no tavi owner is serving: …"): a full stop ends it before the advice. */}
          {/[.!?]$/.test(state.failure) ? state.failure : `${state.failure}.`}{" "}
          {withParts(t("shell.bar.newLink"), { command: <Command>tavi ui</Command> })}
        </Failure>
      ) : null}
    </>
  );
}
const CONNECTION_KEYS: Readonly<Record<ClientState, UiKey>> = {
  idle: "shell.bar.connection.idle",
  connecting: "shell.bar.connection.connecting",
  ready: "shell.bar.connection.ready",
  reconnecting: "shell.bar.connection.reconnecting",
  closed: "shell.bar.connection.closed",
};
