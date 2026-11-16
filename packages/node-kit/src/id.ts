import { randomUUID } from "node:crypto";

/** A fresh id: `<prefix>-<random UUID>`. */
export function prefixedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
