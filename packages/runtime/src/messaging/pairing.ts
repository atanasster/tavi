import { randomInt, randomUUID } from "node:crypto";

import { MESSAGING_DISPLAY_NAME_MAX, type InboundEvent } from "@tavi/contracts";

/**
 * Pairing a person with a code: the
 * operator asks for a one-time code for a connection and a person, the person
 * sends it there, and the first message carrying it from a sender nobody
 * allowed yet claims it — for the operator to confirm who it was before any
 * binding is made. It works the same on every channel: no connector knows of
 * it. A code is never a turn (its sender is not allowed, so nothing admits
 * it), and on a channel that checks each message (email) only a verified one
 * claims it.
 */

/** Unambiguous letters and digits: no 0/O, 1/I/L. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Codes waiting at once, across connections: a bound on what a stuck page can leave behind. */
const MAX_OPEN = 100;

export interface PairingRequest {
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly name?: string;
  /** On a channel that checks each message: whether the person's unverified messages are admitted once allowed. */
  readonly trustUnverified?: boolean;
}

export interface Pairing extends PairingRequest {
  readonly pairingId: string;
  readonly code: string;
  readonly expiresAt: string;
  /** The sender whose message carried the code, once one did. */
  readonly claimedBy?: string;
  /** What the platform called that sender (`InboundEvent.senderName`), display only. */
  readonly claimedName?: string;
}

export type PairingState = "waiting" | "claimed" | "expired";

function newCode(): string {
  return Array.from({ length: PAIRING_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/**
 * A message's first line as a code would be sent — bare, or after `/start`
 * (Telegram's deep-link start parameter from a QR scan or `t.me` link) or
 * `/link`: case, spaces and dashes aside.
 */
function codeIn(content: string | undefined): string | undefined {
  const line = content?.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return undefined;
  const body = line.trim().replace(/^\/(?:start|link)(?:@[A-Za-z0-9_]+)?\s+/i, "");
  const compact = body.replace(/[\s-]/g, "").toUpperCase();
  return compact.length === PAIRING_CODE_LENGTH ? compact : undefined;
}

export class PairingRegistry {
  readonly #now: () => number;
  readonly #pairings = new Map<string, Pairing>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A new code for `request`, valid for ten minutes. */
  start(request: PairingRequest): Pairing {
    this.#sweep();
    if (this.#pairings.size >= MAX_OPEN) {
      const now = this.#now();
      const expiredUnclaimed = [...this.#pairings.entries()].find(
        ([, candidate]) => candidate.claimedBy === undefined && Date.parse(candidate.expiresAt) <= now,
      )?.[0];
      const waitingUnclaimed = [...this.#pairings.entries()].find(([, candidate]) => candidate.claimedBy === undefined)?.[0];
      const victim = expiredUnclaimed ?? waitingUnclaimed ?? this.#pairings.keys().next().value;
      if (victim !== undefined) this.#pairings.delete(victim);
    }
    const pairing: Pairing = {
      ...request,
      pairingId: randomUUID(),
      code: newCode(),
      expiresAt: new Date(this.#now() + PAIRING_TTL_MS).toISOString(),
    };
    this.#pairings.set(pairing.pairingId, pairing);
    return pairing;
  }

  /** The pairing and how it stands; `undefined` once confirmed, cancelled or long gone. */
  get(pairingId: string): { readonly pairing: Pairing; readonly state: PairingState } | undefined {
    const pairing = this.#pairings.get(pairingId);
    if (pairing === undefined) return undefined;
    if (pairing.claimedBy !== undefined) return { pairing, state: "claimed" };
    return { pairing, state: Date.parse(pairing.expiresAt) <= this.#now() ? "expired" : "waiting" };
  }

  /**
   * Whether `event` — a message from a sender nobody allowed — carries a
   * waiting code for its connection; it then claims it. A message the
   * channel could not verify (email that failed SPF/DKIM) claims nothing.
   */
  claim(event: InboundEvent): boolean {
    if (event.kind !== "message") return false;
    if (event.authorKind !== undefined && event.authorKind !== "person") return false;
    if (event.forwarded !== undefined) return false;
    if (event.senderAuthentication !== undefined && event.senderAuthentication !== "pass") return false;
    const code = codeIn(event.content);
    if (code === undefined) return false;
    for (const [pairingId, pairing] of this.#pairings) {
      if (pairing.connectionId !== event.connectionId || pairing.code !== code || pairing.claimedBy !== undefined) continue;
      if (Date.parse(pairing.expiresAt) <= this.#now()) continue;
      const claimedName = event.senderName?.trim().slice(0, MESSAGING_DISPLAY_NAME_MAX).trimEnd();
      this.#pairings.set(pairingId, {
        ...pairing,
        claimedBy: event.externalSenderId,
        ...(claimedName === undefined || claimedName === "" ? {} : { claimedName }),
      });
      return true;
    }
    return false;
  }

  /** Ends a pairing: confirmed (its binding made by the caller) or cancelled. */
  end(pairingId: string): void {
    this.#pairings.delete(pairingId);
  }

  /** Forgets codes that expired unclaimed a while ago; a claimed one waits for the operator. */
  #sweep(): void {
    const stale = this.#now() - PAIRING_TTL_MS;
    for (const [pairingId, pairing] of this.#pairings) {
      if (pairing.claimedBy === undefined && Date.parse(pairing.expiresAt) <= stale) this.#pairings.delete(pairingId);
    }
  }
}
