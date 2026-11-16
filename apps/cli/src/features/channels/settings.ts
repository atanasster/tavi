import { sha256Hex } from "@tavi/node-kit";

const digest = (value: string): string => sha256Hex(value).slice(0, 32);

/**
 * The credential reference behind one secret field of a connection:
 * namespaced by connection, hashed because a
 * connection id may hold characters a reference may not.
 */
export function channelSecretRef(connectionId: string, field: string): string {
  return `channels.${digest(connectionId)}.${field}`;
}
