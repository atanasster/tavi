import { TaviError, type ToolJsonSchema } from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";
import { findUnrepresentable } from "@tavi/runtime";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

/**
 * An MCP tool's `inputSchema` as a Tavi registration. Two forms:
 *
 * - **Zod**, when `z.fromJSONSchema` reads it and the result is one the
 *   registry can turn back into a faithful model-facing schema.
 * - **JSON Schema**, otherwise (`not`, `if`/`then`/`else`, `uniqueItems`,
 *   which Zod 4.6.5 cannot represent or holds as a refinement): the server's
 *   schema is given to the registry as `inputJsonSchema`, and the validator is
 *   `z.unknown().check(…)` running AJV, each AJV error reported as a Zod issue
 *   at its path, so the workflow's `z.safeParse` keeps working and the model
 *   gets field-level errors.
 *
 * A root that is not an object is wrapped as `{ input }`; the call unwraps
 * it. A schema AJV cannot compile is refused, naming why. Only
 * `apps/cli/src/features/mcp/` imports AJV.
 */

export interface McpInputForm {
  readonly form: "zod" | "json";
  /** The validator every call is parsed with. */
  readonly inputSchema: z.ZodType;
  /** The model-facing schema when the form is `json`; the registry derives it otherwise. */
  readonly inputJsonSchema?: ToolJsonSchema;
  /** The root was not an object: the model sends `{ input }`, and the call sends `input`. */
  readonly wrapped: boolean;
}

/**
 * Keywords each configured provider refuses in a tool's parameters, by
 * provider id. Every connection Tavi supports goes through the
 * OpenAI-compatible chat path with strict mode off (`buildSdkTools` in
 * `packages/agent-host/src/models/models.ts`), where no provider documents a keyword it
 * refuses; Gemini documents only that "a subset of the OpenAPI schema is
 * supported". So the list is empty until a refusal is observed, and grows by
 * observation.
 */
const PROVIDER_REFUSED_SCHEMA_KEYWORDS: Readonly<Record<string, readonly string[]>> = {};

const options = { allErrors: true, strict: false, validateFormats: false, validateSchema: true } as const;

/**
 * A compiler for one schema, of its dialect: MCP's default is draft 2020-12
 * (2025-11-25 spec); 2019-09 and draft-07 when named; draft-04 and draft-06
 * as draft-07 (their differences are in keywords Tavi does not rely on) with
 * `$schema` dropped; an unknown `$schema` as 2020-12, dropped. A new instance
 * per schema: a shared one would refuse a second compile of the same `$id`
 * and keep every compiled schema for the owner's lifetime.
 */
function compiled(schema: Record<string, unknown>): ValidateFunction {
  const dialect = typeof schema["$schema"] === "string" ? schema["$schema"] : "";
  const { $schema: _named, ...unnamed } = schema;
  if (dialect.includes("2020-12")) return new Ajv2020(options).compile(schema);
  if (dialect.includes("2019-09")) return new Ajv2019(options).compile(schema);
  if (dialect.includes("draft-07")) return new Ajv(options).compile(schema);
  if (/draft-0[46]/.test(dialect)) return new Ajv(options).compile(unnamed);
  return new Ajv2020(options).compile(dialect === "" ? schema : unnamed);
}

/** Every keyword a schema uses, at any depth (keys of schema objects, never of `properties`' or `$defs`' names). */
export function schemaKeywords(schema: unknown, found = new Set<string>(), depth = 0): ReadonlySet<string> {
  if (depth > 64 || schema === null || typeof schema !== "object") return found;
  if (Array.isArray(schema)) {
    for (const item of schema) schemaKeywords(item, found, depth + 1);
    return found;
  }
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    found.add(key);
    if (
      (key === "properties" || key === "$defs" || key === "definitions" || key === "patternProperties" || key === "dependentSchemas") &&
      value !== null &&
      typeof value === "object"
    ) {
      for (const child of Object.values(value as Record<string, unknown>)) schemaKeywords(child, found, depth + 1);
    } else if (key !== "enum" && key !== "const" && key !== "default" && key !== "examples" && key !== "required")
      schemaKeywords(value, found, depth + 1);
  }
  return found;
}

/** The keywords of `schema` that one of `providers` refuses, by provider. */
function refusedKeywords(
  schema: unknown,
  providers: readonly string[],
): readonly { readonly provider: string; readonly keyword: string }[] {
  const used = schemaKeywords(schema);
  return providers.flatMap((provider) =>
    (PROVIDER_REFUSED_SCHEMA_KEYWORDS[provider] ?? []).filter((keyword) => used.has(keyword)).map((keyword) => ({ provider, keyword })),
  );
}

const isObjectRoot = (schema: Record<string, unknown>): boolean => schema["type"] === "object";

/** AJV's errors as Zod issues, each at its instance path. */
function issuesOf(errors: readonly ErrorObject[] | null | undefined): { readonly path: string[]; readonly message: string }[] {
  return (errors ?? []).slice(0, 20).map((error) => {
    const path = error.instancePath
      .split("/")
      .slice(1)
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    const missing = error.keyword === "required" ? (error.params as { missingProperty?: string }).missingProperty : undefined;
    return {
      path: missing === undefined ? path : [...path, missing],
      message: missing === undefined ? (error.message ?? "is invalid") : "is required",
    };
  });
}

/** A Zod validator that runs a compiled AJV schema, reporting each error at its path. */
function ajvValidator(validate: ValidateFunction): z.ZodType {
  return z.unknown().check((context) => {
    if (validate(context.value)) return;
    for (const issue of issuesOf(validate.errors))
      context.issues.push({ code: "custom", input: context.value, path: issue.path, message: issue.message });
  });
}

/** The registration form of a tool's input schema; refuses one that is not a JSON Schema object or does not compile. */
export function inputFormOf(toolId: string, given: unknown, providers: readonly string[] = []): McpInputForm {
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw new TaviError("INVALID_INPUT", `${toolId}'s input schema is not a JSON Schema object`);
  const refused = refusedKeywords(given, providers);
  if (refused.length > 0)
    throw new TaviError(
      "UNSUPPORTED",
      `${toolId}'s input schema uses ${refused.map(({ keyword, provider }) => `${keyword} (refused by ${provider})`).join(", ")}`,
    );
  const original = given as Record<string, unknown>;
  const wrapped = !isObjectRoot(original);
  const schema: Record<string, unknown> = wrapped
    ? { type: "object", properties: { input: original }, required: ["input"], additionalProperties: false }
    : original;
  let validate: ValidateFunction;
  try {
    validate = compiled(wrapped ? schema : original);
  } catch (error) {
    throw new TaviError("INVALID_INPUT", `${toolId}'s input schema does not compile: ${clip(errorMessage(error), 300)}`);
  }
  try {
    const zod = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType;
    if (findUnrepresentable(zod, "$") === undefined) {
      z.toJSONSchema(zod, { io: "input", target: "draft-7", unrepresentable: "throw" });
      return { form: "zod", inputSchema: zod, wrapped };
    }
  } catch {
    // Not representable in Zod: the JSON Schema form below.
  }
  return { form: "json", inputSchema: ajvValidator(validate), inputJsonSchema: schema as ToolJsonSchema, wrapped };
}

/** An output schema longer than this, serialized, is not checked. */
const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
/** Compiled output checks by their schema's text, so a reconcile compiles only what it has not seen. */
const outputChecks = new Map<string, ValidateFunction | undefined>();
const OUTPUT_CHECKS_KEPT = 256;

/**
 * A check of a result's structured content against the tool's approved
 * output schema: what does not match, by path, or undefined when it
 * matches. A schema that does not compile, or one over 64 KB, checks nothing.
 */
export function outputCheckOf(outputSchema: unknown): ((value: unknown) => string | undefined) | undefined {
  if (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema)) return undefined;
  const text = JSON.stringify(outputSchema);
  if (Buffer.byteLength(text) > MAX_OUTPUT_SCHEMA_BYTES) return undefined;
  let validate = outputChecks.get(text);
  if (!outputChecks.has(text)) {
    try {
      validate = compiled(outputSchema as Record<string, unknown>);
    } catch {
      validate = undefined;
    }
    if (outputChecks.size >= OUTPUT_CHECKS_KEPT) outputChecks.delete(outputChecks.keys().next().value as string);
    outputChecks.set(text, validate);
  }
  if (validate === undefined) return undefined;
  const check = validate;
  return (value) =>
    check(value)
      ? undefined
      : issuesOf(check.errors)
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "result"} ${issue.message}`)
          .join("; ")
          .slice(0, 500);
}

/** A call's arguments as the server receives them: for a wrapped root, the `input` the model sent, unwrapped. */
export function serverArguments(form: Pick<McpInputForm, "wrapped">, args: unknown): unknown {
  if (form.wrapped) return (args as { input?: unknown } | null)?.input;
  return args ?? {};
}
