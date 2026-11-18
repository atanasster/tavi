import { useId, useState, type FormEvent } from "react";
import { MODEL_PROVIDER_PRESETS, type ModelProviderPreset } from "@tavi/contracts";

import { hostOf } from "../../lib/format.js";
import { addModelConnection, connectionProblem, modelWrite, rebindModel } from "./model-setup.js";
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
  const [preset, setPreset] = useState<ModelProviderPreset | undefined>();
  return (
    <Modal title={preset === undefined ? "Add a model connection" : `Connect ${preset.name}`} busy={false} onClose={onClose}>
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
  return (
    <>
      <p className="picker-intro">Choose where tavi's models come from. Any server that speaks the OpenAI API works through Custom.</p>
      <ul className="provider-grid list-reset">
        {MODEL_PROVIDER_PRESETS.map((preset) => (
          <li key={preset.id}>
            <Button className="provider-tile" onClick={() => onChoose(preset)}>
              <span className="provider-tile-name">{preset.name}</span>
              <span className="provider-tile-meta">{preset.baseUrl === "" ? "Your endpoint" : hostOf(preset.baseUrl)}</span>
              <span className="provider-tile-tags">
                {preset.localOnly ? <span className="badge">local</span> : null}
                {preset.requiresKey ? <span className="badge">API key</span> : <span className="badge">no key</span>}
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
  const detailsProblem = problem !== undefined && !problem.includes("key");

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
      <BusyFieldset busy={saving} label="Connecting…" className="settings-fields connection-form">
        <p className="connection-form-lead">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← All providers
          </Button>
          {preset.note === undefined ? null : <span>{preset.note}</span>}{" "}
          <a href={preset.docsUrl} target="_blank" rel="noreferrer">
            {preset.name} documentation
          </a>
          {preset.keysUrl === undefined ? null : (
            <>
              <span aria-hidden="true"> · </span>
              <a href={preset.keysUrl} target="_blank" rel="noreferrer">
                Create a key at {preset.name}
              </a>
            </>
          )}
        </p>
        <label htmlFor={keyId} className="connection-key">
          {requiresKey ? "API key" : "API key (optional)"}
          <input
            id={keyId}
            aria-label="Model API key"
            {...SECRET_INPUT}
            required={requiresKey}
            maxLength={SETTINGS_BOUNDS.value}
            value={key}
            placeholder={requiresKey ? `Paste your ${preset.name} key` : "Leave empty for a keyless local server"}
            aria-invalid={touched && problem?.includes("key") === true}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <details className="connection-advanced" open={custom || (touched && detailsProblem)}>
          <summary>Connection details</summary>
          <div className="settings-fields">
            <label>
              Endpoint
              <input
                aria-label="Model endpoint"
                required
                type="url"
                maxLength={SETTINGS_BOUNDS.baseUrl}
                value={baseUrl}
                placeholder="https://host/v1"
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              Label
              <input
                aria-label="Connection label"
                required
                maxLength={120}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              Connection name
              <input
                aria-label="Connection name"
                required
                maxLength={64}
                value={connectionId}
                autoComplete="off"
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <div className="connection-flags">
              <label>
                <input type="checkbox" checked={requiresKey} onChange={(event) => setRequiresKey(event.target.checked)} /> Server requires a
                key
              </label>
              <label>
                <input type="checkbox" checked={localOnly} onChange={(event) => setLocal(event.target.checked)} /> Operator-controlled local
                server
              </label>
            </div>
          </div>
        </details>
        {touched && problem !== undefined ? <Failure alert={false}>{problem}</Failure> : null}
        <FormFailure message={failure} />
        <FormActions saving={saving} label="Connect and discover models" busyLabel="Connecting…" onCancel={onClose} />
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
        <p>
          Managed by plugin instance <code>{connection.providerBinding.instanceId}</code>. Configure it in Plugins and store its keys in
          Credentials. Restart the owner after changes.
        </p>
      </Modal>
    );
  }
  const newKey = key.trim() !== "";
  const keyField = (
    <>
      <label className="connection-key">
        {connection.localOnly ? "API key" : "Replace the API key"}
        <input
          aria-label={`New key for ${connection.label}`}
          {...SECRET_INPUT}
          maxLength={SETTINGS_BOUNDS.value}
          value={key}
          placeholder="Paste a new key"
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {newKey ? (
        <label>
          <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /> Replace the stored value,
          including for connections that share it
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
              <summary>Set an API key</summary>
              <div className="settings-fields">
                <p>A local server usually takes none. Enter one only if you turned on its authentication.</p>
                {keyField}
              </div>
            </details>
          ) : (
            keyField
          )}
          <details className="connection-advanced">
            <summary>Credential reference</summary>
            <div className="settings-fields">
              <label>
                Stored as
                <input
                  aria-label={`Credential for ${connection.label}`}
                  value={reference}
                  maxLength={SETTINGS_BOUNDS.reference}
                  required
                  autoComplete="off"
                  onChange={(event) => setReference(event.target.value)}
                />
              </label>
              <p>
                A stored key may be bound to a new origin only if you set it through this owner session. If refused, enter its value here
                again or use <Command>tavi models add</Command> in a terminal.
              </p>
            </div>
          </details>
          <section className="danger-zone">
            {removing ? (
              <>
                <p>
                  Remove {connection.label} and the models it found? A role or the default that uses it must be pointed at another model
                  first. Its key stays in Credentials.
                </p>
                <div className="danger-zone-actions">
                  <Button variant="ghost" onClick={() => setRemoving(false)}>
                    Keep it
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => act(() => modelWrite(client, { action: "remove", connectionId: connection.connectionId }))}
                  >
                    Remove connection
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="danger-ghost" onClick={() => setRemoving(true)}>
                Remove this connection…
              </Button>
            )}
          </section>
          <FormFailure message={failure} />
          <FormActions
            saving={working}
            disabled={newKey ? !replace : reference === connection.credentialRef}
            label={newKey ? "Save new key" : "Save reference"}
            cancelLabel="Close"
            onCancel={onClose}
          />
        </BusyFieldset>
      </form>
    </Modal>
  );
}
