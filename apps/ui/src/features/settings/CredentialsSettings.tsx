import { useState } from "react";

import {
  credentialActions,
  validateCredentialForm,
  type CredentialEncryptionStatus,
  type CredentialFormValues,
} from "./credentials-api.js";
import { Command } from "../../ui/Command.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, Notice, PageHead, PageNote } from "../../ui/Parts.js";
import { Confirm } from "../../ui/Confirm.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure } from "./FormParts.js";
import { Field } from "../../ui/Field.js";
import { PasswordInput } from "./PasswordInput.js";
import { useAction, useFormSubmit } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/** Whether the store is encrypted at rest, and where its key is: read-only, as `tavi credentials key` says it. */
function EncryptionStatus({ status }: { readonly status: CredentialEncryptionStatus }) {
  const t = useT();
  return (
    // Unencrypted is a warning, not a note: said in the warning colour.
    <p className={status.kept === "none" ? "credential-encryption credential-encryption-off" : "credential-encryption muted"}>
      {status.kept === "none"
        ? withParts(t("settings.credentials.notEncrypted"), { command: <Command>tavi credentials encrypt</Command> })
        : status.kept === "keychain"
          ? status.keychain === undefined
            ? t("settings.credentials.encryptedOsKeychain")
            : t("settings.credentials.encryptedKeychain", { keychain: status.keychain })
          : t("settings.credentials.encryptedFile")}
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
  if (pluginClient !== null) return translateNow("settings.credentials.label.signIn", { plugin: pluginClient[1] ?? "" });
  const channel = /^channels\.[^.]+\.([^.]+)$/.exec(reference);
  if (channel !== null) return translateNow("settings.credentials.label.channel", { secret: channel[1] ?? "" });
  const apiKey = /^(.+?)\.apiKey(?:\.[^.]+)?$/.exec(reference);
  if (apiKey !== null) return translateNow("settings.credentials.label.apiKey", { connection: apiKey[1] ?? "" });
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
  const t = useT();
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => credentialActions.list(client));
  const { busy, note, tone, run, say } = useAction(reload);
  /** The reference being set: "" for a new one. */
  const [setting, setSetting] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<string | undefined>();
  const stored = data?.credentials ?? [];
  return (
    <section className="settings">
      <PageHead className="settings-head" title={t("settings.credentials.title")} description={t("settings.credentials.description")}>
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setSetting("")}>
          {t("settings.credentials.set")}
        </Button>
      </PageHead>
      {data?.encryption === undefined ? null : <EncryptionStatus status={data.encryption} />}
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
      </LoadState>
      {data !== undefined && stored.length === 0 ? <Empty>{t("settings.credentials.empty")}</Empty> : null}
      <ul className="rows">
        {stored.map((reference) => (
          <li key={reference} className="row">
            <CredentialName reference={reference} />
            <span className="actions">
              <RowAction
                aria-label={t("settings.credentials.replaceLabel", { reference })}
                disabled={busy !== undefined}
                onClick={() => setSetting(reference)}
              >
                {t("settings.credentials.replace")}
              </RowAction>
              <RowAction
                tone="danger"
                aria-label={t("settings.credentials.deleteLabel", { reference })}
                disabled={busy !== undefined}
                onClick={() => setDeleting(reference)}
              >
                {t("settings.action.delete")}
              </RowAction>
            </span>
          </li>
        ))}
      </ul>
      {data !== undefined && data.unusable.length > 0 ? (
        <Failure alert={false}>{t("settings.credentials.unusable", { files: data.unusable.join(", ") })}</Failure>
      ) : null}
      {deleting !== undefined ? (
        <Confirm
          title={t("settings.credentials.deleteTitle", { reference: deleting })}
          message={t("settings.credentials.deleteMessage", { reference: deleting })}
          action={t("settings.action.delete")}
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
  const t = useT();
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
    <Modal
      title={reference === "" ? t("settings.credentials.set") : t("settings.credentials.replaceLabel", { reference })}
      busy={saving}
      onClose={onClose}
    >
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label={t("settings.credentials.reference")} error={touched ? errors.reference : undefined}>
          <input
            autoComplete="off"
            value={values.reference}
            readOnly={reference !== ""}
            placeholder={t("settings.credentials.referencePlaceholder")}
            onChange={(event) => setValues({ ...values, reference: event.target.value })}
          />
        </Field>
        {replaces ? <Notice>{t("settings.credentials.replaces", { reference: values.reference })}</Notice> : null}
        <Field label={t("settings.credentials.value")} error={touched ? errors.value : undefined}>
          {(control) => (
            <PasswordInput
              id={control.id}
              value={values.value}
              placeholder={t("settings.credentials.valuePlaceholder")}
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
          label={t("settings.credentials.store")}
          busyLabel={t("settings.rhumb.storing")}
          onCancel={onClose}
        />
      </form>
    </Modal>
  );
}
