import { z } from "zod";

import {
  DEFAULT_EXTERNAL_OUTPUT_SOURCE,
  DEFAULT_EXTERNAL_TOOL_SINK,
  MODEL_TOOL_NAME_PATTERN,
  TaviError,
  ToolDefinitionSchema,
  providerToolName,
  type RegisteredTool,
  type ToolDefinition,
  type ToolHandler,
  type ToolJsonSchema,
  type ToolOfferContext,
  type ToolRegistryPort,
  type ToolSink,
  type CallAssessment,
  type SourceCheck,
  type SourceCheckContext,
  type DeclaredToolDefinition,
  type InvocationContext,
  type ProviderBindingReference,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

/**
 * A tool from an external plugin or an MCP server, registered
 * through `registerExternal`/`registerExternalBatch` only: it may omit `sink`,
 * and then takes `DEFAULT_EXTERNAL_TOOL_SINK`.
 */
export interface ExternalToolRegistration extends ToolDefinition {
  readonly handler: ToolHandler;
  /** Canonical Zod argument schema: the validator every call is parsed with. */
  readonly inputSchema: z.ZodType;
  /**
   * The model-facing JSON Schema, given outright for a schema Zod cannot
   * represent (an MCP server's `not`, `if`/`then`/`else`, `uniqueItems`).
   * The registry then derives nothing from
   * `inputSchema` and checks only that this one is a JSON object with an
   * object root; `inputSchema` stays the validator (an AJV check wrapped in
   * Zod, so calls get field-level errors). Absent: derived from `inputSchema`.
   */
  readonly inputJsonSchema?: ToolJsonSchema;
  /** Whether to offer the tool to a model in a scope; absent means always (see the port). */
  readonly offered?: (context: ToolOfferContext) => boolean | Promise<boolean>;
  /** The tool's reading of one validated call, for the approval gate, with the call's context. */
  readonly assess?: (input: unknown, context: InvocationContext) => CallAssessment;
  /** See `ToolRegistryPort.register`'s `checkSources`. */
  readonly checkSources?: (input: unknown, context: InvocationContext, sources: SourceCheckContext) => Promise<SourceCheck>;
  readonly resolveBinding?: (input: unknown, context: InvocationContext) => Promise<ProviderBindingReference>;
  /** See `RegisteredTool.holdsCall`. */
  readonly holdsCall?: (taskId: string, callId: string) => boolean;
}

/** A built-in tool: it states its sink, and `urlOnly` with a `network` one. */
export interface ToolRegistration extends ExternalToolRegistration {
  readonly sink: ToolSink;
}

/** `definition` and its lists frozen: `list()` hands the same objects to every caller. */
function frozenDefinition(definition: DeclaredToolDefinition): DeclaredToolDefinition {
  Object.freeze(definition.requiredPermissions);
  if (definition.proves !== undefined) Object.freeze(definition.proves);
  return Object.freeze(definition);
}

/**
 * Two ids in code-unit order: the same on every host, unlike `localeCompare`,
 * whose order follows the host's ICU locale. The offered tools lead every
 * model request's cached prefix, so their order must not move.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Tool registry.
 *
 * Registration is explicit and in-process: no import-time side effects and no
 * silent overwrite of an existing id. The canonical Zod argument schema stays
 * on the registration so the model adapter can derive the model-facing JSON
 * Schema from the same source that validates the call locally.
 */
export class ToolRegistry implements ToolRegistryPort {
  readonly #tools = new Map<string, RegisteredTool>();
  /** Per-scope offer predicates, for the tools that declared one. */
  readonly #offered = new Map<string, (context: ToolOfferContext) => boolean | Promise<boolean>>();
  /** Wire name to canonical id; a collision is rejected, never resolved. */
  readonly #byModelName = new Map<string, string>();
  /**
   * `list()`'s answer, kept until a tool is added or removed: the same frozen array every time, so a
   * listing per model step sorts nothing, and a caller can tell an unchanged registry by identity.
   */
  #listed: readonly DeclaredToolDefinition[] | undefined;

  /** Validate the entire batch before publishing it; return its owned withdrawal. */
  registerBatch(registrations: readonly ToolRegistration[]): () => void {
    const staged = new ToolRegistry();
    for (const registration of registrations) staged.register(registration);
    return this.#publish(staged);
  }

  /**
   * Every tool registered on `staged`, published here as one batch, as `registerBatch` would: what composes its
   * tools before it knows whether they are wanted (a built-in that may be disabled) stages them, then adopts them.
   * `offered`, when given, gates every one of them too (the browser's tools while no browser is installed), on top
   * of a tool's own.
   */
  adopt(staged: ToolRegistry, offered?: (context: ToolOfferContext) => boolean | Promise<boolean>): () => void {
    if (offered !== undefined) {
      for (const id of staged.#tools.keys()) {
        const own = staged.#offered.get(id);
        // The gate alone where a tool has none of its own, so one listing runs it once for all of them.
        staged.#offered.set(id, own === undefined ? offered : async (context) => (await offered(context)) && (await own(context)));
      }
    }
    return this.#publish(staged);
  }

  /** `registerBatch` for external plugin and MCP tools: a tool that states no sink takes the default. */
  registerExternalBatch(registrations: readonly ExternalToolRegistration[]): () => void {
    const staged = new ToolRegistry();
    for (const registration of registrations) staged.registerExternal(registration);
    return this.#publish(staged);
  }

  #publish(staged: ToolRegistry): () => void {
    for (const tool of staged.#tools.values()) {
      const claimedBy = this.#byModelName.get(tool.modelName);
      if (this.#tools.has(tool.id) || claimedBy !== undefined) {
        throw new TaviError("DUPLICATE", `Tool ${tool.id} collides with an existing tool's model-facing name ${tool.modelName}`);
      }
    }
    for (const [id, tool] of staged.#tools) this.#tools.set(id, tool);
    for (const [id, offered] of staged.#offered) this.#offered.set(id, offered);
    for (const [name, id] of staged.#byModelName) this.#byModelName.set(name, id);
    this.#listed = undefined;
    return () => {
      for (const [id, tool] of staged.#tools) {
        if (this.#tools.get(id) !== tool) continue;
        this.#tools.delete(id);
        this.#offered.delete(id);
        this.#byModelName.delete(tool.modelName);
        this.#listed = undefined;
      }
    };
  }

  register(registration: ToolRegistration): void {
    this.#register(registration, "built-in");
  }

  /** `register` for one external plugin or MCP tool. */
  registerExternal(registration: ExternalToolRegistration): void {
    this.#register(registration, "external");
  }

  #register(registration: ExternalToolRegistration, origin: "built-in" | "external"): void {
    const parsed = ToolDefinitionSchema.safeParse({
      id: registration.id,
      version: registration.version,
      description: registration.description,
      effect: registration.effect,
      requiredPermissions: registration.requiredPermissions,
      // Carried through, not dropped: the workflow reads `sensitivity` to tag
      // folded summaries and `untrustedOutput` to taint the conversation.
      ...definedOnly({
        sensitivity: registration.sensitivity,
        requiresSandbox: registration.requiresSandbox,
        timeoutMs: registration.timeoutMs,
        untrustedOutput: registration.untrustedOutput,
        outputSource: registration.outputSource,
        outputConfidentiality: registration.outputConfidentiality,
        labelledByStore: registration.labelledByStore,
        sink: registration.sink,
        urlOnly: registration.urlOnly,
        deferred: registration.deferred,
        annotations: registration.annotations,
        outputPrincipal: registration.outputPrincipal,
        // What Ideas may offer while it is registered: a built-in's own, or a plugin's from its approved manifest.
        proves: registration.proves,
        // A built-in's line for the system prompt; a plugin's tool never reaches the system prompt.
        promptGuidance: origin === "built-in" ? registration.promptGuidance : undefined,
      }),
    });
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", `Invalid tool definition ${registration.id}`, {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    // Every built-in states its sink; only an external tool takes the default.
    if (parsed.data.sink === undefined && origin === "built-in") {
      throw new TaviError("INVALID_INPUT", `Built-in tool ${registration.id} declares no sink`);
    }
    if (parsed.data.sink === undefined && parsed.data.urlOnly !== undefined) {
      throw new TaviError("INVALID_INPUT", `Tool ${registration.id} declares urlOnly without a sink`);
    }
    if (parsed.data.sink === "network" && parsed.data.urlOnly === undefined) {
      throw new TaviError("INVALID_INPUT", `Tool ${registration.id} declares a network sink without urlOnly`);
    }
    if (parsed.data.urlOnly !== undefined && parsed.data.sink !== "network") {
      throw new TaviError(
        "INVALID_INPUT",
        `Tool ${registration.id} declares urlOnly on a ${parsed.data.sink} sink; urlOnly is for network only`,
      );
    }
    const sink = parsed.data.sink ?? DEFAULT_EXTERNAL_TOOL_SINK.sink;
    // An external plugin's or MCP tool's output is a plugin's unless it says otherwise.
    const outputSource = parsed.data.outputSource ?? (origin === "external" ? DEFAULT_EXTERNAL_OUTPUT_SOURCE : undefined);
    const urlOnly = parsed.data.sink === undefined ? DEFAULT_EXTERNAL_TOOL_SINK.urlOnly : parsed.data.urlOnly;
    if (typeof registration.handler !== "function") {
      throw new TaviError("INVALID_INPUT", `Tool ${registration.id} has no execution handler`);
    }
    const validator = registration.inputSchema as unknown;
    if (validator === null || typeof validator !== "object")
      throw new TaviError("INVALID_INPUT", `Tool ${registration.id} argument schema is not a schema object`);
    if (typeof (validator as { safeParse?: unknown }).safeParse !== "function")
      throw new TaviError("INVALID_INPUT", `Tool ${registration.id} argument schema is not a Zod schema`);
    const inputJsonSchema =
      registration.inputJsonSchema === undefined
        ? this.#modelFacingSchema(registration.id, registration.inputSchema)
        : givenJsonSchema(registration.id, registration.inputJsonSchema);
    if (this.#tools.has(registration.id)) {
      throw new TaviError("DUPLICATE", `Tool ${registration.id} is already registered`);
    }

    const modelName = providerToolName(registration.id);
    if (!MODEL_TOOL_NAME_PATTERN.test(modelName)) {
      throw new TaviError(
        "UNSUPPORTED",
        `Tool ${registration.id} has no provider-safe function name; ` + `"${modelName}" does not match ${MODEL_TOOL_NAME_PATTERN.source}`,
      );
    }
    const claimedBy = this.#byModelName.get(modelName);
    if (claimedBy !== undefined) {
      throw new TaviError(
        "DUPLICATE",
        `Tools ${claimedBy} and ${registration.id} both map to the provider function name "${modelName}"; ` + "rename one of them",
      );
    }
    this.#tools.set(registration.id, {
      id: parsed.data.id,
      version: parsed.data.version,
      description: parsed.data.description,
      effect: parsed.data.effect,
      requiredPermissions: [...parsed.data.requiredPermissions],
      ...definedOnly({
        sensitivity: parsed.data.sensitivity,
        requiresSandbox: parsed.data.requiresSandbox,
        timeoutMs: parsed.data.timeoutMs,
        untrustedOutput: parsed.data.untrustedOutput,
        outputSource,
        outputConfidentiality: parsed.data.outputConfidentiality,
        labelledByStore: parsed.data.labelledByStore,
      }),
      ...(origin === "built-in" ? { builtIn: true as const } : {}),
      sink,
      ...definedOnly({
        urlOnly,
        deferred: parsed.data.deferred,
        annotations: parsed.data.annotations,
        outputPrincipal: parsed.data.outputPrincipal,
        promptGuidance: parsed.data.promptGuidance,
        proves: parsed.data.proves,
        assess: registration.assess,
        checkSources: registration.checkSources,
        resolveBinding: registration.resolveBinding,
      }),
      ...("holdsCall" in registration && registration.holdsCall !== undefined ? { holdsCall: registration.holdsCall } : {}),
      handler: registration.handler,
      inputSchema: registration.inputSchema,
      inputJsonSchema,
      modelName,
    });
    this.#byModelName.set(modelName, registration.id);
    if (registration.offered !== undefined) this.#offered.set(registration.id, registration.offered);
    this.#listed = undefined;
  }

  get(id: string): RegisteredTool | undefined {
    return this.#tools.get(id);
  }

  /**
   * The tools offered in `context`, in `list()` order. The predicates run together, and one shared by
   * several tools (a plugin's "is anything configured" check) runs once for the listing.
   */
  async listOffered(context: ToolOfferContext): Promise<readonly DeclaredToolDefinition[]> {
    const tools = this.list();
    const verdicts = new Map<(context: ToolOfferContext) => boolean | Promise<boolean>, Promise<boolean>>();
    const verdictOf = (offered: (context: ToolOfferContext) => boolean | Promise<boolean>): Promise<boolean> => {
      let verdict = verdicts.get(offered);
      if (verdict === undefined) {
        // A failed visibility check hides only the tools it decides.
        verdict = (async () => await offered(context))().catch(() => false);
        verdicts.set(offered, verdict);
      }
      return verdict;
    };
    const shown = await Promise.all(
      tools.map((tool) => {
        const offered = this.#offered.get(tool.id);
        return offered === undefined ? true : verdictOf(offered);
      }),
    );
    return tools.filter((_tool, index) => shown[index] === true);
  }

  list(): readonly DeclaredToolDefinition[] {
    this.#listed ??= Object.freeze(this.#listing().map(frozenDefinition));
    return this.#listed;
  }

  #listing(): DeclaredToolDefinition[] {
    return [...this.#tools.values()]
      .map(
        ({
          id,
          version,
          description,
          effect,
          requiredPermissions,
          sensitivity,
          requiresSandbox,
          untrustedOutput,
          outputSource,
          outputConfidentiality,
          sink,
          urlOnly,
          deferred,
          outputPrincipal,
          promptGuidance,
          proves,
        }) => ({
          id,
          version,
          description,
          effect,
          requiredPermissions: [...requiredPermissions],
          ...definedOnly({
            sensitivity,
            requiresSandbox,
            untrustedOutput,
            outputSource,
            outputConfidentiality,
          }),
          sink,
          ...definedOnly({
            urlOnly,
            deferred,
            outputPrincipal,
            promptGuidance,
            proves: proves === undefined ? undefined : [...proves],
          }),
        }),
      )
      .sort((left, right) => compareCodeUnits(left.id, right.id));
  }

  /** Canonical Zod schema for a tool, used to validate a completed call locally. */
  inputSchemaOf(id: string): z.ZodType | undefined {
    return this.#tools.get(id)?.inputSchema;
  }

  /** Model-facing JSON Schema, derived once at registration. */
  inputJsonSchemaOf(id: string): ToolJsonSchema | undefined {
    return this.#tools.get(id)?.inputJsonSchema;
  }

  /** Provider-safe function name for a canonical tool id. */
  modelNameOf(id: string): string | undefined {
    return this.#tools.get(id)?.modelName;
  }

  /** Canonical id for a provider-safe function name returned by a model. */
  resolveModelName(modelName: string): string | undefined {
    return this.#byModelName.get(modelName);
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  /**
   * Derive the model-facing JSON Schema from the canonical Zod schema.
   *
   * This is the representability gate: shapes the
   * model-facing schema cannot express faithfully are rejected at registration
   * rather than silently stripped. Two independent checks run, because neither
   * is sufficient alone: Zod's own converter rejects unknown types, while
   * `findUnrepresentable` catches refinements and transforms, which the
   * converter *silently drops*.
   */
  #modelFacingSchema(id: string, schema: unknown): ToolJsonSchema {
    if (schema === null || typeof schema !== "object") {
      throw new TaviError("INVALID_INPUT", `Tool ${id} argument schema is not a schema object`);
    }
    if (typeof (schema as { safeParse?: unknown }).safeParse !== "function") {
      throw new TaviError("INVALID_INPUT", `Tool ${id} argument schema is not a Zod schema`);
    }

    const unrepresentable = findUnrepresentable(schema, "$");
    if (unrepresentable !== undefined) {
      throw new TaviError(
        "UNSUPPORTED",
        `Tool ${id} argument schema uses a ${unrepresentable.kind} at ${unrepresentable.path}, ` +
          "which has no faithful model-facing JSON Schema",
      );
    }

    let converted: Record<string, unknown>;
    try {
      converted = z.toJSONSchema(schema as z.ZodType, {
        io: "input",
        target: "draft-7",
        unrepresentable: "throw",
      }) as Record<string, unknown>;
    } catch (error) {
      throw new TaviError("UNSUPPORTED", `Tool ${id} argument schema has no faithful model-facing JSON Schema: ${errorMessage(error)}`);
    }
    return constAsEnum(objectRoot(id, converted)) as ToolJsonSchema;
  }
}

/** The keywords whose value maps names to schemas, not a schema itself. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);

/**
 * `schema` with every `const` written as a one-value `enum`: Gemini's function
 * schema has no `const` and providers drop it there, so a nested union's
 * discriminator (pdf.fill's source `kind`) reached the model as a bare string.
 * An enum says the same thing everywhere.
 */
function constAsEnum(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(constAsEnum);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "const") continue;
    // Values, not schemas: an enum's or a default's members are kept as they are.
    if (key === "enum" || key === "default" || key === "examples") out[key] = value;
    // A map of names to schemas: a field may be named `const` itself.
    else if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value))
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, constAsEnum(child)]));
    else out[key] = constAsEnum(value);
  }
  if ("const" in (schema as Record<string, unknown>) && !("enum" in out)) out["enum"] = [(schema as Record<string, unknown>)["const"]];
  return out;
}

/**
 * A given model-facing schema: plain JSON data with an object root, copied so
 * no caller can change it later. A union of objects at its root (a worker's
 * discriminated union) is sent as one object, as a built-in's is.
 */
function givenJsonSchema(id: string, schema: ToolJsonSchema): ToolJsonSchema {
  let copied: unknown;
  try {
    copied = JSON.parse(JSON.stringify(schema)) as unknown;
  } catch {
    throw new TaviError("INVALID_INPUT", `Tool ${id} JSON Schema is not plain JSON`);
  }
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    throw new TaviError(
      "UNSUPPORTED",
      `Tool ${id} JSON Schema has no object at its root, which providers require of a function's parameters`,
    );
  }
  return constAsEnum(objectRoot(id, copied as Record<string, unknown>)) as ToolJsonSchema;
}

/**
 * A tool's model-facing schema with an object at its root, as every provider
 * requires of a function's parameters (OpenAI refuses any other root: "schema
 * must be a JSON Schema of 'type: "object"'"). A union of objects — a
 * discriminated union's `anyOf` — is sent as one object: each field any
 * branch has, those every branch requires still required, a discriminator's
 * values as an enum, and each branch's own required fields said in the
 * description. The handler still parses the exact union, so a combination no
 * branch allows is refused there, in words the model reads. Any other root is
 * refused at registration, not by a provider mid-run.
 */
function objectRoot(id: string, converted: Record<string, unknown>): Record<string, unknown> {
  if (converted["type"] === "object") return converted;
  const branches = converted["anyOf"] ?? converted["oneOf"];
  const objects = Array.isArray(branches) ? (branches as Record<string, unknown>[]) : [];
  const isObject = (branch: Record<string, unknown>): boolean =>
    branch !== null && typeof branch === "object" && branch["type"] === "object" && typeof branch["properties"] === "object";
  const [first] = objects;
  if (first === undefined || !objects.every(isObject)) {
    throw new TaviError(
      "UNSUPPORTED",
      `Tool ${id} argument schema has no object at its root, which providers require of a function's parameters; ` +
        "use an object, or a union of objects",
    );
  }
  const propertiesOf = (branch: Record<string, unknown>) => branch["properties"] as Record<string, Record<string, unknown>>;
  const requiredOf = (branch: Record<string, unknown>) => new Set((branch["required"] as string[] | undefined) ?? []);
  // A discriminator: a field every branch requires with a constant value.
  const discriminator = Object.keys(propertiesOf(first)).find((name) =>
    objects.every((branch) => requiredOf(branch).has(name) && propertiesOf(branch)[name]?.["const"] !== undefined),
  );
  const properties: Record<string, Record<string, unknown>> = {};
  for (const branch of objects) {
    for (const [name, property] of Object.entries(propertiesOf(branch))) {
      const known = properties[name];
      if (known === undefined) {
        properties[name] = { ...property };
      } else if (name === discriminator) {
        const values = [...((known["enum"] as unknown[] | undefined) ?? [known["const"]]), property["const"]];
        const { const: _const, ...rest } = known;
        properties[name] = { ...rest, enum: values };
      } else if (JSON.stringify({ ...known, description: undefined }) !== JSON.stringify({ ...property, description: undefined })) {
        // The same name, shaped differently: either shape.
        const shapes = (known["anyOf"] as Record<string, unknown>[] | undefined) ?? [known];
        properties[name] = {
          anyOf: [...shapes, property],
          ...(known["description"] === undefined ? {} : { description: known["description"] }),
        };
      }
    }
  }
  // Every branch has the discriminator, so the merge above made it an enum.
  const merged = discriminator === undefined ? undefined : properties[discriminator];
  if (discriminator !== undefined && merged !== undefined) {
    // Each branch's own label, by its place: a branch with none leaves a gap rather than taking the next one's.
    const labels = objects.map((branch) => {
      const label = propertiesOf(branch)[discriminator]?.["description"];
      return typeof label === "string" ? label : undefined;
    });
    const values = merged["enum"] as unknown[];
    merged["description"] = values
      .map((value, index) => `${JSON.stringify(value)}${labels[index] === undefined ? "" : `: ${labels[index]}`}`)
      .join("; ");
  }
  const everywhere = [...requiredOf(first)].filter((name) => objects.every((branch) => requiredOf(branch).has(name)));
  const shared = new Set(everywhere);
  const contract = objects
    .map((branch) => {
      const own = [...requiredOf(branch)].filter((name) => !shared.has(name));
      const label =
        discriminator === undefined ? "one form" : `${discriminator} ${JSON.stringify(propertiesOf(branch)[discriminator]?.["const"])}`;
      // The fields another form has and this one does not: sent with this form, they are refused.
      const foreign = Object.keys(properties).filter((name) => !(name in propertiesOf(branch)));
      return `${label} requires ${own.length === 0 ? "nothing more" : own.join(", ")}${foreign.length === 0 ? "" : ` and takes none of ${foreign.join(", ")}`}`;
    })
    .join("; ");
  const description = [converted["description"], `Exactly one form: ${contract}.`].filter((part) => typeof part === "string").join(" ");
  const closed = objects.every((branch) => branch["additionalProperties"] === false);
  return {
    ...(converted["$schema"] === undefined ? {} : { $schema: converted["$schema"] }),
    type: "object",
    description,
    properties,
    required: everywhere,
    ...(closed ? { additionalProperties: false } : {}),
  };
}

/**
 * Walk a Zod schema and report the first construct that cannot be expressed as
 * a model-facing JSON Schema.
 *
 * Zod's `toJSONSchema` ignores `.refine()`/`.transform()` rather than failing,
 * so a tool could otherwise advertise constraints to itself that the model never
 * sees. Walking `_zod.def` is a Zod-specific detail; if the schema shape is
 * unrecognized the walk simply finds nothing and the converter remains the
 * backstop.
 */
export function findUnrepresentable(
  schema: unknown,
  path: string,
  depth = 0,
): { readonly kind: string; readonly path: string } | undefined {
  if (depth > 16 || schema === null || typeof schema !== "object") return undefined;
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (def === undefined) return undefined;

  const type = def["type"];
  if (type === "pipe") {
    return { kind: "transform or pipe", path };
  }
  if (Array.isArray(def["checks"])) {
    for (const check of def["checks"] as { type?: unknown }[]) {
      if (check?.type === "custom") return { kind: "custom refinement", path };
    }
  }

  const nested: [string, unknown][] = [];
  const shape = def["shape"];
  if (shape !== null && typeof shape === "object") {
    for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
      nested.push([`${path}.${key}`, value]);
    }
  }
  for (const key of ["element", "valueType", "keyType", "innerType", "out", "in", "wrapped", "rest"]) {
    if (def[key] !== undefined && typeof def[key] === "object" && def[key] !== null) {
      nested.push([`${path}.${key}`, def[key]]);
    }
  }
  // `z.lazy()` hides its schema behind a getter; resolving it is safe under the
  // depth guard and is the only way a refinement behind `lazy` is detected.
  const getter = def["getter"];
  if (typeof getter === "function") {
    try {
      const resolved: unknown = (getter as () => unknown)();
      if (typeof resolved === "object" && resolved !== null) nested.push([`${path}.getter`, resolved]);
    } catch {
      // A recursive lazy schema can throw while resolving; the depth guard and
      // the converter's own rejection remain the backstop.
    }
  }
  const options = def["options"];
  if (Array.isArray(options)) {
    options.forEach((option, index) => nested.push([`${path}[${index}]`, option]));
  }
  const items = def["items"];
  if (Array.isArray(items)) {
    items.forEach((item, index) => nested.push([`${path}[${index}]`, item]));
  }

  for (const [childPath, child] of nested) {
    const found = findUnrepresentable(child, childPath, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
