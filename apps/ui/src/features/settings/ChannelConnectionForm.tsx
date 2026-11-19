import { useState, type ReactNode } from "react";

import type {
  ChannelConnectionView,
  ChannelDescriptor,
  ChannelField,
  ChannelsPayload,
  ChannelsSaveAnswer,
  ChannelsOAuthStartAnswer,
  ChannelsOAuthDisconnectAnswer,
  ChannelsOAuthStatusAnswer,
  OAuthClientStatus,
} from "@tavi/contracts";

import { usePoll } from "../../hooks/use-poll.js";
import { ask } from "../../lib/ipc.js";
import { Confirm } from "../../ui/Confirm.js";
import { Modal } from "../../ui/Modal.js";
import { BusyFieldset, Failure, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { keptByWords } from "../apps/model.js";
import { type SettingValue, request } from "./channels-api.js";
import { SETTINGS_BOUNDS } from "./common.js";
import { SECRET_INPUT } from "./PasswordInput.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

function initialSettings(descriptor: ChannelDescriptor, connection: ChannelConnectionView | undefined): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const field of descriptor.settings) {
    const saved = connection?.settings[field.key];
    const value = typeof saved === "string" || typeof saved === "number" || typeof saved === "boolean" ? saved : field.default;
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}
export function ConnectionForm({
  descriptor,
  connection,
  oauthClient,
  encrypted,
  onOAuthClientChanged,
  onClose,
  onSaved,
}: {
  descriptor: ChannelDescriptor;
  connection: ChannelConnectionView | undefined;
  oauthClient: OAuthClientStatus | undefined;
  encrypted: boolean;
  onOAuthClientChanged: () => void;
  onClose: () => void;
  onSaved: (note: string, connectionId: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const secretFields = descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []);
  const [label, setLabel] = useState(connection?.label ?? "");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [settings, setSettings] = useState(() => initialSettings(descriptor, connection));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailure(undefined);
    const given = Object.fromEntries(
      Object.entries(secrets)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value !== ""),
    );
    const answer = await request<ChannelsSaveAnswer>(client, {
      action: "save",
      workspaceId,
      ...(connection === undefined ? {} : { connectionId: connection.connectionId }),
      providerId: descriptor.providerId,
      ...(label.trim() === "" ? {} : { label: label.trim() }),
      enabled,
      settings: Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== "")),
      ...(Object.keys(given).length ? { secrets: given } : {}),
    });
    setSaving(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    onSaved(
      answer.value.notApplied === undefined
        ? `${descriptor.label} saved and applied.`
        : `${descriptor.label} saved, but it could not open: ${answer.value.notApplied}`,
      answer.value.connectionId,
    );
  };
  // An OAuth connection signs in once it is saved.
  let signIn: ReactNode = null;
  if (oauthClient !== undefined && connection === undefined)
    signIn = <p className="settings-description">Save the connection, then connect it with {descriptor.label}.</p>;
  else if (oauthClient !== undefined && connection !== undefined)
    signIn = (
      <SignIn
        descriptor={descriptor}
        connection={connection}
        ready={oauthClient.ready}
        encrypted={encrypted}
        onConnected={onOAuthClientChanged}
      />
    );
  return (
    <Modal title={connection === undefined ? `Connect ${descriptor.label}` : `Edit ${connection.label}`} busy={saving} onClose={onClose}>
      {/* Its own section, outside the connection's form: Enter in it saves the app, not the connection. */}
      {oauthClient === undefined ? null : <OAuthApp descriptor={descriptor} status={oauthClient} onChanged={onOAuthClientChanged} />}
      {signIn}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <BusyFieldset busy={saving} className="settings-fields">
          <p className="settings-description">{descriptor.description}</p>
          {descriptor.setupHelp === undefined ? null : <p className="settings-description">{descriptor.setupHelp}</p>}
          <label>
            <input type="checkbox" aria-label="Enabled" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled
          </label>
          <label>
            Name (optional)
            <input
              aria-label="Connection name"
              maxLength={80}
              value={label}
              placeholder={descriptor.label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {descriptor.settings.map((field) => (
            <SettingInput
              key={field.key}
              field={field}
              value={settings[field.key]}
              onChange={(value) => setSettings({ ...settings, [field.key]: value })}
            />
          ))}
          {secretFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                aria-label={field.label}
                {...SECRET_INPUT}
                maxLength={SETTINGS_BOUNDS.value}
                value={secrets[field.key] ?? ""}
                placeholder={connection?.secretsStored[field.key] ? "Saved" : `Enter ${field.label.toLowerCase()}`}
                onChange={(event) => setSecrets({ ...secrets, [field.key]: event.target.value })}
              />
              {field.help === undefined ? null : <span className="settings-description">{field.help}</span>}
            </label>
          ))}
          {/* The owner's refusal, over the footer it answers rather than under it. */}
          <Failure message={failure} />
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {saving ? "Saving…" : "Save connection"}
            </Button>
          </div>
        </BusyFieldset>
      </form>
    </Modal>
  );
}
/**
 * The OAuth app a channel connects through: the
 * same for every OAuth channel. The plugin's app is used unless the operator
 * enters their own — which an operator-owned channel needs before anything
 * connects — stored once for the channel, for all its connections.
 */
function OAuthApp({ descriptor, status, onChanged }: { descriptor: ChannelDescriptor; status: OAuthClientStatus; onChanged: () => void }) {
  const { client } = useWorkspace();
  const [changing, setChanging] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const act = async (payload: ChannelsPayload): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    const answer = await request(client, payload);
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    setChanging(false);
    setClientId("");
    setClientSecret("");
    onChanged();
  };
  const entering = changing || !status.ready;
  const saveApp = (): void => {
    if (clientId.trim() === "" || busy) return;
    void act({
      action: "oauth-client",
      providerId: descriptor.providerId,
      clientId: clientId.trim(),
      ...(clientSecret.trim() === "" ? {} : { clientSecret: clientSecret.trim() }),
    });
  };
  return (
    <form
      className="settings-panel"
      aria-label="OAuth app"
      onSubmit={(event) => {
        event.preventDefault();
        saveApp();
      }}
    >
      <h3 className="settings-section-title">OAuth app</h3>
      {entering ? (
        <>
          <p className="settings-description">
            {status.source === "operator"
              ? `${descriptor.label} connects through an OAuth app of your own: create one with the provider and enter it here, once for every ${descriptor.label} connection.`
              : `Use your own OAuth app in place of the one ${descriptor.label} ships with.`}
          </p>
          <label>
            Client ID
            <input aria-label="OAuth client ID" maxLength={512} value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </label>
          <label>
            Client secret (if the provider gave one)
            <input
              aria-label="OAuth client secret"
              {...SECRET_INPUT}
              maxLength={4096}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </label>
          <div className="actions">
            {changing ? (
              <Button variant="ghost" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            ) : null}
            <Button variant="primary" type="submit" disabled={busy || clientId.trim() === ""}>
              Save OAuth app
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-description">
            {status.own ? "Connects through your own OAuth app." : `Connects through the OAuth app ${descriptor.label} ships with.`}
          </p>
          <div className="actions">
            <Button variant="ghost" onClick={() => setChanging(true)}>
              Use a different OAuth app
            </Button>
            {status.own ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void act({ action: "oauth-client-clear", providerId: descriptor.providerId })}
              >
                Forget my OAuth app
              </Button>
            ) : null}
          </div>
        </>
      )}
      <Failure message={failure} />
    </form>
  );
}
/** How long the page waits between asking whether a sign-in has come back. */
const SIGN_IN_POLL_MS = 2000;
/**
 * Signing a connection in: the provider's page
 * opens in a window of its own, and this page asks the owner how it went —
 * the provider's redirect carries no session, so nothing comes back here but
 * through the owner.
 */
function SignIn({
  descriptor,
  connection,
  ready,
  encrypted,
  onConnected,
}: {
  descriptor: ChannelDescriptor;
  connection: ChannelConnectionView;
  ready: boolean;
  encrypted: boolean;
  onConnected: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [flowId, setFlowId] = useState<string>();
  const [note, setNote] = useState<string>();
  const [failure, setFailure] = useState<string>();
  usePoll(
    () => {
      if (flowId === undefined) return;
      void request<ChannelsOAuthStatusAnswer>(client, { action: "oauth-status", workspaceId, flowId }).then((answer) => {
        if (!answer.ok) {
          setFailure(answer.message);
          setFlowId(undefined);
          return;
        }
        if (answer.value.state === "pending") return;
        setFlowId(undefined);
        if (answer.value.state === "connected") {
          setNote(`Connected as ${answer.value.accountIdentity ?? descriptor.label}.`);
          onConnected();
        } else if (answer.value.detail !== undefined) setFailure(answer.value.detail);
        else if (answer.value.state === "expired") setFailure("The sign-in took too long; connect again.");
        else setFailure("The sign-in did not finish; connect again.");
      });
    },
    SIGN_IN_POLL_MS,
    { enabled: flowId !== undefined },
    [client, workspaceId, flowId, descriptor.label, onConnected],
  );
  const connect = async (): Promise<void> => {
    setFailure(undefined);
    setNote(undefined);
    const answer = await request<ChannelsOAuthStartAnswer>(client, {
      action: "oauth-start",
      workspaceId,
      connectionId: connection.connectionId,
      origin: window.location.origin,
    });
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    setFlowId(answer.value.flowId);
    // Its own window, cut off from this one: the provider's page has no hold on Tavi's.
    window.open(answer.value.authorizeUrl, "_blank", "popup,noopener,noreferrer,width=560,height=720");
  };
  const [confirming, setConfirming] = useState(false);
  const disconnect = async (): Promise<void> => {
    setFailure(undefined);
    setNote(undefined);
    const answer = await request<ChannelsOAuthDisconnectAnswer>(client, {
      action: "oauth-disconnect",
      workspaceId,
      connectionId: connection.connectionId,
    });
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    const kept = answer.value.keptBy ?? [];
    setNote(
      `Signed out of ${descriptor.label}: the connection is closed until it is connected again.${kept.length === 0 ? "" : ` ${kept.join(" and ")} keeps its sign-in.`}`,
    );
    onConnected();
  };
  const connected = connection.authState === "connected";
  // A sign-in kept on disk — connected, needing consent, or lapsed — can always be signed out.
  const signedIn = connection.authState !== "none" && connection.authState !== "revoked";
  let action = connected ? `Reconnect with ${descriptor.label}` : `Connect with ${descriptor.label}`;
  if (flowId !== undefined) action = "Waiting for the sign-in…";
  const encrypt = async (): Promise<void> => {
    setFailure(undefined);
    const answer = await ask<{ readonly undecryptable?: readonly string[]; readonly unencrypted?: readonly string[] }>(
      client,
      "credentials",
      { action: "encrypt" },
      {
        timeoutMs: null,
        refused: "The credentials could not be encrypted.",
        unreachable: "The service could not be reached. Reconnect and try again.",
      },
    );
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    // As `tavi credentials encrypt` says them: what it could not read with this key, and what it left as it was.
    const undecryptable = answer.value.undecryptable ?? [];
    const unencrypted = answer.value.unencrypted ?? [];
    if (undecryptable.length > 0)
      setFailure(`Some credentials do not decrypt with this data directory's key: ${undecryptable.join(", ")}. Set them again.`);
    setNote(
      `Credentials are encrypted at rest. You can connect now.${unencrypted.length === 0 ? "" : ` Left as they were (not credentials): ${unencrypted.join(", ")}.`}`,
    );
    onConnected();
  };
  if (!encrypted) {
    // A sign-in keeps a refresh token: only in an encrypted store.
    return (
      <section className="settings-panel" aria-label="Sign-in">
        <p className="settings-description">
          Connecting {descriptor.label} keeps a sign-in token, which Tavi keeps only in an encrypted credential store. Turn on encryption
          first: every saved credential is rewritten encrypted, with a key kept beside them in the data directory.
        </p>
        <div className="actions">
          <Button variant="primary" onClick={() => void encrypt()}>
            Encrypt credentials
          </Button>
        </div>
        <StatusNote note={note} />
        <Failure message={failure} />
      </section>
    );
  }
  return (
    <section className="settings-panel" aria-label="Sign-in">
      <p className="settings-description">
        {connected ? `Connected as ${connection.accountIdentity}.` : `Not connected: sign in with ${descriptor.label} to use it.`}
      </p>
      <div className="actions">
        <Button variant="primary" disabled={!ready || flowId !== undefined} onClick={() => void connect()}>
          {action}
        </Button>
        {flowId !== undefined ? (
          <Button
            variant="ghost"
            onClick={() => {
              setFlowId(undefined);
              setNote("Sign-in cancelled. Connect again when you are ready.");
            }}
          >
            Cancel sign-in
          </Button>
        ) : null}
        {signedIn ? (
          <Button variant="ghost" disabled={flowId !== undefined} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <Confirm
          title={`Disconnect ${connection.accountIdentity === "" ? connection.label : connection.accountIdentity}?`}
          message={disconnectWords(descriptor, connection)}
          action="Disconnect"
          onClose={() => setConfirming(false)}
          onConfirm={disconnect}
        />
      ) : null}
      <StatusNote note={note} />
      <Failure message={failure} />
    </section>
  );
}
/** What a disconnect does, said before it is done, as Connected apps says it: another app keeping the sign-in holds back the provider's revoke. */
function disconnectWords(descriptor: ChannelDescriptor, connection: ChannelConnectionView): string {
  const kept = connection.keptBy ?? [];
  const revoke = kept.length === 0 ? "Its sign-in is revoked where the provider allows it" : keptByWords(kept, "the provider");
  return `${descriptor.label} closes until it is connected again. ${revoke}.`;
}
function SettingInput({
  field,
  value,
  onChange,
}: {
  field: ChannelField;
  value: SettingValue | undefined;
  onChange: (value: SettingValue) => void;
}) {
  const help = field.help === undefined ? null : <span className="settings-description">{field.help}</span>;
  if (field.type === "boolean")
    return (
      <label>
        <input type="checkbox" aria-label={field.label} checked={value === true} onChange={(event) => onChange(event.target.checked)} />{" "}
        {field.label}
        {help}
      </label>
    );
  if (field.type === "choice") {
    return (
      <label>
        {field.label}
        <Select aria-label={field.label} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          {field.required === true ? null : <option value="">—</option>}
          {(field.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
        {help}
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label>
        {field.label}
        <input
          aria-label={field.label}
          type="number"
          required={field.required === true}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
        {help}
      </label>
    );
  }
  return (
    <label>
      {field.label}
      {field.required === true ? "" : " (optional)"}
      <input
        aria-label={field.label}
        required={field.required === true}
        maxLength={2048}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value.trim())}
      />
      {help}
    </label>
  );
}
