// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { ChannelDescriptor } from "@tavi/contracts";

import { ChannelsSettings } from "../../../src/features/settings/ChannelsSettings.js";
import { lifecycleNotice, type BrowsedModel } from "../../../src/features/settings/models-api.js";
import { translateNow } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";
import { inBulgarian } from "../../support/bulgarian.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Settings in Bulgarian: the model lifecycle clauses, a counted plural, the units, and a pairing with someone else. */

inBulgarian();

const model = (lifecycle: BrowsedModel["lifecycle"]): BrowsedModel => ({
  connectionId: "openai",
  modelId: "a",
  provenance: "live",
  state: "available",
  capabilities: [],
  connectionLabel: "OpenAI",
  stale: false,
  ...(lifecycle === undefined ? {} : { lifecycle }),
});

describe("Settings in Bulgarian", () => {
  it("says a retired model's lifecycle after „Този модел“, and counts places in the replaced line", () => {
    const at = { catalogVersion: "v", checkedAt: "2026-11-01T00:00:00.000Z" };
    const notice = lifecycleNotice(model({ status: "deprecated", retiresOn: "2026-11-19", ...at }), "2026-11-20");
    expect(notice?.label).toBe("Спрян");
    expect(translateNow("chat.model.lifecycle", { what: notice?.text ?? "" })).toBe("Този модел е спрян на 2026-11-19.");
    expect(translateNow("settings.lifecycle.replaced", { from: "a", to: "b", count: 1 })).toBe("Смених a с b на 1 място.");
    expect(translateNow("settings.lifecycle.replaced", { from: "a", to: "b", count: 3 })).toBe("Смених a с b на 3 места.");
  });

  it("writes sizes in КБ and МБ, never in the Latin binary units", () => {
    const sizes = [
      translateNow("settings.setup.keyTooLong"),
      translateNow("settings.credentials.tooLong"),
      translateNow("settings.video.nativeHint", { minutes: 5, size: 20 }),
    ];
    for (const text of sizes) expect(text).not.toMatch(/KiB|MiB|KB|MB/);
    expect(sizes[0]).toContain("16\u00a0КБ");
    expect(sizes[2]).toContain("20\u00a0МБ");
  });

  it("asks about someone else's claimed code without assuming who they are", async () => {
    const pager: ChannelDescriptor = {
      providerId: "pager",
      label: "Pager",
      kind: "sms",
      description: "Pages people.",
      settings: [],
      auth: { kind: "secrets", fields: [{ key: "apiKey", label: "API key" }] },
      sender: { label: "Phone number", placeholder: "+15550100", pattern: "\\+\\d+", normalize: "e164", authentication: "provider" },
      target: { label: "Phone number", placeholder: "+15550100", pattern: "\\+\\d+", normalize: "e164" },
    };
    const answers: Record<string, unknown> = {
      catalog: { channels: [pager] },
      list: {
        connections: [
          {
            connectionId: "pager-1",
            providerId: "pager",
            label: "Pager",
            workspaceId: "default",
            accountIdentity: "Pager",
            settings: {},
            secretsStored: { apiKey: true },
            enabled: true,
            authState: "none",
            status: { state: "running" },
          },
        ],
        oauthClients: {},
        credentialsEncrypted: true,
        ingress: { host: "127.0.0.1", port: 8025 },
      },
      people: { people: [], operator: "operator" },
      pair: { pairingId: "00000000-0000-4000-8000-000000000001", code: "ABCDEFGH", expiresAt: "2026-10-09T10:10:00.000Z" },
      pairing: { state: "claimed", sender: "+15550123", connectionId: "pager-1", principalId: "bo" },
    };
    const client: SettingsClient = {
      request: async (_command, payload) => {
        const action = (payload as Record<string, unknown>)["action"] as string;
        return { ok: true, result: answers[action] ?? { ok: true } };
      },
    };
    const host = await mount(
      <InWorkspace client={client} workspaceId="default">
        <ChannelsSettings people />
      </InWorkspace>,
    );
    const input = host.querySelector<HTMLInputElement>('[aria-label="ID на човека"]');
    if (input === null) throw new Error("no person ID field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "bo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = (text: string): HTMLButtonElement | undefined =>
      [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
    await act(async () => button("Свържи с код")?.click());
    await act(async () => button("Провери сега")?.click());
    expect(host.textContent).toContain("Съобщение от +15550123 в Pager съдържаше кода. Да разреша ли този човек като bo?");
    expect(button("Не е този човек")).toBeDefined();
    expect(host.textContent).not.toContain("Не е той");
  });
});
