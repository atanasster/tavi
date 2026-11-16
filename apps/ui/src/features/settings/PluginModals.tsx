import { Fragment, useId, useState } from "react";

import {
  pluginRunningVersion,
  ProviderInstancesSchema,
  providerInstanceProblems,
  type PluginView,
  type ProviderInstanceConfig,
} from "@tavi/contracts";
import type { Outcome } from "../../lib/ipc.js";
import { Notice } from "../../ui/Parts.js";
import { ProviderInstancesEditor } from "./ProviderInstancesEditor.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure } from "./FormParts.js";
import { Field } from "../../ui/Field.js";
import { useFormSubmit } from "../../hooks/use-action.js";

export function InstallPluginModal({
  install,
  onClose,
}: {
  readonly install: (path: string) => Promise<Outcome<string | undefined>>;
  readonly onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const problem =
    path.trim() === ""
      ? "Enter the plugin directory's path."
      : !path.startsWith("/")
        ? "Use an absolute path on the owner's machine."
        : undefined;
  const { touched, saving, failure, submit } = useFormSubmit(
    problem === undefined,
    async () => {
      const outcome = await install(path.trim());
      return outcome.ok ? undefined : outcome.message;
    },
    onClose,
  );
  return (
    <Modal title="Install a plugin" busy={saving} onClose={onClose}>
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Plugin directory" error={touched ? problem : undefined}>
          <input value={path} placeholder="/path/to/plugin (contains tavi-plugin.json)" onChange={(event) => setPath(event.target.value)} />
        </Field>
        <Notice>The directory is copied and pinned by its hash. It does not run until you approve and enable it.</Notice>
        <FormFailure message={failure} />
        <FormActions
          saving={saving}
          disabled={saving || (touched && problem !== undefined)}
          cancelDisabled={saving}
          label="Install"
          busyLabel="Installing…"
          onCancel={onClose}
        />
      </form>
    </Modal>
  );
}

export function PluginSettingsModal({
  plugin,
  save,
  onClose,
}: {
  readonly plugin: PluginView;
  readonly save: (
    set: Readonly<Record<string, string | number | boolean>>,
    unset: readonly string[],
    instances?: readonly ProviderInstanceConfig[],
  ) => Promise<Outcome<string | undefined>>;
  readonly onClose: () => void;
}) {
  const fields = Object.entries(plugin.configFields);
  const declarations = pluginRunningVersion(plugin)?.capabilities ?? [];
  const hasProviders = declarations.length > 0 || (plugin.instances?.length ?? 0) > 0;
  const [instances, setInstances] = useState<ProviderInstanceConfig[]>(() => [...(plugin.instances ?? [])]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(([key]) => [key, plugin.config[key] === undefined ? "" : String(plugin.config[key])])),
  );
  const baseId = useId();
  const { saving, failure, submit } = useFormSubmit(
    true,
    async () => {
      const set: Record<string, string | number | boolean> = {},
        unset: string[] = [];
      for (const [key] of fields) {
        const value = values[key] ?? "";
        if (value === "") {
          if (plugin.config[key] !== undefined) unset.push(key);
        } else if (String(plugin.config[key] ?? "") !== value) set[key] = value;
      }
      if (hasProviders) {
        const parsed = ProviderInstancesSchema.safeParse(instances);
        if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        const problems = providerInstanceProblems(declarations, parsed.data, plugin.id);
        if (problems.length > 0) return problems.join("; ");
      }
      if (Object.keys(set).length === 0 && unset.length === 0 && JSON.stringify(instances) === JSON.stringify(plugin.instances ?? []))
        return undefined;
      const outcome = await save(set, unset, hasProviders ? instances : undefined);
      return outcome.ok ? undefined : outcome.message;
    },
    onClose,
  );
  return (
    <Modal title={`${plugin.name} settings`} busy={saving} onClose={onClose}>
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {hasProviders ? <ProviderInstancesEditor declarations={declarations} instances={instances} onChange={setInstances} /> : null}
        {fields.map(([key, field]) => {
          const id = `${baseId}-${key}`;
          return (
            <Fragment key={key}>
              {field.type === "boolean" ? (
                <label htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={values[key] === "true"}
                    onChange={(event) => setValues({ ...values, [key]: event.target.checked ? "true" : "false" })}
                  />{" "}
                  {key}
                  {field.required === true ? " (required)" : ""}
                </label>
              ) : (
                <Field
                  id={id}
                  label={
                    <>
                      {key}
                      {field.required === true ? " (required)" : ""}
                    </>
                  }
                  {...(field.type === "credential"
                    ? {
                        hint: "A credential reference, never the secret: store the value under it in the Credentials view.",
                        hintClassName: "muted",
                      }
                    : {})}
                >
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    value={values[key] ?? ""}
                    placeholder={field.type === "credential" ? `plugins.${plugin.id}.<name>` : undefined}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  />
                </Field>
              )}
              {field.description === undefined ? null : <p className="muted">{field.description}</p>}
            </Fragment>
          );
        })}
        <FormFailure message={failure} />
        <FormActions saving={saving} disabled={saving} cancelDisabled={saving} label="Save" onCancel={onClose} />
      </form>
    </Modal>
  );
}
