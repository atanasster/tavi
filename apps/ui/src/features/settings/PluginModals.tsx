import { Fragment, useId, useState } from "react";

import {
  pluginRunningVersion,
  ProviderInstancesSchema,
  providerInstanceProblems,
  type PluginView,
  type ProviderInstanceConfig,
} from "@tavi/contracts";
import { useT } from "../../lib/i18n.js";
import type { Outcome } from "../../lib/ipc.js";
import { withParts } from "../../ui/with-parts.js";
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
  const t = useT();
  const [path, setPath] = useState("");
  const problem =
    path.trim() === "" ? t("settings.pluginModals.needsPath") : !path.startsWith("/") ? t("settings.pluginModals.absolutePath") : undefined;
  const { touched, saving, failure, submit } = useFormSubmit(
    problem === undefined,
    async () => {
      const outcome = await install(path.trim());
      return outcome.ok ? undefined : outcome.message;
    },
    onClose,
  );
  return (
    <Modal title={t("settings.pluginModals.installTitle")} busy={saving} onClose={onClose}>
      <form
        className="form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* What the folder holds is its hint, not its placeholder: a phone's field cut the placeholder short. */}
        <Field
          label={t("settings.pluginModals.directory")}
          hint={withParts(t("settings.pluginModals.directoryHint"), { file: <code className="file-name">tavi-plugin.json</code> })}
          hintClassName="muted"
          error={touched ? problem : undefined}
        >
          <input value={path} placeholder={t("settings.pluginModals.pathPlaceholder")} onChange={(event) => setPath(event.target.value)} />
        </Field>
        <Notice>{t("settings.pluginModals.pinned")}</Notice>
        <FormFailure message={failure} />
        <FormActions
          saving={saving}
          disabled={saving || (touched && problem !== undefined)}
          cancelDisabled={saving}
          label={t("settings.pluginModals.install")}
          busyLabel={t("settings.pluginModals.installing")}
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
  const t = useT();
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
    <Modal title={t("settings.pluginModals.settingsTitle", { name: plugin.name })} busy={saving} onClose={onClose}>
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
          // Its own name where the manifest gives one ("Adzuna app id"), else its key.
          const name = field.label ?? key;
          // What it is for, then for a key what goes in it: one hint, under its own field and read with it.
          const hint = [field.description, field.type === "credential" ? t("settings.pluginModals.credentialHint") : undefined]
            .filter((part) => part !== undefined)
            .join(" ");
          return (
            <Fragment key={key}>
              {field.type === "boolean" ? (
                <>
                  <label htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={values[key] === "true"}
                      aria-describedby={hint === "" ? undefined : `${id}-hint`}
                      onChange={(event) => setValues({ ...values, [key]: event.target.checked ? "true" : "false" })}
                    />{" "}
                    {field.required === true ? t("settings.instances.required", { key: name }) : name}
                  </label>
                  {hint === "" ? null : (
                    <p id={`${id}-hint`} className="muted">
                      {hint}
                    </p>
                  )}
                </>
              ) : (
                <Field
                  id={id}
                  label={field.required === true ? t("settings.instances.required", { key: name }) : name}
                  {...(hint === "" ? {} : { hint, hintClassName: "muted" })}
                >
                  <input
                    type={field.type === "number" ? "number" : "text"}
                    value={values[key] ?? ""}
                    placeholder={field.type === "credential" ? `plugins.${plugin.id}.<name>` : undefined}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  />
                </Field>
              )}
            </Fragment>
          );
        })}
        <FormFailure message={failure} />
        <FormActions saving={saving} disabled={saving} cancelDisabled={saving} label={t("settings.action.save")} onCancel={onClose} />
      </form>
    </Modal>
  );
}
