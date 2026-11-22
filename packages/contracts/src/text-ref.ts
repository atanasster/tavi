import { z } from "zod";

import { coreEnglish, type CoreKey, type CoreT } from "./locales/core.js";
import { CORE_EN } from "./locales/core-en.js";

/**
 * Words stored for later, by key: a `core` catalogue key and its parameters,
 * kept beside the English they were said in so a reader sees them in the
 * workspace's language at read time. A parameter is text, a number, or another
 * reference (a status, a menu path) said in the reader's language too. Text a
 * person wrote (a routine's name, a chat's title) is only ever a parameter.
 */
export interface TextRef {
  readonly key: string;
  readonly params?: TextRefParams;
}
export type TextRefParams = { readonly [name: string]: string | number | TextRef };

/** Bounds of a stored reference: its key, a parameter's name and text, how many it has, and how deep they nest. */
export const TEXT_REF_KEY_MAX = 128;
export const TEXT_REF_PARAM_MAX = 4_000;
export const TEXT_REF_PARAMS_MAX = 16;
export const TEXT_REF_DEPTH_MAX = 8;

const depthOf = (ref: TextRef): number =>
  1 + Math.max(0, ...Object.values(ref.params ?? {}).map((value) => (typeof value === "object" ? depthOf(value) : 0)));

const TextRefShape: z.ZodType<TextRef> = z.lazy(() =>
  z.strictObject({
    key: z.string().min(1).max(TEXT_REF_KEY_MAX),
    params: z
      .record(z.string().min(1).max(64), z.union([z.string().max(TEXT_REF_PARAM_MAX), z.number(), TextRefShape]))
      .refine((params) => Object.keys(params).length <= TEXT_REF_PARAMS_MAX, { message: "too many parameters" })
      .optional(),
  }),
) as z.ZodType<TextRef>;

export const TextRefSchema: z.ZodType<TextRef> = TextRefShape.refine((ref) => depthOf(ref) <= TEXT_REF_DEPTH_MAX, {
  message: "nested too deeply",
});

/** A reference to a `core` key, checked by the compiler. */
export function textRef(key: CoreKey, params?: TextRefParams): TextRef {
  return params === undefined ? { key } : { key, params };
}

/** Whether `key` is one of the `core` catalogue's. */
export function isCoreKey(key: string): key is CoreKey {
  return Object.hasOwn(CORE_EN, key);
}

/** `ref` said by `t`, its nested references first; undefined when a key in it is not one this build knows. */
export function renderTextRef(ref: TextRef, t: CoreT = coreEnglish): string | undefined {
  if (!isCoreKey(ref.key)) return undefined;
  if (ref.params === undefined) return t(ref.key);
  const params: { [name: string]: string | number } = {};
  for (const [name, value] of Object.entries(ref.params)) {
    if (typeof value !== "object") params[name] = value;
    else {
      const said = renderTextRef(value, t);
      if (said === undefined) return undefined;
      params[name] = said;
    }
  }
  return t(ref.key, params);
}

/** `ref` in English, as it is stored beside the reference. */
export function englishOf(ref: TextRef): string {
  return renderTextRef(ref, coreEnglish) ?? ref.key;
}

/**
 * Stored words in the reader's language: `ref` said by `t` when there is one
 * and every key in it is known, else `fallback`, the English stored with it
 * (an older row, written before references, has only that).
 */
export function localizedText(fallback: string, ref: TextRef | undefined, t: CoreT): string {
  return ref === undefined ? fallback : (renderTextRef(ref, t) ?? fallback);
}

/** Words stored as text and, when they are Tavi's, a reference: the English is the reference's own. */
export type StoredWords = string | TextRef;

/** `words` as stored: its English, and the reference when it has one. */
export function storedWords(words: StoredWords): { readonly text: string; readonly ref?: TextRef } {
  return typeof words === "string" ? { text: words } : { text: englishOf(words), ref: words };
}
