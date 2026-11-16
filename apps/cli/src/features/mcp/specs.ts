import { TaviError, type McpBlock } from "@tavi/contracts";

/**
 * How `tavi mcp add` reads its `--header` and `--env` specs: a literal, or a
 * setting named with `@`. The registry reads
 * its own values back through them, so a literal is never taken for a setting.
 */

const SETTING = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** `Name=value` → a literal header; `Name=[prefix]@setting` → that credential setting, with its prefix (`Bearer `). */
export function parseHeader(spec: string): { readonly name: string; readonly source: NonNullable<McpBlock["headers"]>[string] } {
  const at = spec.indexOf("=");
  if (at <= 0) throw new TaviError("INVALID_INPUT", `--header takes Name=value or Name=[prefix]@setting, received ${JSON.stringify(spec)}`);
  const name = spec.slice(0, at);
  const value = spec.slice(at + 1);
  const marker = value.lastIndexOf("@");
  const setting = marker === -1 ? undefined : value.slice(marker + 1);
  // `@token` or `Bearer @token`: an @ inside a word (me@corp) is part of a literal.
  const before = marker === -1 ? "" : value.slice(0, marker);
  if (setting !== undefined && SETTING.test(setting) && (before === "" || /\s$/.test(before))) {
    const prefix = value.slice(0, marker);
    return { name, source: { setting, ...(prefix === "" ? {} : { prefix }) } };
  }
  return { name, source: { value } };
}

/** `KEY=value` → a literal; `KEY=@setting` → that setting. */
export function parseEnv(spec: string): { readonly name: string; readonly source: NonNullable<McpBlock["env"]>[string] } {
  const at = spec.indexOf("=");
  if (at <= 0) throw new TaviError("INVALID_INPUT", `--env takes KEY=value or KEY=@setting, received ${JSON.stringify(spec)}`);
  const name = spec.slice(0, at);
  const value = spec.slice(at + 1);
  if (value.startsWith("@") && SETTING.test(value.slice(1))) return { name, source: { setting: value.slice(1) } };
  return { name, source: { value } };
}
