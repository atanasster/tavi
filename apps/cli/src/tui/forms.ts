import {
  CONNECTION_ID_PATTERN,
  MODEL_ROLES,
  redactCredentialShapes,
  SECRET_KEY_REF_PATTERN,
  TaviError,
  type IpcCommand,
} from "@tavi/contracts";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";

import { GLYPHS } from "./theme.js";

/**
 * `tavi chat`'s forms: the configuration writes a chat needs —
 * storing a credential, adding a model connection, choosing the default and a
 * role's target, testing a connection — asked a field at a time in the prompt
 * row, so they fit the bounded live region (stock Ink clears the terminal
 * once a frame reaches the viewport's height). A credential's value is typed
 * masked and goes to the owner once; it is never shown, never in the
 * transcript, and never on the command line.
 *
 * Pure: the chat keeps a form's state in its store and sends what `formRequest`
 * builds.
 */

/** The command that opens each form; words after it fill its fields in order. */
export const FORM_COMMANDS = {
  "credentials-set": "/credentials set",
  "models-add": "/models add",
  "models-set-default": "/models set-default",
  "models-set-role": "/models set-role",
  "models-test": "/models test",
} as const;
export type FormId = keyof typeof FORM_COMMANDS;

export interface FormField {
  readonly key: string;
  /** What the prompt row asks, in the chat's language (`fieldLabel`); a parenthesis at its end is the status row's alone. */
  readonly label: CoreKey;
  /** Enter on nothing leaves it out. */
  readonly optional?: true;
  /** Typed masked, and never taken from the command line. */
  readonly secret?: true;
  readonly choices?: readonly string[];
  /**
   * The shape the owner will accept, checked here first so a refusal never
   * echoes what was typed — a key pasted into the wrong field included.
   */
  readonly shape?: { readonly pattern: RegExp; readonly maxLength: number; readonly describe: CoreKey };
}

/** A credential reference, as `assertSecretKeyRef` accepts it. */
const REFERENCE = {
  pattern: SECRET_KEY_REF_PATTERN,
  maxLength: 128,
  describe: "tui.form.shape.reference",
} as const;
/** A connection id, as `ModelConnectionSchema` accepts it. */
const CONNECTION = {
  pattern: CONNECTION_ID_PATTERN,
  maxLength: 64,
  describe: "tui.form.shape.connection",
} as const;

export interface FormSpec {
  readonly title: CoreKey;
  readonly fields: readonly FormField[];
}

export const FORMS: Readonly<Record<FormId, FormSpec>> = {
  "credentials-set": {
    title: "tui.form.credentialsSet.title",
    fields: [
      { key: "reference", label: "tui.form.field.reference", shape: REFERENCE },
      { key: "value", label: "tui.form.field.value", secret: true },
    ],
  },
  "models-add": {
    title: "tui.form.modelsAdd.title",
    fields: [
      { key: "connectionId", label: "tui.form.field.connectionId", shape: CONNECTION },
      { key: "baseUrl", label: "tui.form.field.baseUrl" },
      { key: "credentialRef", label: "tui.form.field.credentialRef", shape: REFERENCE },
      { key: "model", label: "tui.form.field.defaultModel", optional: true },
    ],
  },
  "models-set-default": {
    title: "tui.form.modelsSetDefault.title",
    fields: [
      { key: "connectionId", label: "tui.form.field.connectionId", shape: CONNECTION },
      { key: "model", label: "tui.form.field.model", optional: true },
    ],
  },
  "models-set-role": {
    title: "tui.form.modelsSetRole.title",
    fields: [
      { key: "role", label: "tui.form.field.role", choices: MODEL_ROLES },
      { key: "connectionId", label: "tui.form.field.connectionId", shape: CONNECTION },
      { key: "model", label: "tui.form.field.model", optional: true },
    ],
  },
  "models-test": {
    title: "tui.form.modelsTest.title",
    fields: [
      { key: "connectionId", label: "tui.form.field.connectionId", shape: CONNECTION },
      { key: "model", label: "tui.form.field.model", optional: true },
    ],
  },
};

/** A form's title in the chat's language. */
export const formTitle = (id: FormId, t: CoreT = coreEnglish): string => t(FORMS[id].title);

/** A field's label in the chat's language. */
export const fieldLabel = (field: FormField, t: CoreT = coreEnglish): string => t(field.label);

/** A field as a refusal names it: its key in English (what a script reads), its short label in another language. */
const fieldName = (field: FormField, t: CoreT): { readonly field: string; readonly label: string } => ({
  field: field.key,
  label: fieldLabel(field, t).replace(/ \(.*\)$/, ""),
});

/** A form being filled: the values so far and the field asked now. */
export interface FormState {
  readonly id: FormId;
  readonly values: Readonly<Record<string, string>>;
  /** The field asked now, an index into the spec's fields. */
  readonly index: number;
}

export type FormStep =
  | { readonly kind: "ask"; readonly state: FormState }
  | { readonly kind: "done"; readonly id: FormId; readonly values: Readonly<Record<string, string>> }
  | { readonly kind: "refused"; readonly reason: string };

/** Why `value` does not fit `field`, if it does not. */
function misfit(field: FormField, value: string, t: CoreT): string | undefined {
  if (field.choices !== undefined && !field.choices.includes(value)) return t("tui.form.oneOf", { choices: field.choices.join(", ") });
  // A key where a name belongs — a reference, a connection id — would be
  // stored and shown as one.
  if (field.secret !== true && looksLikeCredential(value)) return t("tui.form.notCredential");
  if (field.shape !== undefined && (value.length > field.shape.maxLength || !field.shape.pattern.test(value)))
    return t(field.shape.describe);
  return undefined;
}

/** The next field still to ask from `index` on, or the form done. */
function next(id: FormId, values: Readonly<Record<string, string>>, index: number, askOptional: boolean): FormStep {
  for (const [at, field] of FORMS[id].fields.entries()) {
    if (at < index || values[field.key] !== undefined) continue;
    if (field.optional === true && !askOptional) continue;
    return { kind: "ask", state: { id, values, index: at } };
  }
  return { kind: "done", id, values };
}

/**
 * Open form `id` with the words typed after its command filling its fields in
 * order. With none, every field is asked, optional ones included; with some,
 * only the required fields they leave out are. A secret field is never filled
 * from the command line — a value there would sit on screen — so words that
 * would reach one refuse the form.
 */
export function openForm(id: FormId, words: readonly string[], t: CoreT = coreEnglish): FormStep {
  const fields = FORMS[id].fields;
  const fillable = fields.filter((field) => field.secret !== true);
  if (words.length > fillable.length) {
    const secret = fields.some((field) => field.secret === true);
    return {
      kind: "refused",
      reason: t(secret ? "tui.form.tooManySecret" : "tui.form.tooMany", {
        command: FORM_COMMANDS[id],
        count: fillable.length,
        n: String(fillable.length),
      }),
    };
  }
  const values: Record<string, string> = {};
  for (const [index, word] of words.entries()) {
    // Never past the last: more words than fields were refused above.
    const field = fillable[index];
    if (field === undefined) break;
    const wrong = misfit(field, word, t);
    if (wrong !== undefined) return { kind: "refused", reason: t("tui.form.mustBe", { ...fieldName(field, t), wrong }) };
    values[field.key] = word;
  }
  return next(id, values, 0, words.length === 0);
}

/**
 * The field asked now, answered with `typed`: the next step, or why the answer
 * does not do (the same field is asked again). An optional field answered with
 * nothing is left out.
 */
export function enterField(
  state: FormState,
  typed: string,
  t: CoreT = coreEnglish,
): FormStep | { readonly kind: "again"; readonly reason: string } {
  const field = fieldOf(state);
  // A secret is kept as typed; the owner trims it, as `tavi credentials set` does.
  const value = field.secret === true ? typed : typed.trim();
  if (value.trim() === "") {
    if (field.optional === true) return next(state.id, state.values, state.index + 1, true);
    return { kind: "again", reason: t("tui.form.needed", fieldName(field, t)) };
  }
  const wrong = misfit(field, value, t);
  if (wrong !== undefined) return { kind: "again", reason: t("tui.form.mustBe", { ...fieldName(field, t), wrong }) };
  return next(state.id, { ...state.values, [field.key]: value }, state.index + 1, true);
}

/** The field a form asks now. */
export function fieldOf(state: FormState): FormField {
  const field = FORMS[state.id].fields[state.index];
  // A state is only made by `next`, at a field the form has.
  if (field === undefined) throw new TaviError("INTERNAL", `form ${state.id} has no field ${state.index}`);
  return field;
}

/** What a completed form sends to the owner. `models test` outlasts the default deadline (its own is 10 s). */
export function formRequest(
  id: FormId,
  values: Readonly<Record<string, string>>,
  workspaceId: string,
): { readonly command: IpcCommand; readonly payload: Record<string, unknown>; readonly timeoutMs: number } {
  const optional = (key: string): Record<string, string> => {
    const value = values[key];
    return value === undefined ? {} : { [key]: value };
  };
  switch (id) {
    case "credentials-set":
      return {
        command: "credentials",
        payload: { action: "set", reference: values["reference"], value: values["value"] },
        timeoutMs: 10_000,
      };
    case "models-add":
      return {
        command: "models",
        payload: {
          action: "add",
          workspaceId,
          connectionId: values["connectionId"],
          baseUrl: values["baseUrl"],
          credentialRef: values["credentialRef"],
          ...optional("model"),
        },
        timeoutMs: 10_000,
      };
    case "models-set-default":
      return {
        command: "models",
        payload: { action: "set-default", workspaceId, connectionId: values["connectionId"], ...optional("model") },
        timeoutMs: 10_000,
      };
    case "models-set-role":
      return {
        command: "models",
        payload: { action: "set-role", workspaceId, role: values["role"], connectionId: values["connectionId"], ...optional("model") },
        timeoutMs: 10_000,
      };
    case "models-test":
      return {
        command: "models",
        payload: { action: "test", workspaceId, connectionId: values["connectionId"], ...optional("model") },
        timeoutMs: 30_000,
      };
  }
}

/** What the form did, as the owner answered it: never the credential's value. */
export function formOutcome(id: FormId, values: Readonly<Record<string, string>>, result: unknown, t: CoreT = coreEnglish): string[] {
  const written = result as { readonly result?: unknown; readonly restartRequired?: boolean } | undefined;
  const restart = (why: CoreKey): string[] =>
    written?.restartRequired === true ? [t("tui.form.restart", { mark: GLYPHS.warning, why: t(why) })] : [];
  const connection = values["connectionId"] ?? "";
  const target = (): string =>
    values["model"] === undefined ? t("tui.form.defaultTarget", { connection }) : `${connection}/${values["model"]}`;
  switch (id) {
    case "credentials-set":
      return [t("tui.form.stored", { mark: GLYPHS.done, reference: values["reference"] ?? "" })];
    case "models-add":
      return [
        t("tui.form.added", {
          mark: GLYPHS.done,
          connection,
          baseUrl: values["baseUrl"] ?? "",
          credential: values["credentialRef"] ?? "",
        }),
        ...restart("tui.form.restart.connection"),
      ];
    case "models-set-default":
      return [t("tui.form.defaultIs", { mark: GLYPHS.done, target: target() }), ...restart("tui.form.restart.default")];
    case "models-set-role":
      // The owner's runs resolve role `main` — at startup — and ask for no other role.
      return values["role"] === "main"
        ? [t("tui.form.roleBound", { mark: GLYPHS.done, role: "main", target: target() }), ...restart("tui.form.restart.main")]
        : [t("tui.form.roleBound", { mark: GLYPHS.done, role: values["role"] ?? "", target: target() }), t("tui.form.roleUnused")];
    case "models-test": {
      const tested = result as {
        readonly ok?: boolean;
        readonly modelId?: string;
        readonly latencyMs?: number;
        readonly capabilities?: readonly string[];
        readonly message?: string;
      };
      const name = `${values["connectionId"]}/${tested.modelId ?? values["model"] ?? "?"}`;
      return tested.ok === true
        ? [
            t("tui.form.tested", {
              mark: GLYPHS.done,
              name,
              ms: String(tested.latencyMs ?? "?"),
              capabilities: (tested.capabilities ?? []).join(", ") || t("tui.form.noCapabilities"),
            }),
          ]
        : [
            tested.message === undefined
              ? t("tui.form.testFailed", { mark: GLYPHS.failed, name })
              : t("tui.form.testFailedWhy", { mark: GLYPHS.failed, name, message: tested.message }),
          ];
    }
  }
}

/**
 * Whether a line typed at the prompt carries a credential's shape — a provider
 * key, a bearer token, a private key. Such a line is sent nowhere: not to the
 * model, not into the transcript, not as an answer.
 */
export function looksLikeCredential(text: string): boolean {
  return redactCredentialShapes(text) !== text;
}
