import { serialize } from "node:v8";
import { TaviError } from "@tavi/contracts";

/** Reserve a conservative encoded size before V8 allocates its serialization buffer. */
export function serializeBounded(input: unknown, budget: number): Buffer {
  let remaining = budget;
  const seen = new WeakSet<object>();
  const charge = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw new TaviError("BUDGET_EXCEEDED", "Database payload exceeds its serialization budget");
  };
  const visit = (value: unknown): void => {
    charge(16);
    if (typeof value === "string") {
      charge(value.length * 2);
      return;
    }
    if (typeof value === "bigint") {
      charge(value.toString(16).length);
      return;
    }
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return;
    if (typeof value !== "object") throw new TaviError("INVALID_INPUT", "Database arguments must contain serializable data");
    if (seen.has(value)) return;
    seen.add(value);
    charge(64);
    if (ArrayBuffer.isView(value)) {
      charge(value.byteLength);
      return;
    }
    if (value instanceof ArrayBuffer) {
      charge(value.byteLength);
      return;
    }
    if (value instanceof Date) return;
    if (value instanceof Map) {
      for (const [key, item] of value) {
        visit(key);
        visit(item);
      }
      return;
    }
    if (value instanceof Set) {
      for (const item of value) visit(item);
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TaviError("INVALID_INPUT", "Database arguments cannot contain class instances");
    }
    if (Array.isArray(value)) charge(value.length);
    for (const key in value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) throw new TaviError("INVALID_INPUT", "Database arguments cannot contain accessors");
      visit(key);
      visit(descriptor.value);
    }
  };
  visit(input);
  const body = serialize(input);
  if (body.byteLength > budget) throw new TaviError("BUDGET_EXCEEDED", "Database payload exceeds its serialization budget");
  return body;
}
