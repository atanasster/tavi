import { useEffect, useId, useRef, useState } from "react";

import type { AppAccountView, AppClientSetupStep, AppMailboxAccess, AppSharing, ConnectableApp } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { useCopied } from "../../hooks/page.js";
import { Failure } from "../../ui/Parts.js";
import { appActions } from "./apps-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { announceOnboardingChanged } from "../welcome/onboarding-api.js";
import { Modal } from "../../ui/Modal.js";
import { PasswordInput } from "../settings/PasswordInput.js";
import { ACCESS_TITLES, authorsWords, isolationWords, keyUnchecked, storedWords } from "./model.js";
import { credentialActions } from "../settings/credentials-api.js";
import { Button } from "../../ui/Button.js";
import { SignInStep } from "./SignInStep.js";
import { Field } from "../../ui/Field.js";

/**
 * Connecting an account: what the
 * app can do, the provider's client when it needs one, the sign-in, and its
 * other-computer paths — a tunnel, the owner's https address, or pasting the
 * address the browser lands on. Every word about the app comes from the owner.
 */

type Step = "what" | "client" | "own-client" | "sign-in" | "key" | "done";

/** A step's first item: a link, a field or a button. */
const STEP_START = "a[href], input:not([readonly]):not([disabled]), select:not([disabled]), textarea, button:not([disabled])";

export function ConnectSheet({
  client,
  workspaceId,
  app,
  accountId,
  addAccount = false,
  onClose,
  onConnected,
  onReview,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly app: ConnectableApp;
  /** Reconnect this account; absent, the app's first, or a new one with `addAccount`. */
  readonly accountId?: string | undefined;
  readonly addAccount?: boolean;
  readonly onClose: () => void;
  readonly onConnected: (accountId: string) => void;
  /** An MCP server's tools reviewed once it is signed in, for the account just connected. */
  readonly onReview?: ((accountId: string) => void) | undefined;
}) {
  // However the sheet closes, setup's checklist reads its status again: it unmounts on every close.
  useEffect(() => () => announceOnboardingChanged(), []);
  // A secret field says "encrypted" only when the credential store is: read once, as Settings → Credentials reads it.
  const [stored, setStored] = useState(() => storedWords(undefined));
  useEffect(() => {
    let live = true;
    void credentialActions.list(client).then((listed) => {
      if (live && listed.ok) setStored(storedWords(listed.value.encryption?.kept));
    });
    return () => {
      live = false;
    };
  }, [client]);
  // The redirect a client of the person's own registers, when the server registers none itself.
  const [ownRedirect, setOwnRedirect] = useState<string>();
  // An app reached with a key: the key is pasted and tested in place of a sign-in.
  const keyed = app.auth.kind === "api-key";
  const access: Step = keyed ? "key" : "sign-in";
  const steps: readonly Step[] = [
    "what",
    ...(app.clientSetup === undefined ? [] : (["client"] as const)),
    ...(ownRedirect === undefined ? [] : (["own-client"] as const)),
    access,
    "done",
  ];
  const [step, setStep] = useState<Step>(
    accountId === undefined && !addAccount ? "what" : app.clientSetup !== undefined && !app.clientSetup.ready ? "client" : access,
  );
  // An account being reconnected keeps its own choice; only one the person changes here is written.
  const existing = app.accounts.find((candidate) => candidate.accountId === accountId);
  // The account being connected, when it exists: a new one is made only as it signs in.
  const connecting = addAccount ? undefined : (existing ?? app.accounts[0]);
  const [sharing, setSharing] = useState<AppSharing>(
    existing?.sharing ?? (app.trust.confidentiality === "personal" ? "personal" : "shared"),
  );
  const chose = useRef(false);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<{
    readonly accountId: string;
    readonly identity?: string | undefined;
    /** Its server listed its tools without checking the key. */
    readonly keyUnchecked?: boolean;
  }>();
  /** Personal or Shared is the account's own choice: written once the account is known. */
  const finish = async (done: {
    readonly accountId: string;
    readonly identity?: string | undefined;
    readonly keyUnchecked?: boolean;
  }): Promise<void> => {
    const account = app.accounts.find((candidate) => candidate.accountId === done.accountId);
    if (chose.current && account?.sharing !== sharing) {
      const set = await appActions.sharing(client, workspaceId, app.appId, done.accountId, sharing);
      if (!set.ok) {
        setFailure(`${keyed ? "Connected" : "Signed in"}, but who may use it was not saved: ${set.message}`);
        return;
      }
    }
    setConnected(done);
    setStep("done");
  };
  const titleOf: Readonly<Record<Step, string>> = {
    what: "What it can do",
    client: app.clientSetup?.title ?? "Your client",
    "own-client": "Your client",
    "sign-in": "Sign in",
    key: "Your key",
    done: onReview === undefined ? "Connected" : "Review tools",
  };
  // Each step takes focus at its first item as it opens (the dialog's own pick skips links), so a step change never drops
  // focus to the page; a step with nothing to focus yet holds it itself.
  const stepHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = stepHost.current;
    (host?.querySelector<HTMLElement>(STEP_START) ?? host)?.focus();
  }, [step]);
  return (
    <Modal title={`Connect ${app.name}`} wide busy={busy} onClose={onClose}>
      <ol className="apps-steps" aria-label="steps">
        {steps.map((each, index) => (
          <li key={each} aria-current={each === step ? "step" : undefined}>
            {String(index + 1)}. {titleOf[each]}
          </li>
        ))}
      </ol>
      <Failure message={failure} />
      <div ref={stepHost} tabIndex={-1} className="apps-step-host">
        {step === "what" ? (
          <WhatItCanDo
            app={app}
            account={connecting}
            busy={busy}
            sharing={sharing}
            onSharing={(next) => {
              chose.current = true;
              setSharing(next);
            }}
            onNext={async (options) => {
              // What the account turns on is written before it signs in, so the sign-in asks for its access.
              if (connecting !== undefined) {
                setBusy(true);
                setFailure(undefined);
                const failed = await applyOptions(client, workspaceId, app.appId, connecting, options);
                setBusy(false);
                if (failed !== undefined) {
                  setFailure(failed);
                  return;
                }
              }
              setStep(app.clientSetup === undefined ? access : "client");
            }}
            onClose={onClose}
          />
        ) : null}
        {step === "client" && app.clientSetup !== undefined ? (
          <ClientStep
            app={app}
            stored={stored}
            busy={busy}
            onBack={() => setStep("what")}
            onSave={async (values) => {
              // A client set up already and nothing new given: straight to the sign-in.
              if (values.clientFile === undefined && values.values === undefined) {
                setStep("sign-in");
                return;
              }
              setBusy(true);
              setFailure(undefined);
              const saved = await appActions.configure(client, workspaceId, app.appId, values);
              setBusy(false);
              if (!saved.ok) {
                setFailure(saved.message);
                return;
              }
              setStep("sign-in");
            }}
          />
        ) : null}
        {step === "own-client" && ownRedirect !== undefined ? (
          <OwnClientStep
            app={app}
            stored={stored}
            redirect={ownRedirect}
            busy={busy}
            onBack={() => setStep("sign-in")}
            onSave={async (values) => {
              setBusy(true);
              setFailure(undefined);
              const saved = await appActions.configure(client, workspaceId, app.appId, {
                values,
                ...(connecting === undefined ? {} : { accountId: connecting.accountId }),
              });
              setBusy(false);
              if (!saved.ok) {
                setFailure(saved.message);
                return;
              }
              setStep("sign-in");
            }}
          />
        ) : null}
        {step === "sign-in" ? (
          <SignInStep
            client={client}
            workspaceId={workspaceId}
            app={app}
            accountId={accountId}
            addAccount={addAccount}
            onFailure={setFailure}
            onNeedsClient={(redirect) => {
              setOwnRedirect(redirect);
              setStep("own-client");
            }}
            onBusy={setBusy}
            onDone={async (done) => {
              // An MCP server's tools are listed once it is signed in, as Save and test lists a keyed one's, so
              // Review its tools opens on them rather than on "Not probed yet".
              if (onReview !== undefined) {
                setBusy(true);
                const tested = await appActions.test(client, workspaceId, app.appId, done.accountId);
                setBusy(false);
                if (!tested.ok) setFailure(`Signed in, but its tools could not be listed yet: ${tested.message}`);
              }
              await finish(done);
            }}
          />
        ) : null}
        {step === "key" && app.auth.kind === "api-key" ? (
          <KeyStep
            auth={app.auth}
            // What its setup waits for (a key not given, or refused), as the list says it.
            note={
              connecting?.health === "not-set-up"
                ? app.repairs.find((repair) => repair.kind === "finish-setup" && repair.accountId === connecting.accountId)?.detail
                : undefined
            }
            stored={stored}
            busy={busy}
            onBack={() => setStep("what")}
            onSave={async (values) => {
              if (connecting === undefined) {
                setFailure(`Add ${app.name} again from Discover for another account.`);
                return;
              }
              setBusy(true);
              setFailure(undefined);
              const at = { accountId: connecting.accountId };
              const saved = await appActions.configure(client, workspaceId, app.appId, { values, ...at });
              // The key is tested at once: the server is asked for its tools with it.
              const tested = saved.ok ? await appActions.test(client, workspaceId, app.appId, connecting.accountId) : saved;
              if (!tested.ok) {
                setBusy(false);
                setFailure(saved.ok ? `The key is saved, but the test failed: ${tested.message}` : tested.message);
                return;
              }
              // Busy until who may use it is written too, so the key is not saved and tested twice meanwhile.
              await finish({ ...at, keyUnchecked: keyUnchecked(tested.value) });
              setBusy(false);
            }}
          />
        ) : null}
        {step === "done" && connected !== undefined ? (
          <div className="apps-step stack">
            {connected.keyUnchecked === true ? (
              <>
                <p role="status">Saved the key; {app.name} listed its tools.</p>
                <p className="muted">
                  {app.name} lists its tools without checking the key, so a wrong key shows only when Tavi first uses a tool.
                </p>
              </>
            ) : (
              <p role="status">
                Connected {app.name}
                {connected.identity === undefined ? "" : ` as ${connected.identity}`}.
              </p>
            )}
            {onReview === undefined ? (
              <>
                <p className="muted">Review its tools before the agent uses them, if it asks you to.</p>
                <div className="actions">
                  <Button variant="primary" onClick={() => onConnected(connected.accountId)}>
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">Its tools are offered once you have reviewed what each may do.</p>
                <div className="actions">
                  <Button variant="primary" onClick={() => onReview(connected.accountId)}>
                    Review its tools
                  </Button>
                  <Button onClick={() => onConnected(connected.accountId)}>Later</Button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** What an account may turn on, as the first step offers it: only those its app has. */
interface AccountOptions {
  readonly calendar?: boolean;
  readonly mailbox?: AppMailboxAccess;
  readonly receives?: boolean;
}

/** Writes each option the person changed, in order; the first refusal's words, or undefined when all were written. */
async function applyOptions(
  client: SettingsClient,
  workspaceId: string,
  appId: string,
  account: AppAccountView,
  options: AccountOptions,
): Promise<string | undefined> {
  const changes: (() => ReturnType<typeof appActions.calendar>)[] = [
    ...(options.receives === undefined || options.receives === account.receives
      ? []
      : [() => appActions.receive(client, workspaceId, appId, account.accountId, options.receives === true)]),
    ...(options.mailbox === undefined || options.mailbox === account.mailbox
      ? []
      : [() => appActions.mailbox(client, workspaceId, appId, account.accountId, options.mailbox ?? "off")]),
    ...(options.calendar === undefined || options.calendar === account.calendar
      ? []
      : [() => appActions.calendar(client, workspaceId, appId, account.accountId, options.calendar === true)]),
  ];
  for (const change of changes) {
    const done = await change();
    if (!done.ok) return done.message;
  }
  return undefined;
}

function WhatItCanDo({
  app,
  account,
  busy,
  sharing,
  onSharing,
  onNext,
  onClose,
}: {
  readonly app: ConnectableApp;
  /** The account being connected, when it exists: its options are offered here. */
  readonly account: AppAccountView | undefined;
  readonly busy: boolean;
  readonly sharing: AppSharing;
  readonly onSharing: (sharing: AppSharing) => void;
  readonly onNext: (options: AccountOptions) => void;
  readonly onClose: () => void;
}) {
  const [calendar, setCalendar] = useState(account?.calendar);
  const [mailbox, setMailbox] = useState(account?.mailbox);
  const [receives, setReceives] = useState(account?.receives);
  const scopes = app.auth.kind === "oauth" || app.auth.kind === "device" ? app.auth.scopes : [];
  const name = useId();
  const byAccess = (["read", "change", "send"] as const)
    .map((access) => ({ access, items: scopes.filter((scope) => scope.access === access) }))
    .filter((entry) => entry.items.length > 0);
  return (
    <div className="apps-step stack">
      <p>
        {app.name} will be able to{authorsWords(app) ? ", in its author's words" : ""}:
      </p>
      {byAccess.length === 0 ? (
        <p className="muted">
          {app.tools.length === 0
            ? "It offers no tools yet: they are listed once it is reviewed."
            : `${String(app.tools.length)} tools, listed on its page.`}
        </p>
      ) : (
        <dl className="apps-scopes">
          {byAccess.map(({ access, items }) => (
            <div key={access}>
              <dt>{ACCESS_TITLES[access]}</dt>
              {items.map((scope) => (
                <dd key={scope.scope}>{scope.says}</dd>
              ))}
            </div>
          ))}
        </dl>
      )}
      <p className="muted">
        Calls go to{" "}
        {app.egress.anyNetwork ? "any network" : app.egress.hosts.length === 0 ? "nowhere off this computer" : app.egress.hosts.join(", ")}{" "}
        ({isolationWords(app)}). What it returns is treated as untrusted
        {app.trust.confidentiality === "personal" ? ", personal data" : " content"}. Tavi asks before anything changes or is sent; you can
        tighten this later.
      </p>
      <fieldset className="apps-sharing">
        <legend>Is this your own account, or one your household or team shares?</legend>
        <label>
          <input type="radio" name={name} checked={sharing === "personal"} onChange={() => onSharing("personal")} /> Personal: only in your
          own chats
        </label>
        <label>
          <input type="radio" name={name} checked={sharing === "shared"} onChange={() => onSharing("shared")} /> Shared: people you allowed
          may use it too{app.source.kind === "mcp" ? ", once you let them on its page" : ""}
        </label>
      </fieldset>
      {calendar === undefined && mailbox === undefined && receives === undefined ? null : (
        <fieldset className="apps-options">
          <legend>What to turn on (each asks before it changes or sends anything)</legend>
          {calendar === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={calendar} onChange={(event) => setCalendar(event.target.checked)} /> Let the agent use your
              calendar
            </label>
          )}
          {mailbox === undefined ? null : (
            <>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={mailbox !== "off"}
                  onChange={(event) => setMailbox(event.target.checked ? "read" : "off")}
                />{" "}
                Let the agent read and draft in your mailbox
              </label>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={mailbox === "send"}
                  disabled={mailbox === "off"}
                  onChange={(event) => setMailbox(event.target.checked ? "send" : "read")}
                />{" "}
                Send drafts I approve
              </label>
            </>
          )}
          {receives === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={receives} onChange={(event) => setReceives(event.target.checked)} /> Reach Tavi through this
              account
            </label>
          )}
        </fieldset>
      )}
      <div className="actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => onNext(definedOnly({ calendar, mailbox, receives }))}>
          Next
        </Button>
      </div>
    </div>
  );
}

function ClientStep({
  app,
  stored,
  busy,
  onBack,
  onSave,
}: {
  readonly app: ConnectableApp;
  /** What its secret field says of where the value goes. */
  readonly stored: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onSave: (values: { readonly values?: Readonly<Record<string, string>>; readonly clientFile?: string }) => Promise<void>;
}) {
  const setup = app.clientSetup;
  const idField = useId();
  const secretField = useId();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [file, setFile] = useState<{ readonly name: string; readonly text: string } | undefined>(undefined);
  const [fileProblem, setFileProblem] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  if (setup === undefined) return null;
  const typed = clientId.trim() !== "";
  const ready = setup.ready && !typed && file === undefined;
  /** A dropped or picked file, read here and sent whole: the owner reads its id and secret. */
  const take = async (picked: File | undefined): Promise<void> => {
    setFileProblem(undefined);
    setFile(undefined);
    if (picked === undefined) return;
    if (picked.size > 8_192) {
      setFileProblem("That file is too large to be a client file.");
      return;
    }
    try {
      setFile({ name: picked.name, text: await picked.text() });
    } catch {
      setFileProblem("That file could not be read.");
    }
  };
  return (
    <form
      className="apps-step stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(
          file !== undefined
            ? { clientFile: file.text }
            : typed
              ? { values: { clientId: clientId.trim(), ...(secret === "" ? {} : { clientSecret: secret }) } }
              : {},
        );
      }}
    >
      {setup.ready ? <p className="muted">A client is set up already, and is reused: add another file only to change it.</p> : null}
      <ol className="apps-guide">
        {setup.steps.map((step) => (
          <SetupStep key={step.text} step={step} />
        ))}
      </ol>
      <label
        className={`apps-drop${dragging ? " apps-drop-over" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void take(event.dataTransfer.files[0]);
        }}
      >
        {file === undefined ? "Drop the client's JSON file here, or choose it" : `Client file: ${file.name}`}
        <input
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => void take(event.target.files?.[0])}
        />
      </label>
      {fileProblem === undefined ? null : <p role="alert">{fileProblem}</p>}
      <details>
        <summary>More: paste the client id and secret instead</summary>
        <Field id={idField} label="Client id">
          <input value={clientId} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
        </Field>
        <Field id={secretField} label="Client secret">
          {(control) => (
            <PasswordInput
              id={control.id}
              value={secret}
              placeholder={stored}
              invalid={control["aria-invalid"] === true}
              describedBy={control["aria-describedby"]}
              onChange={setSecret}
            />
          )}
        </Field>
      </details>
      <div className="actions">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" type="submit" disabled={busy || (!ready && !typed && file === undefined)}>
          {ready ? "Next" : "Save and next"}
        </Button>
      </div>
    </form>
  );
}

/** A key's steps, each with the page it opens, and its fields: saved, then tested with the server at once. */
function KeyStep({
  auth,
  note,
  stored,
  busy,
  onBack,
  onSave,
}: {
  readonly auth: Extract<ConnectableApp["auth"], { readonly kind: "api-key" }>;
  /** Why its setup is not finished: its key is missing, or was refused. */
  readonly note?: string | undefined;
  /** What its key field says of where the value goes. */
  readonly stored: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onSave: (values: Readonly<Record<string, string>>) => Promise<void>;
}) {
  const fieldId = useId();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const ready = auth.fields.every((field) => field.required !== true || (values[field.key] ?? "").trim() !== "");
  return (
    <form
      className="apps-step stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== "")));
      }}
    >
      {note === undefined ? null : <p>{note}</p>}
      {auth.keySteps === undefined ? null : (
        <ol className="apps-guide">
          {auth.keySteps.map((step) => (
            <SetupStep key={step.text} step={step} />
          ))}
        </ol>
      )}
      {auth.fields.map((field, index) => (
        <Field key={field.key} id={`${fieldId}-${String(index)}`} label={field.label}>
          {(control) =>
            field.type === "credential" ? (
              <PasswordInput
                id={control.id}
                value={values[field.key] ?? ""}
                placeholder={stored}
                invalid={control["aria-invalid"] === true}
                describedBy={control["aria-describedby"]}
                onChange={(value) => setValues((before) => ({ ...before, [field.key]: value }))}
              />
            ) : (
              <input
                id={control.id}
                value={values[field.key] ?? ""}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setValues((before) => ({ ...before, [field.key]: event.target.value }))}
              />
            )
          }
        </Field>
      ))}
      <div className="actions">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          Save and test
        </Button>
      </div>
    </form>
  );
}

/**
 * A server that registers no clients itself: the person makes one in its developer settings, registering this
 * address as its redirect, and gives its id (and secret, when it has one).
 */
function OwnClientStep({
  app,
  stored,
  redirect,
  busy,
  onBack,
  onSave,
}: {
  readonly app: ConnectableApp;
  /** What its secret field says of where the value goes. */
  readonly stored: string;
  readonly redirect: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onSave: (values: Readonly<Record<string, string>>) => Promise<void>;
}) {
  const idField = useId();
  const secretField = useId();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <form
      className="apps-step stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ clientId: clientId.trim(), ...(secret === "" ? {} : { clientSecret: secret }) });
      }}
    >
      <p>
        {app.name} does not register Tavi by itself. Create an OAuth app in its developer settings, give it this redirect address, and paste
        its client id here.
      </p>
      <dl className="apps-values">
        <div>
          <dt>Redirect address</dt>
          <dd>
            <CopyValue value={redirect} />
          </dd>
        </div>
      </dl>
      <Field id={idField} label="Client id">
        <input value={clientId} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
      </Field>
      <Field id={secretField} label="Client secret (if it has one)">
        {(control) => (
          <PasswordInput
            id={control.id}
            value={secret}
            placeholder={stored}
            invalid={control["aria-invalid"] === true}
            describedBy={control["aria-describedby"]}
            onChange={setSecret}
          />
        )}
      </Field>
      <div className="actions">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" type="submit" disabled={busy || clientId.trim() === ""}>
          Save and sign in
        </Button>
      </div>
    </form>
  );
}

/** One console step: its words, the page it opens in a new tab, and the values to type, each with a copy button. */
function SetupStep({ step }: { readonly step: AppClientSetupStep }) {
  return (
    <li>
      {step.text}
      {step.link === undefined ? null : (
        <>
          {" "}
          <a href={step.link.url} target="_blank" rel="noreferrer noopener">
            {step.link.label}
          </a>
        </>
      )}
      {step.values === undefined ? null : (
        <dl className="apps-values">
          {step.values.map((each) => (
            <div key={each.label}>
              <dt>{each.label}</dt>
              <dd>
                <CopyValue value={each.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function CopyValue({ value }: { readonly value: string }) {
  const { copied, copy } = useCopied();
  return (
    <>
      <code>{value}</code>{" "}
      <Button size="sm" onClick={() => copy(value)}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </>
  );
}
