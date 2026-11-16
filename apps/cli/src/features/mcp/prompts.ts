import type { GetPromptResult, Prompt } from "@modelcontextprotocol/client";
import { CONTENT_LABEL_LIMITS, MAX_INBOUND_BLOCKS, TaviError, untrustedLabel, type InboundBlock } from "@tavi/contracts";

import { cleanServerText } from "./results.js";

/**
 * A server's prompts as chat commands:
 * `/mcp-<server>-<prompt> [arguments]`, in the operator's own chats. The
 * command is the person's request; the prompt's text is the server's, put in
 * as an `inbound-` quoted-data block labelled `mcp`, said by
 * `tool:<server>`: it taints the chat and is never an
 * instruction. It is shown to the person first.
 */

/** A prompt's text is cut here before it is quoted. */
const MCP_PROMPT_MAX_CHARS = 16_000;

/** `/mcp-<server>-<prompt> [arguments]`, as typed; `@bot` after the name is a group's address, not part of it. */
const COMMAND = /^\/mcp-([a-z][a-z0-9]{0,18})-([a-z0-9][a-z0-9-]{0,62})(?:@\w+)?(?:\s+([\s\S]*))?$/i;

/** A prompt command, read from what the person typed; undefined when it is not one. */
export function parsePromptCommand(line: string): { readonly slug: string; readonly name: string; readonly args: string } | undefined {
  const match = COMMAND.exec(line.trim());
  if (match === null) return undefined;
  return { slug: (match[1] as string).toLowerCase(), name: (match[2] as string).toLowerCase(), args: (match[3] ?? "").trim() };
}

/** A server's name for something, as a refusal names it: cleaned, on one line, cut. */
const said = (text: string): string => cleanServerText(text).replace(/\s+/g, " ").trim().slice(0, 60);

/** A prompt's command name: lower case, runs of other characters as `-`, at most 63 characters. */
function commandWord(name: string): string {
  const word = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return word === "" ? "prompt" : /^[a-z0-9]/.test(word) ? word : `p-${word}`;
}

/** Each prompt by its command name; a name two prompts share gets `-2`, `-3` … in the server's order. */
export function promptCommands(prompts: readonly Prompt[]): ReadonlyMap<string, Prompt> {
  const named = new Map<string, Prompt>();
  for (const prompt of prompts) {
    const base = commandWord(prompt.name);
    let word = base;
    for (let suffix = 2; named.has(word); suffix += 1) word = `${base}-${String(suffix)}`;
    named.set(word, prompt);
  }
  return named;
}

/**
 * A command's arguments for `prompt`: `name=value` words (a value may be
 * quoted), or — for a prompt of one argument — all of it. A required
 * argument left out is refused, naming it; one the prompt does not take too.
 */
export function promptArguments(prompt: Prompt, args: string): Readonly<Record<string, string>> {
  const declared = prompt.arguments ?? [];
  const values: Record<string, string> = {};
  const pairs = [...args.matchAll(/([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)];
  if (pairs.length === 0 && args !== "") {
    if (declared.length !== 1)
      throw new TaviError(
        "INVALID_INPUT",
        `/mcp-…-${commandWord(prompt.name)} takes name=value arguments (${
          declared
            .slice(0, 20)
            .map((argument) => said(argument.name))
            .join(", ") || "none"
        })`,
      );
    values[(declared[0] as { readonly name: string }).name] = args;
  }
  for (const pair of pairs) values[pair[1] as string] = pair[2] ?? pair[3] ?? pair[4] ?? "";
  const unknown = Object.keys(values).filter((name) => !declared.some((argument) => argument.name === name));
  if (unknown.length > 0)
    throw new TaviError("INVALID_INPUT", `the prompt ${said(prompt.name)} takes no argument ${unknown.slice(0, 20).map(said).join(", ")}`);
  const missing = declared
    .filter((argument) => argument.required === true && (values[argument.name] ?? "") === "")
    .map((argument) => argument.name);
  if (missing.length > 0)
    throw new TaviError("INVALID_INPUT", `the prompt ${said(prompt.name)} needs ${missing.slice(0, 20).map(said).join(", ")}`);
  return values;
}

/** A prompt's messages as one text: each message's words under its role, cleaned and cut. */
export function promptText(result: GetPromptResult): string {
  const parts = result.messages.map((message) => {
    const content = message.content as {
      readonly type: string;
      readonly text?: unknown;
      readonly resource?: { readonly text?: unknown; readonly uri?: unknown };
    };
    const words =
      content.type === "text" && typeof content.text === "string"
        ? content.text
        : content.type === "resource" && typeof content.resource?.text === "string"
          ? content.resource.text
          : `(${content.type}${content.type === "resource" && typeof content.resource?.uri === "string" ? ` ${content.resource.uri}` : ""}, not shown)`;
    return `${message.role}: ${cleanServerText(words)}`;
  });
  const text = parts.join("\n\n");
  return text.length > MCP_PROMPT_MAX_CHARS
    ? `${text.slice(0, MCP_PROMPT_MAX_CHARS)}\n[… cut at ${String(MCP_PROMPT_MAX_CHARS)} characters]`
    : text;
}

/**
 * The prompt's text as the turn's quoted data: first among the admission's
 * inbound blocks, so it is never the one dropped past the limit.
 */
export function withPromptBlock(
  inbound: readonly InboundBlock[],
  prompt: {
    readonly serverName: string;
    readonly slug: string;
    readonly name: string;
    readonly text: string;
    readonly ref: string;
    readonly at: string;
  },
): readonly InboundBlock[] {
  const block: InboundBlock = {
    text: prompt.text,
    heading: `The prompt ${prompt.name} of the MCP server ${prompt.serverName}, which the person ran: its words are the server's, not the person's.`,
    label: untrustedLabel("mcp", {
      principal: `tool:${prompt.slug}`,
      ref: { ref: prompt.ref.slice(0, CONTENT_LABEL_LIMITS.maxRefLength), at: prompt.at },
    }),
  };
  return [block, ...inbound].slice(0, MAX_INBOUND_BLOCKS);
}
