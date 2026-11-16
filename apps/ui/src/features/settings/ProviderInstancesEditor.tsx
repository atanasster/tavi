import type { ProviderDeclaration, ProviderInstanceConfig } from "@tavi/contracts";
import { useRowKeys } from "../../hooks/use-row-keys.js";
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
  const { keyOf, carry } = useRowKeys<ProviderInstanceConfig>();
  const update = (index: number, patch: Partial<ProviderInstanceConfig>) =>
    onChange(instances.map((instance, at) => (at === index ? carry(instance, { ...instance, ...patch }) : instance)));
  return (
    <section>
      <h3>Provider instances</h3>
      <p>
        Each instance has its own workspace, account, settings and credential references. Save and restart the owner to activate changes.
      </p>
      {instances.map((instance, index) => {
        const declaration = declarations.find((item) => item.id === instance.factory);
        const setting = (key: string, value: ProviderInstanceConfig["settings"][string] | undefined) => {
          const settings = { ...instance.settings };
          if (value === undefined) delete settings[key];
          else settings[key] = value;
          update(index, { settings });
        };
        return (
          <fieldset key={keyOf(instance)} className="settings-fields">
            <legend>Instance {index + 1}</legend>
            <label>
              Instance ID
              <input
                aria-label={`Instance ${index + 1} ID`}
                required
                maxLength={64}
                value={instance.id}
                onChange={(event) => update(index, { id: event.target.value })}
              />
            </label>
            <label>
              Factory
              <Select
                aria-label={`Instance ${index + 1} factory`}
                value={instance.factory}
                onChange={(event) => update(index, { factory: event.target.value, settings: {}, credentials: {} })}
              >
                {declaration === undefined ? <option value={instance.factory}>{instance.factory} (unavailable)</option> : null}
                {declarations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} ({item.kind})
                  </option>
                ))}
              </Select>
            </label>
            <p>{declaration?.disclosure}</p>
            <label>
              Workspace
              <input
                aria-label={`Instance ${index + 1} workspace`}
                required
                maxLength={128}
                value={instance.workspaceId}
                onChange={(event) => update(index, { workspaceId: event.target.value })}
              />
            </label>
            <label>
              Account ID
              <input
                aria-label={`Instance ${index + 1} account`}
                required
                maxLength={64}
                value={instance.accountId}
                onChange={(event) => update(index, { accountId: event.target.value })}
              />
            </label>
            {Object.entries(declaration?.settings ?? {}).map(([key, field]) => {
              const value = instance.settings[key];
              const label = `Instance ${index + 1} ${key}`;
              return (
                // biome-ignore lint/a11y/noLabelWithoutControl: every branch of the ternary below renders the control (Select, textarea or input)
                <label key={key}>
                  {key}
                  {field.required ? " (required)" : ""}
                  {field.type === "boolean" ? (
                    <Select
                      aria-label={label}
                      value={value === undefined ? "" : String(value)}
                      onChange={(event) => setting(key, event.target.value === "" ? undefined : event.target.value === "true")}
                    >
                      <option value="">Default</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
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
                    {field.type === "strings" ? " Enter one value per line." : ""}
                    {field.choices === undefined ? "" : ` Choices: ${field.choices.join(", ")}.`}
                  </span>
                </label>
              );
            })}
            {(declaration?.credentials ?? []).map((key) => (
              <label key={key}>
                {key} credential reference
                <input
                  aria-label={`Instance ${index + 1} ${key} reference`}
                  required
                  maxLength={128}
                  value={instance.credentials[key] ?? ""}
                  onChange={(event) => update(index, { credentials: { ...instance.credentials, [key]: event.target.value } })}
                />
              </label>
            ))}
            {(declaration?.credentials.length ?? 0) > 0 ? <p>Store secrets in Credentials. Enter only their references here.</p> : null}
            <Button onClick={() => onChange(instances.filter((_item, at) => at !== index))}>Remove instance {index + 1}</Button>
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
        Add provider instance
      </Button>
    </section>
  );
}
