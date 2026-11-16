import {
  CONNECTION_ID_PATTERN,
  MODEL_ROLES,
  redactCredentialShapes,
  SECRET_KEY_REF_PATTERN,
  TaviError,
  type IpcCommand,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

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
  readonly label: string;
  /** Enter on nothing leaves it out. */
  readonly optional?: true;
  /** Typed masked, and never taken from the command line. */
  readonly secret?: true;
  readonly choices?: readonly string[];
  /**
   * The shape the owner will accept, checked here first so a refusal never
   * echoes what was typed — a key pasted into the wrong field included.
   */
  readonly shape?: { readonly pattern: RegExp; readonly maxLength: number; readonly describe: string };
}

/** A credential reference, as `assertSecretKeyRef` accepts it. */
const REFERENCE = {
  pattern: SECRET_KEY_REF_PATTERN,
  maxLength: 128,
  describe: "a reference like openai or stripe.apiKey (letters, digits, . _ -)",
};
/** A connection id, as `ModelConnectionSchema` accepts it. */
const CONNECTION = {
  pattern: CONNECTION_ID_PATTERN,
  maxLength: 64,
  describe: "a connection id like openai or local (lower-case letters, digits, . _ -)",
};

export interface FormSpec {
  readonly title: string;
  readonly fields: readonly FormField[];
}

export const FORMS: Readonly<Record<FormId, FormSpec>> = {
  "credentials-set": {
    title: "store a credential",
    fields: [
      { key: "reference", label: "reference (the name a connection names it by, e.g. openai)", shape: REFERENCE },
      { key: "value", label: "value (hidden)", secret: true },
    ],
  },
  "models-add": {
    title: "add a model connection",
    fields: [
      { key: "connectionId", label: "connection id", shape: CONNECTION },
      { key: "baseUrl", label: "base URL (e.g. https://api.openai.com/v1)" },
      { key: "credentialRef", label: "credential reference (stored with /credentials set)", shape: REFERENCE },
      { key: "model", label: "default model", optional: true },
    ],
  },
  "models-set-default": {
    title: "set the workspace's default model",
    fields: [
      { key: "connectionId", label: "connection id", shape: CONNECTION },
      { key: "model", label: "model (the connection's default when left out)", optional: true },
    ],
  },
  "models-set-role": {
    title: "bind a role to a model",
    fields: [
      { key: "role", label: "role", choices: MODEL_ROLES },
      { key: "connectionId", label: "connection id", shape: CONNECTION },
      { key: "model", label: "model (the connection's default when left out)", optional: true },
    ],
  },
  "models-test": {
    title: "test a model connection",
    fields: [
      { key: "connectionId", label: "connection id", shape: CONNECTION },
      { key: "model", label: "model (the connection's default when left out)", optional: true },
    ],
  },
};

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
function misfit(field: FormField, value: string): string | undefined {
  if (field.choices !== undefined && !field.choices.includes(value)) return `one of ${field.choices.join(", ")}`;
  // A key where a name belongs — a reference, a connection id — would be
  // stored and shown as one.
  if (field.secret !== true && looksLikeCredential(value))
    return "a name, not a credential: a credential's value goes in /credentials set, typed hidden";
  if (field.shape !== undefined && (value.length > field.shape.maxLength || !field.shape.pattern.test(value))) return field.shape.describe;
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
export function openForm(id: FormId, words: readonly string[]): FormStep {
  const fields = FORMS[id].fields;
  const fillable = fields.filter((field) => field.secret !== true);
  if (words.length > fillable.length) {
    const secret = fields.some((field) => field.secret === true);
    return {
      kind: "refused",
      reason: secret
        ? `${FORM_COMMANDS[id]} takes at most ${plural(fillable.length, "word")}: the value is typed in the form, hidden, never on the command line`
        : `${FORM_COMMANDS[id]} takes at most ${fillable.length} words`,
    };
  }
  const values: Record<string, string> = {};
  for (const [index, word] of words.entries()) {
    // Never past the last: more words than fields were refused above.
    const field = fillable[index];
    if (field === undefined) break;
    const wrong = misfit(field, word);
    if (wrong !== undefined) return { kind: "refused", reason: `${field.key} must be ${wrong}` };
    values[field.key] = word;
  }
  return next(id, values, 0, words.length === 0);
}

/**
 * The field asked now, answered with `typed`: the next step, or why the answer
 * does not do (the same field is asked again). An optional field answered with
 * nothing is left out.
 */
export function enterField(state: FormState, typed: string): FormStep | { readonly kind: "again"; readonly reason: string } {
  const field = fieldOf(state);
  // A secret is kept as typed; the owner trims it, as `tavi credentials set` does.
  const value = field.secret === true ? typed : typed.trim();
  if (value.trim() === "") {
    if (field.optional === true) return next(state.id, state.values, state.index + 1, true);
    return { kind: "again", reason: `${field.key} is needed (Esc cancels the form)` };
  }
  const wrong = misfit(field, value);
  if (wrong !== undefined) return { kind: "again", reason: `${field.key} must be ${wrong}` };
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
export function formOutcome(id: FormId, values: Readonly<Record<string, string>>, result: unknown): string[] {
  const written = result as { readonly result?: unknown; readonly restartRequired?: boolean } | undefined;
  const restart = (why: string): string[] =>
    written?.restartRequired === true ? [`  ${GLYPHS.warning} restart \`tavi serve\` for this to take effect: ${why}`] : [];
  const target = (): string => `${values["connectionId"]}${values["model"] === undefined ? " (its default model)" : `/${values["model"]}`}`;
  switch (id) {
    case "credentials-set":
      return [`${GLYPHS.done} credential ${values["reference"]} stored; the owner reads it on its next call, no restart needed`];
    case "models-add":
      return [
        `${GLYPHS.done} connection ${values["connectionId"]} added: ${values["baseUrl"]}, credential ${values["credentialRef"]}`,
        ...restart("the owner's running connection was composed with its old endpoint and credential"),
      ];
    case "models-set-default":
      return [
        `${GLYPHS.done} the workspace's default model is ${target()}`,
        ...restart("the owner runs the target it resolved when it started"),
      ];
    case "models-set-role":
      // The owner's runs resolve role `main` — at startup — and ask for no other role.
      return values["role"] === "main"
        ? [`${GLYPHS.done} role main is bound to ${target()}`, ...restart("the owner resolved role main when it started")]
        : [
            `${GLYPHS.done} role ${values["role"]} is bound to ${target()}`,
            "  the owner's own runs resolve role main only; nothing it runs asks for this role yet",
          ];
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
            `${GLYPHS.done} ${name} answered in ${tested.latencyMs ?? "?"} ms; observed: ${(tested.capabilities ?? []).join(", ") || "no capabilities"}`,
          ]
        : [`${GLYPHS.failed} ${name} failed the test${tested.message === undefined ? "" : `: ${tested.message}`}`];
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
