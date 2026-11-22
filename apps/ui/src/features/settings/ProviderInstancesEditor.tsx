import type { ProviderDeclaration, ProviderInstanceConfig } from "@tavi/contracts";
import { useRowKeys } from "../../hooks/use-row-keys.js";
import { useT } from "../../lib/i18n.js";
import { Select } from "../../ui/Select.js";
import { Button } from "../../ui/Button.js";

/** Declarative provider configuration; credentials are references to the Credentials view. */
export function ProviderInstancesEditor({
  declarations,
  instances,
  onChange,
}: {
  readonly declarations: readonly ProviderDeclaration[];
  readonly instances: readonly ProviderInstanceConfig[];
  readonly onChange: (instances: ProviderInstanceConfig[]) => void;
}) {
  // The ID is typed into, so it cannot be the key: each row's is carried to its edited copy.
  const t = useT();
  const { keyOf, carry } = useRowKeys<ProviderInstanceConfig>();
  const update = (index: number, patch: Partial<ProviderInstanceConfig>) =>
    onChange(instances.map((instance, at) => (at === index ? carry(instance, { ...instance, ...patch }) : instance)));
  return (
    <section>
      <h3>{t("settings.instances.title")}</h3>
      <p>{t("settings.instances.hint")}</p>
      {instances.map((instance, index) => {
        const declaration = declarations.find((item) => item.id === instance.factory);
        const setting = (key: string, value: ProviderInstanceConfig["settings"][string] | undefined) => {
          const settings = { ...instance.settings };
          if (value === undefined) delete settings[key];
          else settings[key] = value;
          update(index, { settings });
        };
        const number = index + 1;
        return (
          <fieldset key={keyOf(instance)} className="settings-fields">
            <legend>{t("settings.instances.legend", { number })}</legend>
            <label>
              {t("settings.instances.id")}
              <input
                aria-label={t("settings.instances.idLabel", { number })}
                required
                maxLength={64}
                value={instance.id}
                onChange={(event) => update(index, { id: event.target.value })}
              />
            </label>
            <label>
              {t("settings.instances.factory")}
              <Select
                aria-label={t("settings.instances.factoryLabel", { number })}
                value={instance.factory}
                onChange={(event) => update(index, { factory: event.target.value, settings: {}, credentials: {} })}
              >
                {declaration === undefined ? (
                  <option value={instance.factory}>{t("settings.instances.unavailable", { factory: instance.factory })}</option>
                ) : null}
                {declarations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} ({item.kind})
                  </option>
                ))}
              </Select>
            </label>
            <p>{declaration?.disclosure}</p>
            <label>
              {t("settings.instances.workspace")}
              <input
                aria-label={t("settings.instances.workspaceLabel", { number })}
                required
                maxLength={128}
                value={instance.workspaceId}
                onChange={(event) => update(index, { workspaceId: event.target.value })}
              />
            </label>
            <label>
              {t("settings.instances.account")}
              <input
                aria-label={t("settings.instances.accountLabel", { number })}
                required
                maxLength={64}
                value={instance.accountId}
                onChange={(event) => update(index, { accountId: event.target.value })}
              />
            </label>
            {Object.entries(declaration?.settings ?? {}).map(([key, field]) => {
              const value = instance.settings[key];
              const label = t("settings.instances.settingLabel", { number, key });
              return (
                // biome-ignore lint/a11y/noLabelWithoutControl: every branch of the ternary below renders the control (Select, textarea or input)
                <label key={key}>
                  {field.required ? t("settings.instances.required", { key }) : key}
                  {field.type === "boolean" ? (
                    <Select
                      aria-label={label}
                      value={value === undefined ? "" : String(value)}
                      onChange={(event) => setting(key, event.target.value === "" ? undefined : event.target.value === "true")}
                    >
                      <option value="">{t("settings.instances.default")}</option>
                      <option value="true">{t("settings.instances.yes")}</option>
                      <option value="false">{t("settings.instances.no")}</option>
                    </Select>
                  ) : field.type === "strings" ? (
                    <textarea
                      aria-label={label}
                      value={Array.isArray(value) ? value.join("\n") : ""}
                      onChange={(event) => setting(key, event.target.value === "" ? undefined : event.target.value.split("\n"))}
                    />
                  ) : (
                    <input
                      aria-label={label}
                      type={field.type === "number" ? "number" : "text"}
                      step={field.type === "number" ? "any" : undefined}
                      required={field.required}
                      maxLength={4096}
                      value={value === undefined ? "" : String(value)}
                      onChange={(event) =>
                        setting(
                          key,
                          event.target.value === "" ? undefined : field.type === "number" ? Number(event.target.value) : event.target.value,
                        )
                      }
                    />
                  )}
                  <span className="muted">
                    {field.description}
                    {field.type === "strings" ? ` ${t("settings.instances.perLine")}` : ""}
                    {field.choices === undefined ? "" : ` ${t("settings.instances.choices", { choices: field.choices.join(", ") })}`}
                  </span>
                </label>
              );
            })}
            {(declaration?.credentials ?? []).map((key) => (
              <label key={key}>
                {t("settings.instances.credential", { key })}
                <input
                  aria-label={t("settings.instances.credentialLabel", { number, key })}
                  required
                  maxLength={128}
                  value={instance.credentials[key] ?? ""}
                  onChange={(event) => update(index, { credentials: { ...instance.credentials, [key]: event.target.value } })}
                />
              </label>
            ))}
            {(declaration?.credentials.length ?? 0) > 0 ? <p>{t("settings.instances.secrets")}</p> : null}
            <Button onClick={() => onChange(instances.filter((_item, at) => at !== index))}>
              {t("settings.instances.remove", { number })}
            </Button>
          </fieldset>
        );
      })}
      <Button
        disabled={instances.length >= 32 || declarations.length === 0}
        onClick={() => {
          const first = declarations[0];
          if (first !== undefined)
            onChange([...instances, { id: "", factory: first.id, workspaceId: "default", accountId: "", settings: {}, credentials: {} }]);
        }}
      >
        {t("settings.instances.add")}
      </Button>
    </section>
  );
}
