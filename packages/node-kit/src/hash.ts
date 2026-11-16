import { createHash } from "node:crypto";

/** The SHA-256 of `data` as lowercase hex; a string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
