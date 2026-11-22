import { useId, useState, type FormEvent } from "react";
import { MODEL_PROVIDER_PRESETS, type ModelProviderPreset } from "@tavi/contracts";

import { hostOf } from "../../lib/format.js";
import { useT } from "../../lib/i18n.js";
import { withParts } from "../../ui/with-parts.js";
import { addModelConnection, connectionProblem, isKeyProblem, modelWrite, rebindModel } from "./model-setup.js";
import { SETTINGS_BOUNDS } from "./common.js";
import type { ConnectionSummary } from "./models-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure } from "./FormParts.js";
import { SECRET_INPUT } from "./PasswordInput.js";
import { BusyFieldset, Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/** The preset's own id, or the first `id-N` no connection has taken. */
function freeName(id: string, taken: readonly string[]): string {
  if (id === "" || !taken.includes(id)) return id;
  let suffix = 2;
  while (taken.includes(`${id}-${suffix}`)) suffix += 1;
  return `${id}-${suffix}`;
}

/**
 * Add a model connection in two steps: pick a provider, then paste its key.
 * The name, label and endpoint come from the preset and stay folded away
 * unless the provider is Custom. Saving stores the key, adds the connection
 * and discovers its models (`addModelConnection`), then hands the page the new
 * connection so it can ask for a default model.
 */
export function AddConnectionModal({
  taken,
  onAdded,
  onClose,
}: {
  /** Connection names already in use: a preset's name is suffixed past them. */
  readonly taken: readonly string[];
  readonly onAdded: (connectionId: string, message: string | undefined) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [preset, setPreset] = useState<ModelProviderPreset | undefined>();
  return (
    <Modal
      title={preset === undefined ? t("settings.connection.addTitle") : t("settings.connection.connectTitle", { name: preset.name })}
      busy={false}
      onClose={onClose}
    >
      {preset === undefined ? (
        <ProviderChoice onChoose={setPreset} />
      ) : (
        <ConnectionDetails
          key={preset.id}
          preset={preset}
          taken={taken}
          onBack={() => setPreset(undefined)}
          onAdded={onAdded}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function ProviderChoice({ onChoose }: { readonly onChoose: (preset: ModelProviderPreset) => void }) {
  const t = useT();
  return (
    <>
      <p className="picker-intro">{t("settings.connection.choose")}</p>
      <ul className="provider-grid list-reset">
        {MODEL_PROVIDER_PRESETS.map((preset) => (
          <li key={preset.id}>
            <Button className="provider-tile" onClick={() => onChoose(preset)}>
              <span className="provider-tile-name">{preset.name}</span>
              <span className="provider-tile-meta">
                {preset.baseUrl === "" ? t("settings.connection.yourEndpoint") : hostOf(preset.baseUrl)}
              </span>
              <span className="provider-tile-tags">
                {preset.localOnly ? <span className="badge">{t("settings.badge.local")}</span> : null}
                {preset.requiresKey ? (
                  <span className="badge">{t("settings.badge.apiKey")}</span>
                ) : (
                  <span className="badge">{t("settings.badge.noKey")}</span>
                )}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ConnectionDetails({
  preset,
  taken,
  onBack,
  onAdded,
  onClose,
}: {
  readonly preset: ModelProviderPreset;
  readonly taken: readonly string[];
  readonly onBack: () => void;
  readonly onAdded: (connectionId: string, message: string | undefined) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { client } = useWorkspace();
  const custom = preset.baseUrl === "";
  const [connectionId, setId] = useState(freeName(custom ? "" : preset.id, taken));
  const [label, setLabel] = useState(custom ? "" : preset.name);
  const [baseUrl, setUrl] = useState(preset.baseUrl);
  const [localOnly, setLocal] = useState(preset.localOnly);
  const [requiresKey, setRequiresKey] = useState(preset.requiresKey);
  const [key, setKey] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const keyId = useId();
  const form = { connectionId, label, baseUrl, localOnly, key, requiresKey };
  const problem = connectionProblem(form);
  // A problem in a folded field opens the fold, so the message points at something visible.
  const detailsProblem = problem !== undefined && !isKeyProblem(problem);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (problem !== undefined || saving) return;
    setSaving(true);
    setFailure(undefined);
    void addModelConnection(client, form).then((outcome: Outcome<string | undefined>) => {
      setSaving(false);
      if (outcome.ok) onAdded(connectionId, outcome.value);
      else setFailure(outcome.message);
    });
  };

  return (
    // The dialog's own messages say what is missing; the browser's bubbles would not name the fold they hide in.
    <form noValidate onSubmit={submit}>
      <BusyFieldset busy={saving} label={t("settings.connection.connecting")} className="settings-fields connection-form">
        <p className="connection-form-lead">
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("settings.connection.allProviders")}
          </Button>
          {preset.note === undefined ? null : <span>{preset.note}</span>}{" "}
          <a href={preset.docsUrl} target="_blank" rel="noreferrer">
            {t("settings.connection.docs", { name: preset.name })}
          </a>
          {preset.keysUrl === undefined ? null : (
            <>
              <span aria-hidden="true"> · </span>
              <a href={preset.keysUrl} target="_blank" rel="noreferrer">
                {t("settings.connection.createKey", { name: preset.name })}
              </a>
            </>
          )}
        </p>
        <label htmlFor={keyId} className="connection-key">
          {requiresKey ? t("settings.connection.apiKey") : t("settings.connection.apiKeyOptional")}
          <input
            id={keyId}
            aria-label={t("settings.connection.apiKeyLabel")}
            {...SECRET_INPUT}
            required={requiresKey}
            maxLength={SETTINGS_BOUNDS.value}
            value={key}
            placeholder={requiresKey ? t("settings.connection.pasteKey", { name: preset.name }) : t("settings.connection.keyless")}
            aria-invalid={touched && isKeyProblem(problem)}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <details className="connection-advanced" open={custom || (touched && detailsProblem)}>
          <summary className="disclosure">{t("settings.connection.details")}</summary>
          <div className="settings-fields">
            <label>
              {t("settings.connection.endpoint")}
              <input
                aria-label={t("settings.connection.endpointLabel")}
                required
                type="url"
                maxLength={SETTINGS_BOUNDS.baseUrl}
                value={baseUrl}
                placeholder="https://host/v1"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              {t("settings.connection.label")}
              <input
                aria-label={t("settings.connection.labelLabel")}
                required
                maxLength={120}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              {t("settings.connection.name")}
              <input
                aria-label={t("settings.connection.name")}
                required
                maxLength={64}
                value={connectionId}
                autoComplete="off"
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <div className="connection-flags">
              <label>
                <input type="checkbox" checked={requiresKey} onChange={(event) => setRequiresKey(event.target.checked)} />{" "}
                {t("settings.connection.requiresKey")}
              </label>
              <label>
                <input type="checkbox" checked={localOnly} onChange={(event) => setLocal(event.target.checked)} />{" "}
                {t("settings.connection.localOnly")}
              </label>
            </div>
          </div>
        </details>
        {touched && problem !== undefined ? <Failure alert={false}>{problem}</Failure> : null}
        <FormFailure message={failure} />
        <FormActions
          saving={saving}
          label={t("settings.connection.submit")}
          busyLabel={t("settings.connection.connecting")}
          onCancel={onClose}
        />
      </BusyFieldset>
    </form>
  );
}

/**
 * One connection's settings: bind it to another stored credential or replace
 * its key, and remove it. A plugin-managed connection is configured in Plugins.
 */
export function ManageConnectionModal({
  connection,
  onDone,
  onClose,
}: {
  readonly connection: ConnectionSummary;
  readonly onDone: (message: string | undefined) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { client } = useWorkspace();
  const [reference, setReference] = useState(connection.credentialRef);
  const [key, setKey] = useState("");
  const [replace, setReplace] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const act = (work: () => Promise<Outcome<string | undefined>>): void => {
    setWorking(true);
    setFailure(undefined);
    void work().then((outcome) => {
      setWorking(false);
      if (outcome.ok) onDone(outcome.value);
      else setFailure(outcome.message);
    });
  };

  if (connection.providerBinding !== undefined) {
    return (
      <Modal title={connection.label} onClose={onClose}>
        <p>{withParts(t("settings.connection.managed"), { instance: <code>{connection.providerBinding.instanceId}</code> })}</p>
      </Modal>
    );
  }
  const newKey = key.trim() !== "";
  const keyField = (
    <>
      <label className="connection-key">
        {connection.localOnly ? t("settings.connection.apiKey") : t("settings.connection.replaceKey")}
        <input
          aria-label={t("settings.connection.newKeyLabel", { label: connection.label })}
          {...SECRET_INPUT}
          maxLength={SETTINGS_BOUNDS.value}
          value={key}
          placeholder={t("settings.connection.pasteNewKey")}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {newKey ? (
        <label>
          <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />{" "}
          {t("settings.connection.replaceStored")}
        </label>
      ) : null}
    </>
  );
  return (
    <Modal title={connection.label} busy={working} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (working || (newKey && !replace)) return;
          act(() => rebindModel(client, connection.connectionId, reference, key));
        }}
      >
        <BusyFieldset busy={working} className="settings-fields connection-form">
          <p className="connection-form-lead">
            <code>{connection.baseUrl}</code>
          </p>
          {/* A server on this computer usually takes no key: the field is there for one that does, folded away. */}
          {connection.localOnly ? (
            <details className="connection-advanced" open={newKey}>
              <summary className="disclosure">{t("settings.connection.setKey")}</summary>
              <div className="settings-fields">
                <p>{t("settings.connection.localKeyHint")}</p>
                {keyField}
              </div>
            </details>
          ) : (
            keyField
          )}
          <details className="connection-advanced">
            <summary className="disclosure">{t("settings.connection.reference")}</summary>
            <div className="settings-fields">
              <label>
                {t("settings.connection.storedAs")}
                <input
                  aria-label={t("settings.connection.credentialLabel", { label: connection.label })}
                  value={reference}
                  maxLength={SETTINGS_BOUNDS.reference}
                  required
                  autoComplete="off"
                  onChange={(event) => setReference(event.target.value)}
                />
              </label>
              <p>{withParts(t("settings.connection.rebindHint"), { command: <Command>tavi models add</Command> })}</p>
            </div>
          </details>
          <section className="danger-zone">
            {removing ? (
              <>
                <p>{t("settings.connection.removeQuestion", { label: connection.label })}</p>
                <div className="danger-zone-actions">
                  <Button variant="ghost" onClick={() => setRemoving(false)}>
                    {t("settings.connection.keep")}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => act(() => modelWrite(client, { action: "remove", connectionId: connection.connectionId }))}
                  >
                    {t("settings.connection.remove")}
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="danger-ghost" onClick={() => setRemoving(true)}>
                {t("settings.connection.removeOpen")}
              </Button>
            )}
          </section>
          <FormFailure message={failure} />
          <FormActions
            saving={working}
            disabled={newKey ? !replace : reference === connection.credentialRef}
            label={newKey ? t("settings.connection.saveKey") : t("settings.connection.saveReference")}
            cancelLabel={t("settings.action.close")}
            onCancel={onClose}
          />
        </BusyFieldset>
      </form>
    </Modal>
  );
}
