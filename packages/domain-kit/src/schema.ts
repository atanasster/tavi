import { z } from "zod";

/**
 * The Zod a schema is drawn with: a kit's own (`KIT_ZOD`), or the host's
 * (`ctx.z`) a plugin writes its tools' input schemas with. Only the makers
 * the kits use: the whole namespace, passed as a value, would bundle all of Zod.
 */
export type Zod = Pick<
  typeof z,
  "array" | "boolean" | "discriminatedUnion" | "enum" | "literal" | "number" | "object" | "preprocess" | "strictObject" | "string" | "union"
>;

/** The kits' own Zod, as `Zod`. */
export const KIT_ZOD: Zod = {
  array: z.array,
  boolean: z.boolean,
  discriminatedUnion: z.discriminatedUnion,
  enum: z.enum,
  literal: z.literal,
  number: z.number,
  object: z.object,
  preprocess: z.preprocess,
  strictObject: z.strictObject,
  string: z.string,
  union: z.union,
};

/**
 * How a schema's objects are drawn: `strict` for a kit's own check of an
 * input, which refuses a key it does not know; `open` for the same input as
 * a plugin's tool declares it to the host.
 */
export type ObjectMode = "strict" | "open";

/** The object schemas of `mode`, drawn with `zod`. Both read alike; only `strict` refuses an unknown key. */
export function objectsOf(zod: Zod, mode: ObjectMode): <Shape extends z.core.$ZodLooseShape>(shape: Shape) => z.ZodObject<Shape> {
  return (shape) => (mode === "strict" ? zod.strictObject(shape) : zod.object(shape));
}
