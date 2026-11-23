import type { ElicitResult } from "@modelcontextprotocol/client";
import { ASK_USER_QUESTION_MAX_CHARS, type AgentWaitOutcome, type AskUserChoices, type ToolQuestion } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { csvList } from "@tavi/contracts/util";

import type { McpElicitation } from "./client.js";
import { canonicalHash } from "./jcs.js";
import { cleanServerText } from "./results.js";

/**
 * A server's question during a call:
 * a form or a URL to open, asked of the task's person as a "Needs you"
 * question naming its server, and their answer read back into the server's
 * terms. Never a default answer: a question nobody answers sends nothing.
 * Password and secret fields are refused; a URL is shown with its host and
 * never opened.
 */

/** How long a 2026-07-28 question waits: the task suspends, and the call is made again once it is answered. */
const MODERN_QUESTION_MS = 24 * 60 * 60 * 1000;
/** How long a legacy question waits: the server holds the call open meanwhile. */
export const LEGACY_QUESTION_MS = 10 * 60 * 1000;

const QUESTION_MAX = 1_500;

/**
 * Tavi's buttons, in the workspace's language. An answer is read by which button it is, not by its words, so a
 * question asked in one language and answered after a change to another (or typed in English) reads the same.
 */
const BUTTONS = ["decline", "done", "accept", "yes", "no"] as const;
type Button = (typeof BUTTONS)[number];
const buttonWord = (button: Button, t: CoreT): string => t(`mcp.elicit.${button}`);

/** The button an answer names, in `t`'s words or English; undefined for other words. */
function buttonOf(text: string | undefined, t: CoreT): Button | undefined {
  if (text === undefined) return undefined;
  const said = text.trim().toLowerCase();
  return BUTTONS.find((button) => buttonWord(button, t).toLowerCase() === said || buttonWord(button, coreEnglish).toLowerCase() === said);
}

/** A question to ask, and how to read its answer; or why the server's question is declined at once. */
export type ElicitationPlan =
  | { readonly kind: "ask"; readonly question: ToolQuestion; readonly read: (outcome: AgentWaitOutcome) => ElicitResult | undefined }
  | { readonly kind: "decline"; readonly reason: string };

type Field = Readonly<Record<string, unknown>>;

/** A server's words for the person — a message, a field's name, title or option — cleaned, on one line. */
const shown = (text: string, max = 200): string => cleanServerText(text).replace(/\s+/g, " ").trim().slice(0, max);

/** A field that asks for a secret, by its name, title or description: never asked in a question. */
const SECRET_WORDS =
  /(?:^|[^a-z])(?:password|passwd|passcode|passphrase|pin|secret|token|api[-_ ]?key|apikey|private[-_ ]?key|credential|credentials|otp|cvv|cvc)(?:[^a-z]|$)/i;

function secretField(name: string, field: Field): boolean {
  const words = [name, field["title"], field["description"]].filter((value): value is string => typeof value === "string");
  return (
    field["format"] === "password" ||
    field["writeOnly"] === true ||
    words.some((text) => SECRET_WORDS.test(text.replace(/([a-z])([A-Z])/g, "$1 $2")))
  );
}

/** One field's choices, by label: an enum's values (titled or not), or none. */
function enumOf(field: Field): readonly { readonly label: string; readonly value: string }[] | undefined {
  if (Array.isArray(field["oneOf"])) {
    return (field["oneOf"] as readonly Field[])
      .filter((entry) => typeof entry["const"] === "string")
      .map((entry) => ({
        label: shown(typeof entry["title"] === "string" ? entry["title"] : (entry["const"] as string), 60),
        value: entry["const"] as string,
      }));
  }
  if (Array.isArray(field["enum"])) {
    const names = Array.isArray(field["enumNames"]) ? (field["enumNames"] as readonly unknown[]) : [];
    return (field["enum"] as readonly unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value, index) => ({ label: shown(typeof names[index] === "string" ? (names[index] as string) : value, 60), value }));
  }
  return undefined;
}

/** A field's value from a person's words, in its type; undefined when the words do not fit. */
function valueOf(field: Field, text: string): string | number | boolean | string[] | undefined {
  const words = text.trim();
  const type = field["type"];
  if (type === "boolean") return /^(?:yes|true|y|да|д)$/i.test(words) ? true : /^(?:no|false|n|не|н)$/i.test(words) ? false : undefined;
  if (type === "number" || type === "integer") {
    const number = Number(words);
    if (words === "" || !Number.isFinite(number) || (type === "integer" && !Number.isInteger(number))) return undefined;
    return number;
  }
  if (type === "array") {
    const items = (field["items"] ?? {}) as Field;
    const choices = enumOf(items) ?? [];
    const picked = csvList(words).map(
      (part) => choices.find((choice) => choice.label.toLowerCase() === part.toLowerCase() || choice.value === part)?.value,
    );
    return picked.length === 0 || picked.some((value) => value === undefined) ? undefined : (picked as string[]);
  }
  const choices = enumOf(field);
  if (choices !== undefined)
    return choices.find((choice) => choice.label.toLowerCase() === words.toLowerCase() || choice.value === words)?.value;
  return words === "" ? undefined : words;
}

/** The words of an answer: the option chosen, or what was typed. */
function answerText(outcome: AgentWaitOutcome): string | undefined {
  if (outcome.kind !== "answered") return undefined;
  return (outcome.answers?.[0] ?? outcome.other ?? outcome.replyText)?.trim();
}

const options = (labels: readonly string[], allowOther = false): AskUserChoices => ({
  options: labels.map((label) => ({ label })),
  multiSelect: false,
  allowOther,
});

/**
 * The plan for one server question: `server` is the operator's name for the
 * server, `era` how the call waits (a legacy server holds its call open), `t`
 * the workspace's words for Tavi's frame and buttons; the server's own words
 * are shown as it wrote them.
 */
export function planElicitation(
  server: string,
  request: McpElicitation,
  era: "modern" | "legacy",
  t: CoreT = coreEnglish,
): ElicitationPlan {
  const { _meta: _ignored, ...asked } = request as McpElicitation & { readonly _meta?: unknown };
  const key = canonicalHash(asked).slice(0, 24);
  const message = shown(request.message, QUESTION_MAX);
  const deadlineMs = era === "modern" ? MODERN_QUESTION_MS : LEGACY_QUESTION_MS;
  const context = t(era === "modern" ? "mcp.elicit.context.modern" : "mcp.elicit.context.legacy", { server });
  const DECLINE = buttonWord("decline", t);
  const decline = (outcome: AgentWaitOutcome): boolean => buttonOf(answerText(outcome), t) === "decline";

  if (request.mode === "url") {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { kind: "decline", reason: "its address is not a URL" };
    }
    if (url.protocol !== "https:") return { kind: "decline", reason: "only an https address is shown" };
    return {
      kind: "ask",
      question: {
        key,
        question: t("mcp.elicit.openPage", {
          server,
          host: shown(url.hostname),
          message,
          url: shown(url.href, 1_000),
          done: buttonWord("done", t),
        }).slice(0, ASK_USER_QUESTION_MAX_CHARS),
        choices: options([buttonWord("done", t), DECLINE]),
        context,
        deadlineMs,
      },
      read: (outcome) =>
        answerText(outcome) === undefined
          ? undefined
          : decline(outcome)
            ? { action: "decline" }
            : buttonOf(answerText(outcome), t) === "done"
              ? { action: "accept" }
              : { action: "decline" },
    };
  }

  const schema = (request.requestedSchema ?? { properties: {} }) as {
    readonly properties?: Readonly<Record<string, Field>>;
    readonly required?: readonly string[];
  };
  const fields = Object.entries(schema.properties ?? {});
  const secret = fields.find(([name, field]) => secretField(name, field));
  if (secret !== undefined)
    return {
      kind: "decline",
      reason: `it asks for ${shown(secret[0], 60)}, a password or secret, which Tavi never collects in a question`,
    };
  const required = new Set(schema.required ?? []);
  const named = (name: string, field: Field): string =>
    typeof field["title"] === "string" ? `${shown(field["title"], 60)} (${shown(name, 60)})` : shown(name, 60);
  const ask = (question: string, choices?: AskUserChoices): ToolQuestion => ({
    key,
    question: t("mcp.elicit.asks", { server, question }).slice(0, ASK_USER_QUESTION_MAX_CHARS),
    ...(choices === undefined ? {} : { choices }),
    context,
    deadlineMs,
  });

  // A confirmation: no fields at all.
  if (fields.length === 0) {
    return {
      kind: "ask",
      question: ask(message, options([buttonWord("accept", t), DECLINE])),
      read: (outcome) =>
        answerText(outcome) === undefined
          ? undefined
          : buttonOf(answerText(outcome), t) === "accept"
            ? { action: "accept", content: {} }
            : { action: "decline" },
    };
  }
  if (fields.length === 1) {
    const [name, field] = fields[0] as [string, Field];
    const choices =
      field["type"] === "boolean"
        ? [
            { label: buttonWord("yes", t), value: "true" },
            { label: buttonWord("no", t), value: "false" },
          ]
        : enumOf(field);
    // Buttons when the choices fit beside Decline; typed words otherwise.
    const buttons = choices !== undefined && choices.length <= 3 ? options([...choices.map((choice) => choice.label), DECLINE]) : undefined;
    const label = named(name, field);
    const hinted =
      buttons !== undefined
        ? label
        : field["type"] === "array"
          ? t("mcp.elicit.field.many", { field: label })
          : choices !== undefined
            ? t("mcp.elicit.field.oneOf", { field: label, choices: choices.map((choice) => choice.label).join(", ") })
            : label;
    return {
      kind: "ask",
      question: ask(
        `${message}\n${buttons === undefined ? t("mcp.elicit.orAnswer", { text: hinted, decline: DECLINE }) : hinted}`,
        buttons,
      ),
      read: (outcome) => {
        const text = answerText(outcome);
        if (text === undefined) return undefined;
        if (decline(outcome)) return { action: "decline" };
        // A yes or no button is read by which it is, in either language.
        const button = field["type"] === "boolean" ? buttonOf(text, t) : undefined;
        const value = button === "yes" ? true : button === "no" ? false : valueOf(field, text);
        return value === undefined ? { action: "decline" } : { action: "accept", content: { [name]: value } };
      },
    };
  }
  // Several fields: one line each, `name: value`.
  const lines = fields.map(
    ([name, field]) => `- ${required.has(name) ? named(name, field) : t("mcp.elicit.field.optional", { field: named(name, field) })}`,
  );
  return {
    kind: "ask",
    question: ask(`${message}\n${t("mcp.elicit.perLine", { decline: DECLINE })}\n${lines.join("\n")}`),
    read: (outcome) => {
      const text = answerText(outcome);
      if (text === undefined) return undefined;
      if (decline(outcome)) return { action: "decline" };
      // By the field's name or its title, as the question shows both, whatever the case.
      const given = new Map(
        text
          .split("\n")
          .map((line) => line.split(/:(.*)/s))
          .filter((parts) => parts.length >= 2)
          .map(([name, value]) => [(name ?? "").trim().toLowerCase(), (value ?? "").trim()]),
      );
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const [name, field] of fields) {
        const words =
          given.get(name.toLowerCase()) ??
          (typeof field["title"] === "string" ? given.get(shown(field["title"], 60).toLowerCase()) : undefined);
        if (words === undefined || words === "") {
          if (required.has(name)) return { action: "decline" };
          continue;
        }
        const value = valueOf(field, words);
        if (value === undefined) return { action: "decline" };
        content[name] = value;
      }
      return { action: "accept", content };
    },
  };
}
