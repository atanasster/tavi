import type { MemoryProvider } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describeMemoryDeclaration } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { memoryProviderAnswer, memoryProviderCommand } from "../../src/features/memory/provider-owner.js";
import { MemoryProviderRegistry } from "../../src/features/memory/providers.js";

/** An external memory provider's disclosures, in a Bulgarian workspace: said in its language, and English for an English one. */

const PROVIDER = "fixture.memorybg";
const declaration = {
  abi: "tavi.memory/1" as const,
  capabilities: ["recall" as const],
  index: "host" as const,
  receives: ["conversation" as const],
};

function fixture(locale: "bg" | "en") {
  const registry = new MemoryProviderRegistry({
    settingsOf: async () => ({ provider: PROVIDER, providerEgress: { records: false, conversation: false, includePersonal: false } }),
  });
  registry.install(PROVIDER, {
    kind: "plugin",
    provider: { recall: async () => ({ hits: [] }), status: () => null } as unknown as MemoryProvider,
    declaration,
  });
  const record = {
    workspaceId: "default",
    settings: { locale, memory: { provider: PROVIDER } },
    revision: 1,
    updatedAt: null,
    actor: null,
  };
  const deps = {
    settings: { get: async () => record, set: async () => record } as never,
    providers: registry,
    sync: { pendingRemovals: async () => 0, fullSync: async () => undefined, egressNarrowed: async () => undefined } as never,
    actor: "operator:ui",
    now: () => "2026-01-01T00:00:00.000Z",
  };
  return deps;
}

describe("a memory provider's disclosures in Bulgarian", () => {
  it("lists the provider with its disclosure and personal memory's in the workspace's language", async () => {
    const bg = coreIn("bg");
    const answer = await memoryProviderAnswer(fixture("bg"), "default");
    expect(answer.providers.find((provider) => provider.id === PROVIDER)?.disclosure).toBe(describeMemoryDeclaration(declaration, bg));
    expect(answer.personalDisclosure).toBe(bg("memory.disclosure.personal", { provider: PROVIDER }));
  });

  it("asks before a switch turns on with the disclosure in Bulgarian, keeping the error's English message", async () => {
    const asked = memoryProviderCommand(fixture("bg"), "default", { action: "egress", field: "conversation", on: true } as never);
    await expect(asked).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const error = (await asked.catch((caught: unknown) => caught)) as { message: string; details: { disclosure: string } };
    expect(error.details.disclosure).toContain("Ако включиш conversation, fixture.memorybg ще получава това, което казваш");
    expect(error.message).toBe(
      `${describeMemoryDeclaration(declaration, coreEnglish)} Turning conversation on sends fixture.memorybg your what you say: each recall's query and the chat spans it drafts proposals from. Confirm to go on.`,
    );
  });

  it("is English, as before, in an English workspace", async () => {
    const asked = memoryProviderCommand(fixture("en"), "default", { action: "egress", field: "conversation", on: true } as never);
    const error = (await asked.catch((caught: unknown) => caught)) as { message: string; details: { disclosure: string } };
    expect(`${error.details.disclosure} Confirm to go on.`).toBe(error.message);
  });
});
