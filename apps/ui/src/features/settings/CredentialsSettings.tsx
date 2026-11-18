import { useState } from "react";

import {
  credentialActions,
  validateCredentialForm,
  type CredentialEncryptionStatus,
  type CredentialFormValues,
} from "./credentials-api.js";
import { Command } from "../../ui/Command.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, Notice, PageHead, StatusNote } from "../../ui/Parts.js";
import { Confirm } from "../../ui/Confirm.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure } from "./FormParts.js";
import { Field } from "../../ui/Field.js";
import { PasswordInput } from "./PasswordInput.js";
import { useAction, useFormSubmit } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** Whether the store is encrypted at rest, and where its key is: read-only, as `tavi credentials key` says it. */
function EncryptionStatus({ status }: { readonly status: CredentialEncryptionStatus }) {
  return (
    // Unencrypted is a warning, not a note: said in the warning colour.
    <p className={status.kept === "none" ? "credential-encryption credential-encryption-off" : "credential-encryption muted"}>
      {status.kept === "none" ? (
        <>
          Not encrypted: run <Command>tavi credentials encrypt</Command>
        </>
      ) : status.kept === "keychain" ? (
        `Encrypted; key in ${status.keychain ?? "the OS keychain"}`
      ) : (
        "Encrypted; key in credentials.key in the data directory"
      )}
    </p>
  );
}

/**
 * What a stored reference is for, in words, from the shapes the owner names
 * them in: a connection's API key (`ollama.apiKey.<id>`), a channel's secret
 * (`channels.<id>.token`), a channel plugin's sign-in secret. Undefined for a
 * reference that is already its own name (`openrouter`).
 */
export function credentialLabel(reference: string): string | undefined {
  const pluginClient = /^channels\.plugin-client\.([^.]+)\.secret$/.exec(reference);
  if (pluginClient !== null) return `${pluginClient[1]} sign-in secret`;
  const channel = /^channels\.[^.]+\.([^.]+)$/.exec(reference);
  if (channel !== null) return `Channel ${channel[1]}`;
  const apiKey = /^(.+?)\.apiKey(?:\.[^.]+)?$/.exec(reference);
  if (apiKey !== null) return `${apiKey[1]} API key`;
  return undefined;
}

/** A stored reference: what it is for when that can be said, with the reference itself under it. */
function CredentialName({ reference }: { readonly reference: string }) {
  const label = credentialLabel(reference);
  return label === undefined ? (
    <code>{reference}</code>
  ) : (
    <span className="credential-name">
      <strong>{label}</strong>
      <code className="meta-sm">{reference}</code>
    </span>
  );
}

/**
 * The owner's credentials, as references only: a value is set
 * through a masked form, crosses the bridge once to the owner, and is never
 * read back — the list names what is stored, never what it holds.
 */
export function CredentialsSettings() {
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => credentialActions.list(client));
  const { busy, note, run, say } = useAction(reload);
  /** The reference being set: "" for a new one. */
  const [setting, setSetting] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<string | undefined>();
  const stored = data?.credentials ?? [];
  return (
    <section className="settings">
      <PageHead className="settings-head" title="Credentials">
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setSetting("")}>
          Set a credential
        </Button>
      </PageHead>
      <Notice>Values are stored by the owner and never shown here. Model connections and search providers name them by reference.</Notice>
      {data?.encryption === undefined ? null : <EncryptionStatus status={data.encryption} />}
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      {data !== undefined && stored.length === 0 ? <Empty>No credential is stored.</Empty> : null}
      <ul className="rows">
        {stored.map((reference) => (
          <li key={reference} className="row">
            <CredentialName reference={reference} />
            <span className="actions">
              <Button size="sm" aria-label={`Replace ${reference}`} disabled={busy !== undefined} onClick={() => setSetting(reference)}>
                Replace
              </Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Delete ${reference}`}
                disabled={busy !== undefined}
                onClick={() => setDeleting(reference)}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {data !== undefined && data.unusable.length > 0 ? (
        <Failure alert={false}>Files that are not usable credentials: {data.unusable.join(", ")}.</Failure>
      ) : null}
      {deleting !== undefined ? (
        <Confirm
          title={`Delete ${deleting}?`}
          message={`The value is gone for good, and a model connection or search provider that names ${deleting} stops working until it is set again.`}
          action="Delete"
          onClose={() => setDeleting(undefined)}
          onConfirm={() => run(`delete:${deleting}`, () => credentialActions.remove(client, deleting))}
        />
      ) : null}
      {setting !== undefined ? (
        <CredentialForm
          reference={setting}
          stored={stored}
          onClose={() => setSetting(undefined)}
          save={async (values) => {
            const outcome = await credentialActions.set(client, values);
            if (outcome.ok) {
              say(outcome.value);
              reload();
            }
            return outcome;
          }}
        />
      ) : null}
    </section>
  );
}

function CredentialForm({
  reference,
  stored,
  save,
  onClose,
}: {
  readonly reference: string;
  readonly stored: readonly string[];
  readonly save: (values: CredentialFormValues) => Promise<Outcome<string | undefined>>;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<CredentialFormValues>({ reference, value: "" });
  const errors = validateCredentialForm(values);
  const valid = Object.keys(errors).length === 0;
  const { touched, saving, failure, submit } = useFormSubmit(
    valid,
    async () => {
      const outcome = await save(values);
      return outcome.ok ? undefined : outcome.message;
    },
    onClose,
  );
  // A new reference that is already stored: said, since storing it replaces its value.
  const replaces = reference === "" && stored.includes(values.reference);
  return (
    <Modal title={reference === "" ? "Set a credential" : `Replace ${reference}`} busy={saving} onClose={onClose}>
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Reference" error={touched ? errors.reference : undefined}>
          <input
            autoComplete="off"
            value={values.reference}
            readOnly={reference !== ""}
            placeholder="e.g. openai.apiKey"
            onChange={(event) => setValues({ ...values, reference: event.target.value })}
          />
        </Field>
        {replaces ? <Notice>{values.reference} is stored: this replaces its value.</Notice> : null}
        <Field label="Value" error={touched ? errors.value : undefined}>
          {(control) => (
            <PasswordInput
              id={control.id}
              value={values.value}
              placeholder="Paste the secret"
              invalid={control["aria-invalid"] === true}
              describedBy={control["aria-describedby"]}
              onChange={(value) => setValues({ ...values, value })}
            />
          )}
        </Field>
        <FormFailure message={failure} />
        <FormActions
          saving={saving}
          disabled={saving || (touched && !valid)}
          cancelDisabled={saving}
          label="Store"
          busyLabel="Storing…"
          onCancel={onClose}
        />
      </form>
    </Modal>
  );
}
