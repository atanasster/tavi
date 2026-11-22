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
import { andList, keptByWords } from "../apps/model.js";
import { type SettingValue, request } from "./channels-api.js";
import { SETTINGS_BOUNDS } from "./common.js";
import { SECRET_INPUT } from "./PasswordInput.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { translateNow, useT } from "../../lib/i18n.js";

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
  const t = useT();
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
        ? t("settings.connectionForm.saved", { label: descriptor.label })
        : t("settings.connectionForm.savedNotApplied", { label: descriptor.label, reason: answer.value.notApplied }),
      answer.value.connectionId,
    );
  };
  // An OAuth connection signs in once it is saved.
  let signIn: ReactNode = null;
  if (oauthClient !== undefined && connection === undefined)
    signIn = <p className="settings-description">{t("settings.connectionForm.saveFirst", { label: descriptor.label })}</p>;
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
    <Modal
      title={
        connection === undefined
          ? t("settings.connectionForm.connectTitle", { label: descriptor.label })
          : t("settings.connectionForm.editTitle", { label: connection.label })
      }
      busy={saving}
      onClose={onClose}
    >
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
            <input
              type="checkbox"
              aria-label={t("settings.connectionForm.enabled")}
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            {t("settings.connectionForm.enabled")}
          </label>
          <label>
            {t("settings.connectionForm.nameOptional")}
            <input
              aria-label={t("settings.connectionForm.nameLabel")}
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
                placeholder={
                  connection?.secretsStored[field.key]
                    ? t("settings.connectionForm.savedPlaceholder")
                    : t("settings.connectionForm.enter", { what: field.label.toLowerCase() })
                }
                onChange={(event) => setSecrets({ ...secrets, [field.key]: event.target.value })}
              />
              {field.help === undefined ? null : <span className="settings-description">{field.help}</span>}
            </label>
          ))}
          {/* The owner's refusal, over the footer it answers rather than under it. */}
          <Failure message={failure} />
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              {t("ui.confirm.cancel")}
            </Button>
            <Button variant="primary" type="submit">
              {saving ? t("ui.parts.saving") : t("settings.connectionForm.save")}
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
  const t = useT();
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
      aria-label={t("settings.oauthApp.title")}
      onSubmit={(event) => {
        event.preventDefault();
        saveApp();
      }}
    >
      <h3 className="settings-section-title">{t("settings.oauthApp.title")}</h3>
      {entering ? (
        <>
          <p className="settings-description">
            {status.source === "operator"
              ? t("settings.oauthApp.operator", { label: descriptor.label })
              : t("settings.oauthApp.useOwn", { label: descriptor.label })}
          </p>
          <label>
            {t("settings.oauthApp.clientId")}
            <input
              aria-label={t("settings.oauthApp.clientIdLabel")}
              maxLength={512}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>
          <label>
            {t("settings.oauthApp.clientSecret")}
            <input
              aria-label={t("settings.oauthApp.clientSecretLabel")}
              {...SECRET_INPUT}
              maxLength={4096}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </label>
          <div className="actions">
            {changing ? (
              <Button variant="ghost" onClick={() => setChanging(false)}>
                {t("ui.confirm.cancel")}
              </Button>
            ) : null}
            <Button variant="primary" type="submit" disabled={busy || clientId.trim() === ""}>
              {t("settings.oauthApp.save")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-description">
            {status.own ? t("settings.oauthApp.connectsOwn") : t("settings.oauthApp.connectsShipped", { label: descriptor.label })}
          </p>
          <div className="actions">
            <Button variant="ghost" onClick={() => setChanging(true)}>
              {t("settings.oauthApp.different")}
            </Button>
            {status.own ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void act({ action: "oauth-client-clear", providerId: descriptor.providerId })}
              >
                {t("settings.oauthApp.forget")}
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
  const t = useT();
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
          setNote(t("settings.signIn.connectedAs", { identity: answer.value.accountIdentity ?? descriptor.label }));
          onConnected();
        } else if (answer.value.detail !== undefined) setFailure(answer.value.detail);
        else if (answer.value.state === "expired") setFailure(t("settings.signIn.expired"));
        else setFailure(t("settings.signIn.failed"));
      });
    },
    SIGN_IN_POLL_MS,
    { enabled: flowId !== undefined },
    [client, workspaceId, flowId, descriptor.label, onConnected, t],
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
      `${t("settings.signIn.signedOut", { label: descriptor.label })}${kept.length === 0 ? "" : ` ${t("settings.signIn.keeps", { kept: andList(kept) })}`}`,
    );
    onConnected();
  };
  const connected = connection.authState === "connected";
  // A sign-in kept on disk — connected, needing consent, or lapsed — can always be signed out.
  const signedIn = connection.authState !== "none" && connection.authState !== "revoked";
  let action = connected
    ? t("settings.signIn.reconnect", { label: descriptor.label })
    : t("settings.signIn.connect", { label: descriptor.label });
  if (flowId !== undefined) action = t("settings.signIn.waiting");
  const encrypt = async (): Promise<void> => {
    setFailure(undefined);
    const answer = await ask<{ readonly undecryptable?: readonly string[]; readonly unencrypted?: readonly string[] }>(
      client,
      "credentials",
      { action: "encrypt" },
      {
        timeoutMs: null,
        refused: t("settings.signIn.encryptRefused"),
        unreachable: t("settings.channels.unreachable"),
      },
    );
    if (!answer.ok) {
      setFailure(answer.message);
      return;
    }
    // As `tavi credentials encrypt` says them: what it could not read with this key, and what it left as it was.
    const undecryptable = answer.value.undecryptable ?? [];
    const unencrypted = answer.value.unencrypted ?? [];
    if (undecryptable.length > 0) setFailure(t("settings.signIn.undecryptable", { names: undecryptable.join(", ") }));
    setNote(
      `${t("settings.signIn.encrypted")}${unencrypted.length === 0 ? "" : ` ${t("settings.signIn.leftAsIs", { names: unencrypted.join(", ") })}`}`,
    );
    onConnected();
  };
  if (!encrypted) {
    // A sign-in keeps a refresh token: only in an encrypted store.
    return (
      <section className="settings-panel" aria-label={t("settings.signIn.label")}>
        <p className="settings-description">{t("settings.signIn.needsEncryption", { label: descriptor.label })}</p>
        <div className="actions">
          <Button variant="primary" onClick={() => void encrypt()}>
            {t("settings.signIn.encrypt")}
          </Button>
        </div>
        <StatusNote note={note} />
        <Failure message={failure} />
      </section>
    );
  }
  return (
    <section className="settings-panel" aria-label={t("settings.signIn.label")}>
      <p className="settings-description">
        {connected
          ? t("settings.signIn.connectedAs", { identity: connection.accountIdentity })
          : t("settings.signIn.notConnected", { label: descriptor.label })}
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
              setNote(t("settings.signIn.cancelled"));
            }}
          >
            {t("settings.signIn.cancel")}
          </Button>
        ) : null}
        {signedIn ? (
          <Button variant="ghost" disabled={flowId !== undefined} onClick={() => setConfirming(true)}>
            {t("settings.signIn.disconnect")}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <Confirm
          title={t("settings.signIn.disconnectTitle", {
            name: connection.accountIdentity === "" ? connection.label : connection.accountIdentity,
          })}
          message={disconnectWords(descriptor, connection)}
          action={t("settings.signIn.disconnect")}
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
  const revoke = kept.length === 0 ? translateNow("apps.disconnect.revoked") : keptByWords(kept, undefined);
  return translateNow("settings.signIn.disconnectMessage", { label: descriptor.label, revoke });
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
  const t = useT();
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
      {field.required === true ? "" : ` ${t("settings.connectionForm.optional")}`}
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
