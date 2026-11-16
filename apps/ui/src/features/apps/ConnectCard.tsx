import { createContext, Suspense, useContext, useEffect, useState } from "react";
import { z } from "zod";

import { CatalogRefSchema, type ConnectRequest, type ConnectableApp } from "@tavi/contracts";

import { localTime } from "../../lib/time.js";
import { Icon } from "../../ui/Icon.js";
import { Failure } from "../../ui/Parts.js";
import { appActions } from "./apps-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useTimeZone } from "../shell/Workspace.js";
import { loadFlow, loadStatus, ONBOARDING_CHANGED_EVENT } from "../welcome/onboarding-api.js";
import { Button } from "../../ui/Button.js";
import { lazyModule } from "../../ui/lazy-module.js";
import { ViewBoundary } from "../../ui/ViewBoundary.js";

/** The connect sheet (sign-in and its steps) is its own chunk, fetched the first time a card opens it. */
const connectSheet = lazyModule(() => import("./ConnectSheet.js").then((module) => module.ConnectSheet));
const ConnectSheet = connectSheet.Route;

/** Settles once the connect sheet is fetched, so a test that opens it reads it synchronously. */
export function connectSheetReady(): Promise<void> {
  return connectSheet.ready().then(() => undefined);
}

/**
 * The connect card: drawn in the chat
 * from a tool call that met an app needing its sign-in (`SIGN_IN_REQUIRED`),
 * or from the agent's own `apps.request_connect`. Connect opens the connect
 * sheet over the chat; once connected, *Continue* posts a fixed message as
 * the person, an ordinary turn.
 */

/** What a card needs from the page: the owner, and a way to send the person's message and to open Discover. */
export interface ConnectCardPage {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  /** Sends `text` as the person's next message in this chat. */
  readonly onContinue: (text: string) => void;
  /** Opens Connected apps' Discover at the app named, to add it. */
  readonly onDiscover: (name: string) => void;
  /** Setup's Welcome at a step, where the owner offers setup. */
  readonly onSetup?: ((stepId: string) => void) | undefined;
}

/**
 * Setup's apps step, while it is open: connecting an app finishes it,
 * since setup reads it from what is connected. Read again once connected, and
 * whenever an app is connected elsewhere on the page, so the card says the step
 * is done. A channel's account is not offered: the channels step is done only
 * once a person is paired, which signing in does not do. A card with nothing
 * left to ask (`active` false) reads nothing; the flow is read only when the
 * step is open.
 */
function useSetupStep(
  page: ConnectCardPage,
  active: boolean,
  connected: boolean,
): { readonly id: string; readonly title: string; readonly done: boolean } | undefined {
  const [step, setStep] = useState<{ readonly id: string; readonly title: string; readonly done: boolean }>();
  const [changes, setChanges] = useState(0);
  const offered = page.onSetup !== undefined;
  useEffect(() => {
    if (!offered || !active) return undefined;
    const changed = () => setChanges((count) => count + 1);
    window.addEventListener(ONBOARDING_CHANGED_EVENT, changed);
    return () => window.removeEventListener(ONBOARDING_CHANGED_EVENT, changed);
  }, [offered, active]);
  useEffect(() => {
    if (!offered || !active) return undefined;
    let live = true;
    void (async () => {
      const status = await loadStatus(page.client, page.workspaceId);
      if (!live || !status.ok) return;
      const state = status.value.steps.find((candidate) => candidate.kind === "apps")?.state;
      // Done before this card: nothing to say. Done by it (or since): said.
      if (state === undefined || state === "unavailable" || state === "done")
        return setStep((before) => (before === undefined || state !== "done" ? undefined : { ...before, done: true }));
      const flow = await loadFlow(page.client, page.workspaceId);
      if (!live || !flow.ok) return;
      const flowStep = flow.value.flow.steps.find((candidate) => candidate.kind === "apps");
      setStep(flowStep === undefined ? undefined : { id: flowStep.id, title: flowStep.title, done: false });
    })();
    return () => {
      live = false;
    };
  }, [offered, active, connected, changes, page.client, page.workspaceId]);
  return step;
}

export const ConnectCardContext = createContext<ConnectCardPage | undefined>(undefined);

/** By the MCP server that failed, or by a channel account's app (a Gmail mailbox tool's). */
const SignInOutputSchema = z.union([
  z.object({ error: z.literal("SIGN_IN_REQUIRED"), pluginId: z.string().min(1).max(128) }),
  z.object({ error: z.literal("SIGN_IN_REQUIRED"), appId: z.string().min(1).max(128), accountId: z.string().min(1).max(256) }),
]);
const RequestOutputSchema = z.object({
  connect: z.object({
    appId: z.string().max(128).optional(),
    name: z.string().min(1).max(80),
    installed: z.boolean(),
    accountId: z.string().max(256).optional(),
    access: z.array(z.string().max(300)).max(16),
    why: z.string().max(300),
    entry: CatalogRefSchema.optional(),
  }),
});

/** What a tool card asks to connect, if anything: the app by its plugin, or the agent's request. */
export type ConnectAsk =
  | { readonly kind: "sign-in"; readonly pluginId: string }
  | { readonly kind: "account"; readonly appId: string; readonly accountId: string }
  /** A task waiting for the account: connecting resumes it, and *Not now* settles only its wait. */
  | {
      readonly kind: "wait";
      readonly waitId: string;
      readonly request: ConnectRequest /** When the wait ends without a sign-in. */;
      readonly deadlineAt?: string | undefined;
    }
  | { readonly kind: "request"; readonly request: z.infer<typeof RequestOutputSchema>["connect"] };

/** A failed call's result, which its event carries as JSON text. */
function failedOutput(message: string | undefined): unknown {
  if (message === undefined) return undefined;
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}

export function connectAskOf(card: {
  readonly toolName: string;
  readonly status: string;
  readonly output?: unknown;
  readonly message?: string | undefined;
}): ConnectAsk | undefined {
  if (card.toolName === "apps.request_connect") {
    const parsed = card.status === "completed" ? RequestOutputSchema.safeParse(card.output) : undefined;
    return parsed?.success === true ? { kind: "request", request: parsed.data.connect } : undefined;
  }
  if (card.status !== "failed") return undefined;
  const signIn = SignInOutputSchema.safeParse(failedOutput(card.message));
  if (!signIn.success) return undefined;
  return "pluginId" in signIn.data
    ? { kind: "sign-in", pluginId: signIn.data.pluginId }
    : { kind: "account", appId: signIn.data.appId, accountId: signIn.data.accountId };
}

/** The fixed message *Continue* sends: the person says the app is connected. */
export const continueMessage = (appName: string): string => `${appName} is connected, please continue.`;

export function ConnectCard({ ask }: { readonly ask: ConnectAsk }) {
  const page = useContext(ConnectCardContext);
  return page === undefined ? null : <ConnectCardFor page={page} ask={ask} />;
}

function ConnectCardFor({ page, ask }: { readonly page: ConnectCardPage; readonly ask: ConnectAsk }) {
  const timeZone = useTimeZone();
  const request = ask.kind === "request" ? ask.request : undefined;
  // The app as the owner holds it now, found by the plugin that failed or the app the agent named.
  const { data, error } = useLoaded(() => appActions.list(page.client, page.workspaceId));
  const app = data?.apps.find((candidate) => {
    if (ask.kind === "sign-in") return candidate.source.pluginIds.includes(ask.pluginId);
    if (ask.kind === "wait") return candidate.accounts.some((account) => account.accountId === ask.request.accountId);
    return candidate.appId === (ask.kind === "account" ? ask.appId : request?.appId);
  });
  const [declined, setDeclined] = useState(false);
  const [declineFailure, setDeclineFailure] = useState<string>();
  const [sheet, setSheet] = useState<ConnectableApp>();
  const [connected, setConnected] = useState<{ readonly identity?: string | undefined }>();
  const [sent, setSent] = useState(false);
  const name = app?.name ?? request?.name ?? (ask.kind === "wait" ? ask.request.appName : "This app");
  const accountId =
    ask.kind === "sign-in"
      ? ask.pluginId
      : ask.kind === "account"
        ? ask.accountId
        : ask.kind === "wait"
          ? ask.request.accountId
          : request?.accountId;
  // Only a card still asking, for an app (not a channel's account), reads setup.
  const asking =
    app !== undefined &&
    app.source.kind !== "channel" &&
    (connected !== undefined ||
      ask.kind === "wait" ||
      (accountId === undefined
        ? app.health !== "ready"
        : app.accounts.find((candidate) => candidate.accountId === accountId)?.health !== "ready"));
  const setup = useSetupStep(page, asking, connected !== undefined);
  const setupLine =
    setup === undefined || page.onSetup === undefined ? null : setup.done ? (
      <p className="meta-sm" role="status">
        <Icon name="check" size="sm" /> Setup's “{setup.title}” step is done.
      </p>
    ) : (
      <p className="meta-sm">
        Connecting it also finishes setup's “{setup.title}” step.{" "}
        <Button variant="link" onClick={() => page.onSetup?.(setup.id)}>
          Open setup
        </Button>
      </p>
    );
  const failure =
    error ??
    (data !== undefined && app === undefined && request?.installed !== false
      ? `${name} is not added on this computer any more.`
      : undefined);
  // An older card, read again once the app is working: it asks nothing more.
  const account = accountId === undefined ? undefined : app?.accounts.find((candidate) => candidate.accountId === accountId);
  // A task's wait is settled by the owner, not read from the account's health: its card keeps Connect and *Not now*.
  const settled =
    ask.kind !== "wait" &&
    connected === undefined &&
    app !== undefined &&
    (account === undefined ? app.health === "ready" : account.health === "ready");
  if (settled) {
    return (
      <section className="card-flat apps-connect-card" aria-label={`Connect ${name}`}>
        <p className="apps-connect-card-title">
          <Icon name="plug" size="sm" /> {name} is connected
        </p>
      </section>
    );
  }

  return (
    <section className="card-flat apps-connect-card" aria-label={`Connect ${name}`}>
      <p className="apps-connect-card-title">
        <Icon name="plug" size="sm" />{" "}
        {connected === undefined
          ? request?.installed === false
            ? `Add ${name}`
            : `Connect ${name}`
          : `Connected${connected.identity === undefined ? "" : ` as ${connected.identity}`}`}
      </p>
      {connected === undefined ? (
        <>
          {/* The agent's reason is its words, quoted as such; the rest is Tavi's. */}
          {request?.why !== undefined ? (
            <p className="muted">
              <span className="apps-connect-card-says">Tavi says:</span> “{request.why}”
            </p>
          ) : (
            <p className="muted">
              {ask.kind === "wait" && ask.request.health === "not-set-up"
                ? `${name} isn't signed in yet: sign in before Tavi can go on.`
                : ask.kind === "wait" && ask.request.reason !== ""
                  ? `${name} needs you to sign in again before Tavi can go on: ${ask.request.reason}.`
                  : `${name} needs you to sign in again before Tavi can go on.`}
            </p>
          )}
          {ask.kind === "wait" && ask.deadlineAt !== undefined ? (
            <p className="meta-sm">Waits until {localTime(ask.deadlineAt, timeZone)}, then goes on without it.</p>
          ) : null}
          {request === undefined || request.access.length === 0 ? null : (
            <ul className="meta-sm">
              {request.access.map((says) => (
                <li key={says}>{says}</li>
              ))}
            </ul>
          )}
          {setupLine}
          <Failure message={failure ?? declineFailure} />
          {declined ? (
            <p className="meta-sm" role="status">
              Tavi goes on without {name}.
            </p>
          ) : null}
          <div className="actions">
            {request?.installed === false ? (
              <Button variant="primary" size="sm" onClick={() => page.onDiscover(name)}>
                Add and connect
              </Button>
            ) : (
              <Button variant="primary" size="sm" disabled={app === undefined || declined} onClick={() => setSheet(app)}>
                Connect
              </Button>
            )}
            {ask.kind === "wait" ? (
              <Button
                size="sm"
                disabled={declined}
                onClick={() => {
                  setDeclined(true);
                  setDeclineFailure(undefined);
                  void appActions.declineConnect(page.client, page.workspaceId, ask.waitId).then((done) => {
                    if (!done.ok) {
                      setDeclined(false);
                      setDeclineFailure(done.message);
                    }
                  });
                }}
              >
                Not now
              </Button>
            ) : null}
          </div>
        </>
      ) : ask.kind === "wait" ? (
        <>
          <p className="meta-sm" role="status">
            Tavi goes on with {name} now.
          </p>
          {setupLine}
        </>
      ) : (
        <>
          {setupLine}
          <div className="actions">
            <Button
              variant="primary"
              size="sm"
              disabled={sent}
              onClick={() => {
                setSent(true);
                page.onContinue(continueMessage(name));
              }}
            >
              Continue
            </Button>
          </div>
        </>
      )}
      {sheet === undefined || connected !== undefined ? null : (
        <ViewBoundary resetKey={sheet.appId} what="panel" onRetry={connectSheet.retry}>
          <Suspense fallback={null}>
            <ConnectSheet
              client={page.client}
              workspaceId={page.workspaceId}
              app={sheet}
              accountId={accountId}
              onClose={() => setSheet(undefined)}
              onConnected={(signedIn) => {
                void appActions.show(page.client, sheet.appId, page.workspaceId).then((shown) => {
                  const account = shown.ok ? shown.value.app.accounts.find((candidate) => candidate.accountId === signedIn) : undefined;
                  setConnected({ identity: account?.identity });
                  setSheet(undefined);
                });
              }}
            />
          </Suspense>
        </ViewBoundary>
      )}
    </section>
  );
}
