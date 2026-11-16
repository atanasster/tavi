import { z } from "zod";
import { ModelConnectionSchema } from "./models-config.js";
import { SECRET_KEY_REF_PATTERN } from "./ids.js";

export const PROVIDER_ABI = "tavi.providers/1";
const name = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .max(64);
const fieldName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .max(64);
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
export const ProviderSettingsValueSchema = z.union([scalar, z.array(scalar).max(64)]);
export const ProviderSettingsSchema = z
  .record(fieldName, ProviderSettingsValueSchema)
  .refine((value) => Object.keys(value).length <= 32, "too many settings");
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

/** Deliberately declarative: offline review never imports a schema function. */
export const ProviderSettingFieldSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "strings"]),
  required: z.boolean().default(false),
  description: z.string().max(500),
  choices: z.array(scalar).min(1).max(64).optional(),
});
export const ProviderDeclarationSchema = z.strictObject({
  id: name,
  kind: z.enum(["search", "fetch", "model"]),
  settings: z.record(fieldName, ProviderSettingFieldSchema).refine((value) => Object.keys(value).length <= 32, "too many setting fields"),
  credentials: z
    .array(fieldName)
    .max(16)
    .refine((value) => new Set(value).size === value.length, "duplicate credential names"),
  disclosure: z.string().min(1).max(2000),
});
export type ProviderDeclaration = z.infer<typeof ProviderDeclarationSchema>;

export const ProviderInstanceConfigSchema = z.strictObject({
  id: name,
  factory: name,
  workspaceId: z.string().min(1).max(128),
  accountId: name,
  settings: ProviderSettingsSchema,
  credentials: z.record(fieldName, z.string().max(128).regex(SECRET_KEY_REF_PATTERN)),
});
export const ProviderInstancesSchema = z
  .array(ProviderInstanceConfigSchema)
  .max(32)
  .refine((instances) => new Set(instances.map((instance) => instance.id)).size === instances.length, "duplicate instance IDs");
export type ProviderInstanceConfig = z.infer<typeof ProviderInstanceConfigSchema>;

export const PluginProvenanceSchema = z.strictObject({
  /**
   * `bundled-esm`: prepared ES modules; dependencies must be inside the
   * approved artifact. `mcp-*`: an MCP server's files, never imported by the
   * owner.
   */
  format: z.enum(["bundled-esm", "mcp-remote", "mcp-npm", "mcp-pypi", "mcp-dir", "mcp-command", "mcp-mcpb"]),
  packages: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(214)
          .regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/),
        version: z
          .string()
          .min(1)
          .max(64)
          .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
        integrity: z
          .string()
          .regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
          .max(128),
        license: z.string().min(1).max(128),
      }),
    )
    .max(256),
});

export function providerInstanceProblems(
  declarations: readonly ProviderDeclaration[],
  instances: readonly ProviderInstanceConfig[],
  pluginId: string,
): string[] {
  const problems: string[] = [];
  for (const instance of instances) {
    const declaration = declarations.find((candidate) => candidate.id === instance.factory);
    if (declaration === undefined) {
      problems.push(`${instance.id}: unknown factory ${instance.factory}`);
      continue;
    }
    if (declaration.kind === "model" && !ModelConnectionSchema.shape.connectionId.safeParse(`${pluginId}.${instance.id}`).success)
      problems.push(
        `${instance.id}: combined model connection ID must be a lowercase slug of at most 64 characters without repeated or trailing separators`,
      );
    for (const [key, value] of Object.entries(instance.settings)) {
      const field = declaration.settings[key];
      if (field === undefined) {
        problems.push(`${instance.id}: unknown setting ${key}`);
        continue;
      }
      const valid =
        field.type === "strings" ? Array.isArray(value) && value.every((item) => typeof item === "string") : typeof value === field.type;
      if (
        !valid ||
        (field.choices !== undefined &&
          (Array.isArray(value) ? value.some((item) => !field.choices?.includes(item)) : !field.choices.includes(value)))
      )
        problems.push(`${instance.id}: invalid setting ${key}`);
    }
    for (const [key, field] of Object.entries(declaration.settings)) {
      if (field.required && instance.settings[key] === undefined) problems.push(`${instance.id}: ${key} is required`);
    }
    for (const [key, reference] of Object.entries(instance.credentials)) {
      if (!declaration.credentials.includes(key) || !reference.startsWith(`plugins.${pluginId}.${instance.id}.`))
        problems.push(`${instance.id}: credential ${key} must use its instance namespace`);
    }
    for (const key of declaration.credentials) {
      if (instance.credentials[key] === undefined) problems.push(`${instance.id}: credential ${key} is required`);
    }
  }
  return problems;
}
