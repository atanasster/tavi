import { useId, useRef, useState } from "react";

import { signsIn, type AppDeviceCode, type ConnectableApp } from "@tavi/contracts";

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
  const who = account === undefined ? `a new ${app.name} account` : (account.identity ?? account.label);
  return `Finishing signs in ${who}${scopes.length === 0 ? "" : `, allowing: ${scopes.join("; ")}`}.`;
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
        else
          onFailure(
            now.state === "expired"
              ? "The sign-in took too long. Start it again."
              : (now.message ?? "The sign-in did not finish. Start it again."),
          );
      });
    },
    SIGN_IN_POLL_MS,
    { enabled: waiting && flow !== undefined },
    [flow?.flowId],
  );

  return (
    <div className="apps-step stack">
      {app.auth.kind === "oauth" && app.auth.scopes.some((scope) => scope.optional) ? (
        <p className="muted">
          The provider may list each access with its own box, none ticked: tick every one (or Select all), or what you leave out stays off.
        </p>
      ) : null}
      <div className="actions">
        <Button variant="primary" disabled={starting} onClick={() => void start("here")}>
          {byCode ? `Get a code to sign in to ${app.name}` : `Sign in to ${app.name}`}
        </Button>
        {flow === undefined ? null : (
          <Button
            onClick={() => {
              setWaiting(false);
              setFlow(undefined);
              void appActions.cancel(client, flow.flowId, workspaceId);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {flow?.device === undefined ? null : (
        <div className="apps-device-code">
          <p>
            On any phone or computer, open{" "}
            <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
              {flow.device.verificationUri}
            </a>{" "}
            and enter this code:
          </p>
          <p>
            Code: <code className="apps-user-code">{flow.device.userCode}</code>{" "}
            <Button size="sm" aria-label="Copy the sign-in code" onClick={() => copy(flow.device?.userCode ?? "")}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </p>
          <p className="meta-sm">Enter it only on {app.name}'s own page. Tavi never asks for it anywhere else.</p>
        </div>
      )}
      {flow !== undefined && flow.via !== "paste" && flow.device === undefined ? (
        <p className="meta-sm">
          No window opened?{" "}
          <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
          .
        </p>
      ) : null}
      {waiting ? (
        <p role="status" className="muted">
          {flow?.device === undefined
            ? "Waiting for the sign-in… (it waits 10 minutes)"
            : `Waiting for the code to be entered… (it works until ${localTime(flow.device.expiresAt, timeZone)})`}
        </p>
      ) : null}
      {byCode ? null : (
        <details className="apps-elsewhere" open={elsewhere} onToggle={(event) => setElsewhere((event.target as HTMLDetailsElement).open)}>
          <summary className="disclosure">Signing in from another computer?</summary>
          <p>
            <strong>A. Tunnel.</strong> On that computer run <code>{tunnelCommand(port === "" ? "<port>" : port)}</code>{" "}
            <Button size="sm" onClick={() => copy(tunnelCommand(port === "" ? "<port>" : port))}>
              {copied ? "Copied" : "Copy"}
            </Button>
            , open the address <Command>tavi ui --print-url</Command> prints there, and sign in from it.
          </p>
          {sharedClient ? null : (
            <p>
              <strong>B. This server's https address.</strong> Only your browser must reach it (a Tailscale name will do); it is set with{" "}
              <Command>tavi channels ingress --public-url</Command>.{" "}
              <Button size="sm" disabled={starting} onClick={() => void start("public")}>
                Use it
              </Button>
            </p>
          )}
          <div>
            <p>
              <strong>C. Paste the address you land on.</strong> Start the sign-in, finish it in any browser, then paste the address it
              lands on here — even if that page fails to open.{" "}
              <Button size="sm" disabled={starting} onClick={() => void start("paste")}>
                Start
              </Button>
            </p>
            {flow?.via === "paste" ? (
              <p className="meta-sm">
                Sign in at:{" "}
                <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
                  the sign-in page
                </a>
              </p>
            ) : null}
            <label htmlFor={pasteField}>Address you landed on after signing in</label>
            <p id={`${pasteField}-warn`} className="meta-sm">
              Paste it only here, in Tavi. Never paste a sign-in address into a chat, an email or another site.
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
              <summary className="disclosure">Or type its code and state</summary>
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
              Finish
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
