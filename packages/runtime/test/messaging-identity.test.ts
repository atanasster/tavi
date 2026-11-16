import type { MessagingIdentityBinding, MessagingIdentityBindingRepositoryPort } from "@tavi/contracts";
import { resolveSenderActor } from "@tavi/runtime";

import { describe, expect, it } from "vitest";

/**
 * `resolveSenderActor` — a pure function over
 * `MessagingIdentityBindingRepositoryPort`, tested directly against a
 * fake repository rather than through `MessagingService.ingest()`
 * (`apps/cli/test/channels/messaging-acceptance.test.ts`), since
 * `MessagingIngestReceipt` only ever surfaces `resolvedPrincipalId` — a
 * bare string — and nothing at that layer can observe the full
 * `MemoryActor` shape this function actually builds.
 */

function fakeBindings(rows: readonly MessagingIdentityBinding[]): MessagingIdentityBindingRepositoryPort {
  const byKey = new Map(rows.map((row) => [`${row.connectionId}::${row.externalSenderId}`, row]));
  return {
    bind: () => {
      throw new Error("not used by this test");
    },
    setTrustUnverified: () => {
      throw new Error("not used by this test");
    },
    unbind: () => {
      throw new Error("not used by this test");
    },
    senderOf: () => {
      throw new Error("not used by this test");
    },
    get: async (connectionId, externalSenderId) => byKey.get(`${connectionId}::${externalSenderId}`),
    list: async () => rows,
  };
}

describe("resolveSenderActor", () => {
  it("returns undefined for an unbound/unknown/forged sender — denial by absence", async () => {
    const actor = await resolveSenderActor(fakeBindings([]), "conn-a", "user-1");
    expect(actor).toBeUndefined();
  });

  it("builds a full operator-authority MemoryActor from the binding row, not from the event", async () => {
    const actor = await resolveSenderActor(
      fakeBindings([
        {
          connectionId: "conn-a",
          externalSenderId: "user-1",
          workspaceId: "w1",
          principalId: "alice",
          approvedBy: "operator",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      "conn-a",
      "user-1",
    );
    expect(actor).toEqual({
      principalId: "alice",
      workspaceId: "w1",
      caller: "messaging:conn-a",
      authority: "operator",
    });
  });

  it("only resolves the exact (connectionId, externalSenderId) pair bound — a matching sender id on a different connection is unbound", async () => {
    const bindings = fakeBindings([
      {
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(await resolveSenderActor(bindings, "conn-b", "user-1")).toBeUndefined();
  });
});
