import { useEffect, useId, useRef, useState } from "react";

import type { AppAccountView, AppClientSetupStep, AppMailboxAccess, AppSettingField, AppSharing, ConnectableApp } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { useCopied } from "../../hooks/page.js";
import { useT } from "../../lib/i18n.js";
import { Failure } from "../../ui/Parts.js";
import { appActions } from "./apps-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { announceOnboardingChanged } from "../welcome/onboarding-api.js";
import { Modal } from "../../ui/Modal.js";
import { PasswordInput } from "../settings/PasswordInput.js";
import { ACCESS_TITLES, authorsWords, isolationWords, keyUnchecked, repairDetail, storedWords } from "./model.js";
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
  const t = useT();
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
        setFailure(t(keyed ? "apps.connect.sharingFailedKeyed" : "apps.connect.sharingFailed", { reason: set.message }));
        return;
      }
    }
    setConnected(done);
    setStep("done");
  };
  const titleOf: Readonly<Record<Step, string>> = {
    what: t("apps.connect.stepWhat"),
    client: app.clientSetup?.title ?? t("apps.connect.stepClient"),
    "own-client": t("apps.connect.stepClient"),
    "sign-in": t("apps.connect.stepSignIn"),
    key: t("apps.connect.stepKey"),
    done: onReview === undefined ? t("apps.connect.stepConnected") : t("apps.connect.stepReview"),
  };
  // Each step takes focus at its first item as it opens (the dialog's own pick skips links), so a step change never drops
  // focus to the page; a step with nothing to focus yet holds it itself.
  const stepHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = stepHost.current;
    (host?.querySelector<HTMLElement>(STEP_START) ?? host)?.focus();
  }, [step]);
  return (
    <Modal title={t("apps.card.connect", { app: app.name })} wide busy={busy} onClose={onClose}>
      <ol className="apps-steps" aria-label={t("apps.connect.steps")}>
        {steps.map((each, index) => (
          <li key={each} aria-current={each === step ? "step" : undefined}>
            {t("apps.connect.stepNumbered", { number: String(index + 1), title: titleOf[each] })}
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
                if (!tested.ok) setFailure(t("apps.connect.toolsNotListed", { reason: tested.message }));
              }
              await finish(done);
            }}
          />
        ) : null}
        {step === "key" && app.auth.kind === "api-key" ? (
          <KeyStep
            auth={app.auth}
            // A required setting that is not a key (Home Assistant's address) is asked here too, or the setup could
            // never finish in this sheet.
            settings={app.settings.filter((field) => field.required && field.type !== "credential" && !field.advanced)}
            // What its setup waits for (a key not given, or refused), as the list says it.
            note={
              connecting?.health === "not-set-up"
                ? (() => {
                    const repair = app.repairs.find(
                      (candidate) => candidate.kind === "finish-setup" && candidate.accountId === connecting.accountId,
                    );
                    return repair === undefined ? undefined : repairDetail(repair);
                  })()
                : undefined
            }
            stored={stored}
            busy={busy}
            onBack={() => setStep("what")}
            onSave={async (values) => {
              if (connecting === undefined) {
                setFailure(t("apps.connect.addAgain", { app: app.name }));
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
                setFailure(saved.ok ? t("apps.connect.testFailed", { reason: tested.message }) : tested.message);
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
                <p role="status">{t("apps.connect.keySaved", { app: app.name })}</p>
                <p className="muted">{t("apps.connect.keyUnchecked", { app: app.name })}</p>
              </>
            ) : (
              <p role="status">
                {connected.identity === undefined
                  ? t("apps.connect.connected", { app: app.name })
                  : t("apps.connect.connectedAs", { app: app.name, identity: connected.identity })}
              </p>
            )}
            {onReview === undefined ? (
              <>
                <p className="muted">{t("apps.connect.reviewIfAsked")}</p>
                <div className="actions">
                  <Button variant="primary" onClick={() => onConnected(connected.accountId)}>
                    {t("apps.channel.done")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">{t("apps.connect.offeredOnceReviewed")}</p>
                <div className="actions">
                  <Button variant="primary" onClick={() => onReview(connected.accountId)}>
                    {t("apps.connect.reviewItsTools")}
                  </Button>
                  <Button onClick={() => onConnected(connected.accountId)}>{t("apps.connect.later")}</Button>
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
  const t = useT();
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
      {/* With no access to list, one sentence: never a lead-in to an empty list. */}
      {byAccess.length === 0 ? (
        <p>
          {app.tools.length === 0
            ? t("apps.connect.noTools", { app: app.name })
            : t("apps.connect.offersTools", { app: app.name, count: app.tools.length })}
        </p>
      ) : (
        <>
          <p>{t(authorsWords(app) ? "apps.connect.willBeAbleAuthor" : "apps.connect.willBeAble", { app: app.name })}</p>
          <dl className="apps-scopes">
            {byAccess.map(({ access, items }) => (
              <div key={access}>
                <dt>{t(ACCESS_TITLES[access])}</dt>
                {items.map((scope) => (
                  <dd key={scope.scope}>{scope.says}</dd>
                ))}
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="muted">
        {t(app.trust.confidentiality === "personal" ? "apps.connect.callsGoPersonal" : "apps.connect.callsGo", {
          where: app.egress.anyNetwork
            ? t("apps.connect.anyNetwork")
            : app.egress.hosts.length === 0
              ? t("apps.connect.nowhere")
              : t("apps.connect.toHosts", { hosts: app.egress.hosts.join(", ") }),
          isolation: isolationWords(app),
        })}
      </p>
      <fieldset className="apps-sharing">
        <legend>{t("apps.connect.whoseAccount")}</legend>
        <label>
          <input type="radio" name={name} checked={sharing === "personal"} onChange={() => onSharing("personal")} />{" "}
          {t("apps.connect.personal")}
        </label>
        <label>
          <input type="radio" name={name} checked={sharing === "shared"} onChange={() => onSharing("shared")} />{" "}
          {t(app.source.kind === "mcp" ? "apps.connect.sharedMcp" : "apps.connect.shared")}
        </label>
      </fieldset>
      {calendar === undefined && mailbox === undefined && receives === undefined ? null : (
        <fieldset className="apps-options">
          <legend>{t("apps.connect.turnOn")}</legend>
          {calendar === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={calendar} onChange={(event) => setCalendar(event.target.checked)} />{" "}
              {t("apps.connect.calendar")}
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
                {t("apps.connect.mailboxRead")}
              </label>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={mailbox === "send"}
                  disabled={mailbox === "off"}
                  onChange={(event) => setMailbox(event.target.checked ? "send" : "read")}
                />{" "}
                {t("apps.connect.mailboxSend")}
              </label>
            </>
          )}
          {receives === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={receives} onChange={(event) => setReceives(event.target.checked)} />{" "}
              {t("apps.account.receive")}
            </label>
          )}
        </fieldset>
      )}
      <div className="actions">
        <Button variant="ghost" onClick={onClose}>
          {t("ui.confirm.cancel")}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => onNext(definedOnly({ calendar, mailbox, receives }))}>
          {t("apps.connect.next")}
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
  const t = useT();
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
      setFileProblem(t("apps.connect.fileTooLarge"));
      return;
    }
    try {
      setFile({ name: picked.name, text: await picked.text() });
    } catch {
      setFileProblem(t("apps.connect.fileUnreadable"));
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
      {setup.ready ? <p className="muted">{t("apps.connect.clientReady")}</p> : null}
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
        {file === undefined ? t("apps.connect.dropFile") : t("apps.connect.clientFile", { file: file.name })}
        <input
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => void take(event.target.files?.[0])}
        />
      </label>
      {fileProblem === undefined ? null : <p role="alert">{fileProblem}</p>}
      <details>
        <summary className="disclosure">{t("apps.connect.pasteInstead")}</summary>
        <Field id={idField} label={t("apps.connect.clientId")}>
          <input value={clientId} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
        </Field>
        <Field id={secretField} label={t("apps.connect.clientSecret")}>
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
        <Button onClick={onBack}>{t("apps.connect.back")}</Button>
        <Button variant="primary" type="submit" disabled={busy || (!ready && !typed && file === undefined)}>
          {ready ? t("apps.connect.next") : t("apps.connect.saveAndNext")}
        </Button>
      </div>
    </form>
  );
}

/** A key's steps, each with the page it opens, and its fields: saved, then tested with the server at once. */
function KeyStep({
  auth,
  settings = [],
  note,
  stored,
  busy,
  onBack,
  onSave,
}: {
  readonly auth: Extract<ConnectableApp["auth"], { readonly kind: "api-key" }>;
  /** Its required settings that are not keys, asked before them: blank keeps one already saved. */
  readonly settings?: readonly AppSettingField[];
  /** Why its setup is not finished: its key is missing, or was refused. */
  readonly note?: string | undefined;
  /** What its key field says of where the value goes. */
  readonly stored: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onSave: (values: Readonly<Record<string, string>>) => Promise<void>;
}) {
  const t = useT();
  const fieldId = useId();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  // A required setting may already be saved (a key refused later): only the keys must be given here.
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
      {settings.map((field) => (
        <Field key={field.key} id={`${fieldId}-${field.key}`} label={field.label} hint={field.help}>
          {(control) => (
            <input
              {...control}
              type={field.type === "url" ? "url" : "text"}
              value={values[field.key] ?? ""}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setValues((before) => ({ ...before, [field.key]: event.target.value }))}
            />
          )}
        </Field>
      ))}
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
        <Button onClick={onBack}>{t("apps.connect.back")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !ready}>
          {t("apps.connect.saveAndTest")}
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
  const t = useT();
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
      <p>{t("apps.connect.ownClient", { app: app.name })}</p>
      <dl className="apps-values">
        <div>
          <dt>{t("apps.connect.redirect")}</dt>
          <dd>
            <CopyValue value={redirect} />
          </dd>
        </div>
      </dl>
      <Field id={idField} label={t("apps.connect.clientId")}>
        <input value={clientId} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
      </Field>
      <Field id={secretField} label={t("apps.connect.clientSecretOptional")}>
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
        <Button onClick={onBack}>{t("apps.connect.back")}</Button>
        <Button variant="primary" type="submit" disabled={busy || clientId.trim() === ""}>
          {t("apps.connect.saveAndSignIn")}
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
  const t = useT();
  const { copied, copy } = useCopied();
  return (
    <>
      <code>{value}</code>{" "}
      <Button size="sm" onClick={() => copy(value)}>
        {copied ? t("apps.connect.copied") : t("apps.connect.copy")}
      </Button>
    </>
  );
}
