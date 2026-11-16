import { describe, expect, it } from "vitest";
import { addModelConnection, connectionProblem, rebindModel, type ConnectionForm } from "../../../src/features/settings/model-setup.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
const form: ConnectionForm = {
  connectionId: "account",
  label: "Account",
  baseUrl: "https://example.test/v1",
  localOnly: false,
  requiresKey: true,
  key: "secret",
};
function owner(fail?: string, taken = false) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const p = payload as Record<string, unknown>;
      sent.push({ command, payload: p });
      if (p["action"] === fail) return { ok: false, error: { code: "NOT_AUTHORIZED", message: "set its value again through this page" } };
      return {
        ok: true,
        result:
          command === "credentials" && p["action"] === "list"
            ? { credentials: taken ? ["account.apiKey"] : [], unusable: [] }
            : p["action"] === "list"
              ? []
              : p["action"] === "discover"
                ? { models: [{}] }
                : { restartRequired: true },
      };
    },
  };
  return { client, sent };
}
describe("connection setup", () => {
  it("stores before binding and discovering, then offers a target", async () => {
    const fake = owner();
    const result = await addModelConnection(fake.client, form);
    expect(fake.sent.slice(2).map((row) => `${row.command}:${row.payload["action"]}`)).toEqual([
      "credentials:set",
      "models:add",
      "models:discover",
    ]);
    expect(fake.sent[3]?.payload).toMatchObject({ credentialRef: fake.sent[2]?.payload["reference"], baseUrl: form.baseUrl });
    expect(result).toMatchObject({ ok: true, value: expect.stringContaining("restart") });
    expect(result).toMatchObject({ value: expect.stringContaining("Discovered 1 model.") });
  });
  it("never replaces a taken key during add", async () => {
    const fake = owner(undefined, true);
    expect((await addModelConnection(fake.client, form)).ok).toBe(false);
    expect(fake.sent.every((row) => row.payload["action"] === "list")).toBe(true);
  });
  it("stops after a credential refusal and explains a partially saved key", async () => {
    const denied = owner("set");
    await addModelConnection(denied.client, form);
    expect(denied.sent.some((row) => row.payload["action"] === "add")).toBe(false);
    expect(await addModelConnection(owner("add").client, form)).toMatchObject({
      ok: false,
      message: expect.stringContaining("key was stored"),
    });
    expect(await addModelConnection(owner("discover").client, form)).toMatchObject({
      ok: true,
      value: expect.stringContaining("discovery failed"),
    });
  });
  it("uses an explicit public placeholder for a keyless local server", async () => {
    const fake = owner();
    await addModelConnection(fake.client, { ...form, key: "", requiresKey: false, localOnly: true, baseUrl: "http://localhost:11434/v1" });
    expect(fake.sent[2]?.payload).toMatchObject({ value: "local-no-key" });
  });
  it("validates before any owner mutation", () => {
    expect(connectionProblem({ ...form, baseUrl: "https://user:password@example.test" })).toContain("HTTP(S)");
    expect(connectionProblem({ ...form, key: "" })).toContain("key");
  });
  it("surfaces the new-origin remedy and retains restart notes for rebinding", async () => {
    const refused = owner("rebind");
    expect(await rebindModel(refused.client, "account", "stored.apiKey", "")).toMatchObject({
      ok: false,
      message: expect.stringContaining("set its value again"),
    });
    expect(refused.sent).toHaveLength(1);
    const rotated = owner();
    expect(await rebindModel(rotated.client, "account", "account.apiKey", "new-key")).toMatchObject({
      ok: true,
      value: expect.stringContaining("restart"),
    });
    expect(rotated.sent.map((row) => row.payload["action"])).toEqual(["set", "rebind"]);
  });
});

it("isolates credentials when two tabs race to create the same connection", async () => {
  const credentials = new Map<string, string>();
  let winningRef: string | undefined;
  const client: SettingsClient = {
    request: async (command, payload) => {
      const p = payload as Record<string, unknown>;
      // Both preflight reads are intentionally stale/empty.
      if (p["action"] === "list") return { ok: true, result: command === "credentials" ? { credentials: [], unusable: [] } : [] };
      if (command === "credentials") {
        credentials.set(String(p["reference"]), String(p["value"]));
        return { ok: true, result: {} };
      }
      if (p["action"] === "add") {
        if (winningRef) return { ok: false, error: { code: "INVALID_INPUT", message: "ordinary update never rebinds" } };
        winningRef = String(p["credentialRef"]);
      }
      return { ok: true, result: { models: [] } };
    },
  };
  const outcomes = await Promise.all([
    addModelConnection(client, { ...form, key: "first" }),
    addModelConnection(client, { ...form, key: "second" }),
  ]);
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false]);
  expect(credentials.size).toBe(2);
  expect(credentials.get(winningRef!)).toBe("first");
  expect(outcomes[1]).toMatchObject({ message: expect.stringContaining("key was stored") });
});
