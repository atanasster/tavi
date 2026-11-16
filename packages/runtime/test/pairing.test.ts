import { describe, expect, it } from "vitest";

import type { InboundEvent } from "@tavi/contracts";

import { PairingRegistry, PAIRING_TTL_MS } from "../src/messaging/pairing.js";

/** Pairing a person with a one-time code. */

const message = (content: string, extra: Partial<InboundEvent> = {}): InboundEvent => ({
  connectionId: "c1",
  providerEventId: "e",
  kind: "message",
  externalSenderId: "77",
  externalConversationId: "77",
  occurredAt: "",
  receivedAt: "",
  content,
  ...extra,
});

describe("PairingRegistry", () => {
  it("gives an 8-character code of unambiguous characters, claimed once by the first message carrying it on its connection", () => {
    let now = 0;
    const pairings = new PairingRegistry(() => now);
    const pairing = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "ana" });
    expect(pairing.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
    expect(pairings.get(pairing.pairingId)?.state).toBe("waiting");
    // Another connection's message, or one with other words, claims nothing.
    expect(pairings.claim(message(pairing.code, { connectionId: "c2" }))).toBe(false);
    expect(pairings.claim(message(`hello ${pairing.code}`))).toBe(false);
    // Typed in lower case with a dash, on the first line, it is the code.
    expect(pairings.claim(message(`${pairing.code.slice(0, 4).toLowerCase()}-${pairing.code.slice(4)}\nsent from my phone`))).toBe(true);
    expect(pairings.get(pairing.pairingId)).toMatchObject({ state: "claimed", pairing: { claimedBy: "77" } });
    expect(pairings.claim(message(pairing.code, { externalSenderId: "88" }))).toBe(false);
    now += PAIRING_TTL_MS * 3;
    // A claimed pairing waits for the operator however long they take.
    expect(pairings.get(pairing.pairingId)?.state).toBe("claimed");
    pairings.end(pairing.pairingId);
    expect(pairings.get(pairing.pairingId)).toBeUndefined();
  });

  it("keeps at most a hundred waiting, the oldest dropped, and forgets ones long expired", () => {
    let now = 0;
    const pairings = new PairingRegistry(() => now);
    const first = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "p0" });
    for (let index = 1; index < 100; index += 1) pairings.start({ connectionId: "c1", workspaceId: "w", principalId: `p${index}` });
    expect(pairings.get(first.pairingId)).toBeDefined();
    pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "p100" });
    expect(pairings.get(first.pairingId)).toBeUndefined();
    const old = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "late" });
    now += PAIRING_TTL_MS * 2;
    pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "new" });
    expect(pairings.get(old.pairingId)).toBeUndefined();
  });

  it("refuses an expired code, an unverified email, and anything not a message", () => {
    let now = 0;
    const pairings = new PairingRegistry(() => now);
    const pairing = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "ana" });
    expect(pairings.claim(message(pairing.code, { senderAuthentication: "fail" }))).toBe(false);
    expect(pairings.claim(message(pairing.code, { kind: "interaction" }))).toBe(false);
    now += PAIRING_TTL_MS;
    expect(pairings.get(pairing.pairingId)?.state).toBe("expired");
    expect(pairings.claim(message(pairing.code))).toBe(false);
  });

  it("accepts /start <code> and /link <code> (with or without @bot and dashes) and records the sender's platform name", () => {
    const pairings = new PairingRegistry(() => 0);
    const viaStart = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "ana" });
    const dashed = `${viaStart.code.slice(0, 4)}-${viaStart.code.slice(4)}`;
    expect(pairings.claim(message(`/start ${dashed}`, { senderName: "Ana Smith (@ana)" }))).toBe(true);
    expect(pairings.get(viaStart.pairingId)).toMatchObject({
      state: "claimed",
      pairing: { claimedBy: "77", claimedName: "Ana Smith (@ana)" },
    });

    const viaLink = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "bo" });
    expect(pairings.claim(message(`/link@tavi_bot ${viaLink.code.toLowerCase()}`, { externalSenderId: "88" }))).toBe(true);
    expect(pairings.get(viaLink.pairingId)).toMatchObject({ state: "claimed", pairing: { claimedBy: "88" } });

    const bare = pairings.start({ connectionId: "c1", workspaceId: "w", principalId: "cy" });
    expect(pairings.claim(message("/start"))).toBe(false);
    expect(pairings.claim(message(`/link extra ${bare.code}`))).toBe(false);
    expect(pairings.claim(message(bare.code, { authorKind: "bot" }))).toBe(false);
    expect(pairings.claim(message(bare.code, { forwarded: { origin: "other" } }))).toBe(false);
    expect(pairings.claim(message(bare.code, { senderName: "A".repeat(120) }))).toBe(true);
    expect(pairings.get(bare.pairingId)?.pairing.claimedName?.length).toBe(80);
  });
});
