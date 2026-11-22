import { useId, useRef, useState } from "react";

import { signsIn, type AppDeviceCode, type ConnectableApp } from "@tavi/contracts";

import { translateNow, useT } from "../../lib/i18n.js";
import { localTime } from "../../lib/time.js";
import { useCopied, usePhone } from "../../hooks/page.js";
import { usePoll } from "../../hooks/use-poll.js";
import { Notice } from "../../ui/Parts.js";
import { appActions } from "./apps-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { useTimeZone } from "../shell/Workspace.js";
import { tunnelCommand } from "./model.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/** How often a waiting sign-in is asked after; the owner's flow lives 10 minutes. */
const SIGN_IN_POLL_MS = 2_000;

/** Where this page's sign-in comes back to: the bridge's own address. */
function pageOrigin(): { readonly origin: string; readonly port: string } {
  if (typeof window === "undefined") return { origin: "http://127.0.0.1", port: "" };
  return { origin: window.location.origin, port: window.location.port };
}

/** What a paste-back hands the owner: the address as pasted, or one made from the code and state typed separately; absent, nothing yet. */
function pastedAddress(redirectUri: string, address: string, typed: { readonly code: string; readonly state: string }): string | undefined {
  if (address.trim() !== "") return address.trim();
  if (typed.code.trim() === "" || typed.state.trim() === "") return undefined;
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("code", typed.code.trim());
    url.searchParams.set("state", typed.state.trim());
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Said before *Finish*: which account signs in, and the access it grants. */
function grantWords(app: ConnectableApp, accountId: string): string {
  const account = app.accounts.find((candidate) => candidate.accountId === accountId);
  const scopes = signsIn(app.auth) ? app.auth.scopes.map((scope) => scope.says) : [];
  if (account === undefined)
    return scopes.length === 0
      ? translateNow("apps.signIn.grantNew", { app: app.name })
      : translateNow("apps.signIn.grantNewAllowing", { app: app.name, access: scopes.join("; ") });
  const who = account.identity ?? account.label;
  return scopes.length === 0
    ? translateNow("apps.signIn.grant", { account: who })
    : translateNow("apps.signIn.grantAllowing", { account: who, access: scopes.join("; ") });
}

export function SignInStep({
  client,
  workspaceId,
  app,
  accountId,
  addAccount,
  onFailure,
  onNeedsClient,
  onBusy,
  onDone,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly app: ConnectableApp;
  readonly accountId: string | undefined;
  readonly addAccount: boolean;
  readonly onFailure: (message: string | undefined) => void;
  /** The server registers no clients itself: one of the person's own is needed, with this address as its redirect. */
  readonly onNeedsClient?: ((redirect: string) => void) | undefined;
  readonly onBusy: (busy: boolean) => void;
  readonly onDone: (done: { readonly accountId: string; readonly identity?: string | undefined }) => Promise<void>;
}) {
  const t = useT();
  const timeZone = useTimeZone();
  const phone = usePhone();
  const pasteField = useId();
  const [flow, setFlow] = useState<{
    readonly flowId: string;
    readonly authorizeUrl: string;
    readonly redirectUri: string;
    readonly accountId: string;
    readonly via: "here" | "public" | "paste";
    readonly device?: AppDeviceCode | undefined;
  }>();
  // A sign-in by code (RFC 8628): entered on any device, so nothing opens here and nothing comes back.
  const byCode = app.auth.kind === "device";
  // A provider's shared client is a Desktop app client: it comes back to this computer only, never to an https address.
  const sharedClient = app.auth.kind === "oauth" && app.auth.client === "shared-provider";
  const [waiting, setWaiting] = useState(false);
  const [elsewhere, setElsewhere] = useState(phone);
  const [address, setAddress] = useState("");
  // On a phone the address bar is hard to copy whole: its code and state may be typed instead.
  const [typed, setTyped] = useState({ code: "", state: "" });
  const [pasteError, setPasteError] = useState<string | undefined>();
  const { copied, copy } = useCopied();
  const { origin, port } = pageOrigin();
  // A new account is added once, by the first sign-in started: a second try reconnects that one.
  const added = useRef<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);

  const start = async (via: "here" | "public" | "paste"): Promise<void> => {
    onFailure(undefined);
    // One sign-in at a time: a new start ends the one before it.
    setWaiting(false);
    if (flow !== undefined) void appActions.cancel(client, flow.flowId, workspaceId);
    setFlow(undefined);
    setStarting(true);
    onBusy(true);
    const target = added.current ?? accountId;
    const started = await appActions.connect(client, workspaceId, app.appId, {
      via,
      ...(via === "public" ? {} : { origin }),
      ...(target === undefined ? { addAccount } : { accountId: target }),
    });
    onBusy(false);
    setStarting(false);
    if (!started.ok) {
      const redirect = started.details?.["redirect"];
      if (onNeedsClient !== undefined && started.details?.["needsClient"] === true && typeof redirect === "string") onNeedsClient(redirect);
      else onFailure(started.message);
      return;
    }
    const answer = started.value.connect;
    if (addAccount) added.current = answer.accountId;
    setFlow({
      flowId: answer.flowId,
      authorizeUrl: answer.authorizeUrl,
      redirectUri: answer.redirectUri,
      accountId: answer.accountId,
      via,
      device: answer.device,
    });
    // Opened on the person's own click, so a pop-up blocker lets it through; the link below stays for one that did not.
    if (via !== "paste" && answer.device === undefined)
      window.open(answer.authorizeUrl, "_blank", "popup,noopener,noreferrer,width=520,height=680");
    setWaiting(true);
  };
  // While a sign-in waits, its flow is asked after; an answer that comes after it ended is dropped.
  usePoll(
    (alive) => {
      if (flow === undefined) return;
      const { flowId, accountId: flowAccount } = flow;
      void appActions.status(client, flowId, workspaceId).then(async (status) => {
        if (!alive()) return;
        if (!status.ok) {
          setWaiting(false);
          onFailure(status.message);
          return;
        }
        const now = status.value.status;
        if (now.state === "pending") return;
        setWaiting(false);
        if (now.state === "done") await onDone({ accountId: now.accountId ?? flowAccount, identity: now.identity });
        else onFailure(now.state === "expired" ? t("apps.signIn.expired") : (now.message ?? t("apps.signIn.unfinished")));
      });
    },
    SIGN_IN_POLL_MS,
    { enabled: waiting && flow !== undefined },
    [flow?.flowId],
  );

  return (
    <div className="apps-step stack">
      {app.auth.kind === "oauth" && app.auth.scopes.some((scope) => scope.optional) ? (
        <p className="muted">{t("apps.signIn.tickEvery")}</p>
      ) : null}
      <div className="actions">
        <Button variant="primary" disabled={starting} onClick={() => void start("here")}>
          {t(byCode ? "apps.signIn.getCode" : "apps.signIn.signInTo", { app: app.name })}
        </Button>
        {flow === undefined ? null : (
          <Button
            onClick={() => {
              setWaiting(false);
              setFlow(undefined);
              void appActions.cancel(client, flow.flowId, workspaceId);
            }}
          >
            {t("ui.confirm.cancel")}
          </Button>
        )}
      </div>
      {flow?.device === undefined ? null : (
        <div className="apps-device-code">
          <p>
            {withParts(t("apps.signIn.openAndEnter"), {
              address: (
                <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
                  {flow.device.verificationUri}
                </a>
              ),
            })}
          </p>
          <p>
            {withParts(t("apps.signIn.code"), { code: <code className="apps-user-code">{flow.device.userCode}</code> })}{" "}
            <Button size="sm" aria-label={t("apps.signIn.copyCode")} onClick={() => copy(flow.device?.userCode ?? "")}>
              {copied ? t("apps.connect.copied") : t("apps.connect.copy")}
            </Button>
          </p>
          <p className="meta-sm">{t("apps.signIn.onlyThere", { app: app.name })}</p>
        </div>
      )}
      {flow !== undefined && flow.via !== "paste" && flow.device === undefined ? (
        <p className="meta-sm">
          {withParts(t("apps.signIn.noWindow"), {
            link: (
              <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
                {t("apps.signIn.openPage")}
              </a>
            ),
          })}
        </p>
      ) : null}
      {waiting ? (
        <p role="status" className="muted">
          {flow?.device === undefined
            ? t("apps.signIn.waiting")
            : t("apps.signIn.waitingCode", { time: localTime(flow.device.expiresAt, timeZone) })}
        </p>
      ) : null}
      {byCode ? null : (
        <details className="apps-elsewhere" open={elsewhere} onToggle={(event) => setElsewhere((event.target as HTMLDetailsElement).open)}>
          <summary className="disclosure">{t("apps.signIn.elsewhere")}</summary>
          <p>
            {withParts(t("apps.signIn.tunnel"), {
              title: <strong>{t("apps.signIn.tunnelTitle")}</strong>,
              command: <code>{tunnelCommand(port === "" ? "<port>" : port)}</code>,
              copy: (
                <Button size="sm" onClick={() => copy(tunnelCommand(port === "" ? "<port>" : port))}>
                  {copied ? t("apps.connect.copied") : t("apps.connect.copy")}
                </Button>
              ),
              printUrl: <Command>tavi ui --print-url</Command>,
            })}
          </p>
          {sharedClient ? null : (
            <p>
              {withParts(t("apps.signIn.publicAddress"), {
                title: <strong>{t("apps.signIn.publicTitle")}</strong>,
                command: <Command>tavi channels ingress --public-url</Command>,
              })}{" "}
              <Button size="sm" disabled={starting} onClick={() => void start("public")}>
                {t("apps.signIn.useIt")}
              </Button>
            </p>
          )}
          <div>
            <p>
              {withParts(t("apps.signIn.paste"), { title: <strong>{t("apps.signIn.pasteTitle")}</strong> })}{" "}
              <Button size="sm" disabled={starting} onClick={() => void start("paste")}>
                {t("apps.signIn.start")}
              </Button>
            </p>
            {flow?.via === "paste" ? (
              <p className="meta-sm">
                {withParts(t("apps.signIn.signInAt"), {
                  link: (
                    <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
                      {t("apps.signIn.thePage")}
                    </a>
                  ),
                })}
              </p>
            ) : null}
            <label htmlFor={pasteField}>{t("apps.signIn.landedOn")}</label>
            <p id={`${pasteField}-warn`} className="meta-sm">
              {t("apps.signIn.pasteOnlyHere")}
            </p>
            <input
              id={pasteField}
              value={address}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={pasteError === undefined ? `${pasteField}-warn` : `${pasteField}-warn ${pasteField}-error`}
              aria-invalid={pasteError === undefined ? undefined : true}
              disabled={flow?.via !== "paste"}
              onChange={(event) => {
                setAddress(event.target.value);
                setPasteError(undefined);
              }}
            />
            <details className="apps-paste-parts" open={phone}>
              <summary className="disclosure">{t("apps.signIn.typeParts")}</summary>
              <label>
                code{" "}
                <input
                  value={typed.code}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={pasteError === undefined ? undefined : true}
                  aria-describedby={pasteError === undefined ? undefined : `${pasteField}-error`}
                  disabled={flow?.via !== "paste"}
                  onChange={(event) => {
                    setTyped((current) => ({ ...current, code: event.target.value }));
                    setPasteError(undefined);
                  }}
                />
              </label>
              <label>
                state{" "}
                <input
                  value={typed.state}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={pasteError === undefined ? undefined : true}
                  aria-describedby={pasteError === undefined ? undefined : `${pasteField}-error`}
                  disabled={flow?.via !== "paste"}
                  onChange={(event) => {
                    setTyped((current) => ({ ...current, state: event.target.value }));
                    setPasteError(undefined);
                  }}
                />
              </label>
            </details>
            {pasteError === undefined ? null : <Notice id={`${pasteField}-error`}>{pasteError}</Notice>}
            {flow?.via === "paste" ? <p className="meta-sm">{grantWords(app, flow.accountId)}</p> : null}
            <Button
              size="sm"
              disabled={flow?.via !== "paste" || pastedAddress(flow.redirectUri, address, typed) === undefined}
              onClick={() => {
                const pasted = flow === undefined ? undefined : pastedAddress(flow.redirectUri, address, typed);
                if (flow === undefined || pasted === undefined) return;
                void appActions.finish(client, flow.flowId, pasted, workspaceId).then((finished) => {
                  // The address is never echoed: only whether it worked.
                  setAddress("");
                  setTyped({ code: "", state: "" });
                  setPasteError(finished.ok ? undefined : finished.message);
                });
              }}
            >
              {t("apps.signIn.finish")}
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
