import { MODEL_ROLES } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { chatCommand, mayBecomeCommand } from "../../src/tui/commands.js";
import { enterField, formOutcome, formRequest, looksLikeCredential, openForm, type FormStep } from "../../src/tui/forms.js";

/** `tavi chat`'s forms: what opens one, how its fields are asked, and what it sends. */

const asked = (step: FormStep | ReturnType<typeof enterField>) => {
  if (step.kind !== "ask") throw new Error(`expected a field to be asked, got ${JSON.stringify(step)}`);
  return step.state;
};

describe("form commands", () => {
  it("opens a form with the words after its command, and refuses a command's family word going on with anything else", () => {
    expect(chatCommand("/credentials set")).toEqual({ kind: "form", form: "credentials-set", words: [] });
    expect(chatCommand("/models set-default  local   llama3 ")).toEqual({
      kind: "form",
      form: "models-set-default",
      words: ["local", "llama3"],
    });
    expect(chatCommand("/credentials")).toEqual({ kind: "pane", pane: "credentials" });
    expect(chatCommand("/models")).toEqual({ kind: "pane", pane: "models" });
    // A command's first word going on with what is none of its forms is a typo, not a prompt.
    expect(chatCommand("/models remove local")).toEqual({ kind: "unknown", typed: "/models remove local" });
    expect(chatCommand("/agents all")).toEqual({ kind: "unknown", typed: "/agents all" });
    expect(chatCommand("/models-add")).toEqual({ kind: "unknown", typed: "/models-add" });
    expect(chatCommand("/etc/hosts: what is in it?")).toBeUndefined();
    // The chat's own model: named, or a connection and a model.
    expect(chatCommand("/model")).toEqual({ kind: "model" });
    expect(chatCommand("/model or  gpt-4.1")).toEqual({ kind: "model", target: { connectionId: "or", model: "gpt-4.1" } });
    expect(chatCommand("/model gpt-4.1")).toEqual({ kind: "unknown", typed: "/model gpt-4.1" });
  });

  it("lets a form's command go on with its words while a run is going, and nothing else", () => {
    expect(mayBecomeCommand("/models set-r")).toBe(true);
    expect(mayBecomeCommand("/models set-role main local")).toBe(true);
    expect(mayBecomeCommand("/models  ")).toBe(false);
    expect(mayBecomeCommand("/agents all")).toBe(false);
  });
});

describe("filling a form", () => {
  it("asks every field, optional ones too, when opened bare; and only what the words leave out otherwise", () => {
    let state = asked(openForm("models-set-default", []));
    expect(state.index).toBe(0);
    state = asked(enterField(state, " local "));
    // Optional, and asked: Enter on nothing leaves it out.
    expect(state.index).toBe(1);
    expect(enterField(state, "")).toEqual({ kind: "done", id: "models-set-default", values: { connectionId: "local" } });

    // Words given: the optional model is not asked for.
    expect(openForm("models-set-default", ["local"])).toEqual({
      kind: "done",
      id: "models-set-default",
      values: { connectionId: "local" },
    });
    const role = asked(openForm("models-set-role", ["main"]));
    expect(role).toMatchObject({ index: 1, values: { role: "main" } });
  });

  it("asks a field again when the answer does not do, saying why and never what was typed", () => {
    const state = asked(openForm("models-set-role", []));
    expect(enterField(state, "chief")).toEqual({ kind: "again", reason: `role must be one of ${MODEL_ROLES.join(", ")}` });
    expect(enterField(state, "  ")).toEqual({ kind: "again", reason: "role is needed (Esc cancels the form)" });
    expect(openForm("models-set-role", ["chief"])).toEqual({ kind: "refused", reason: `role must be one of ${MODEL_ROLES.join(", ")}` });
  });

  it("never takes a credential's value from the command line, and keeps it as typed", () => {
    expect(openForm("credentials-set", ["openai", "sk-live-abcdef123456"])).toEqual({
      kind: "refused",
      reason: "/credentials set takes at most 1 word: the value is typed in the form, hidden, never on the command line",
    });
    const value = asked(openForm("credentials-set", ["openai"]));
    expect(value.index).toBe(1);
    expect(enterField(value, " sk-live-abcdef123456 ")).toEqual({
      kind: "done",
      id: "credentials-set",
      values: { reference: "openai", value: " sk-live-abcdef123456 " },
    });
  });

  it("asks a name field again when it is not the shape the owner accepts, never echoing it", () => {
    const state = asked(openForm("credentials-set", []));
    expect(enterField(state, "Not A Reference")).toEqual({
      kind: "again",
      reason: "reference must be a reference like openai or stripe.apiKey (letters, digits, . _ -)",
    });
    expect(enterField(state, `a${"b".repeat(128)}`)).toMatchObject({ kind: "again" });
    expect(openForm("models-test", ["Local!"])).toEqual({
      kind: "refused",
      reason: "connectionId must be a connection id like openai or local (lower-case letters, digits, . _ -)",
    });
  });

  it("refuses a credential where a name belongs", () => {
    const refused = openForm("models-add", ["local", "http://127.0.0.1:11434/v1", "sk-live-abcdef123456"]);
    expect(refused).toMatchObject({ kind: "refused", reason: expect.stringContaining("a name, not a credential") });
    const state = asked(openForm("credentials-set", []));
    expect(enterField(state, "sk-live-abcdef123456")).toMatchObject({
      kind: "again",
      reason: expect.stringContaining("a name, not a credential"),
    });
  });
});

describe("what a form sends, and says", () => {
  it("builds each form's request, with the workspace and only the fields given", () => {
    expect(formRequest("credentials-set", { reference: "openai", value: "v" }, "default")).toEqual({
      command: "credentials",
      payload: { action: "set", reference: "openai", value: "v" },
      timeoutMs: 10_000,
    });
    expect(formRequest("models-add", { connectionId: "local", baseUrl: "http://h/v1", credentialRef: "local-key" }, "w").payload).toEqual({
      action: "add",
      workspaceId: "w",
      connectionId: "local",
      baseUrl: "http://h/v1",
      credentialRef: "local-key",
    });
    expect(formRequest("models-set-role", { role: "main", connectionId: "local", model: "m" }, "w").payload).toEqual({
      action: "set-role",
      workspaceId: "w",
      role: "main",
      connectionId: "local",
      model: "m",
    });
    // A test outlasts the transport's default deadline: its own is 10 s.
    expect(formRequest("models-test", { connectionId: "local" }, "w")).toMatchObject({
      payload: { action: "test", connectionId: "local" },
      timeoutMs: 30_000,
    });
  });

  it("says what was done, a restart when the owner says one is needed, and never a credential's value", () => {
    const stored = formOutcome("credentials-set", { reference: "openai", value: "sk-live-abcdef123456" }, { stored: "openai" });
    expect(stored.join("\n")).not.toContain("sk-live");
    expect(formOutcome("models-set-default", { connectionId: "local" }, { result: {}, restartRequired: true })).toEqual([
      "✓ the workspace's default model is local (its default model)",
      "  ⚠ restart `tavi serve` for this to take effect: the owner runs the target it resolved when it started",
    ]);
    expect(formOutcome("models-set-default", { connectionId: "local", model: "m" }, { result: {}, restartRequired: false })).toEqual([
      "✓ the workspace's default model is local/m",
    ]);
    // An added connection needs a restart only when the owner runs through it: its provider was composed with the old one.
    expect(
      formOutcome(
        "models-add",
        { connectionId: "local", baseUrl: "http://h/v1", credentialRef: "k" },
        { result: {}, restartRequired: true },
      ),
    ).toEqual([
      "✓ connection local added: http://h/v1, credential k",
      "  ⚠ restart `tavi serve` for this to take effect: the owner's running connection was composed with its old endpoint and credential",
    ]);
    // Role main is what the owner resolved at startup: a restart when the owner says so.
    expect(
      formOutcome("models-set-role", { role: "main", connectionId: "local", model: "m" }, { result: {}, restartRequired: true }),
    ).toEqual([
      "✓ role main is bound to local/m",
      "  ⚠ restart `tavi serve` for this to take effect: the owner resolved role main when it started",
    ]);
    expect(
      formOutcome("models-set-role", { role: "main", connectionId: "local", model: "m" }, { result: {}, restartRequired: false }),
    ).toEqual(["✓ role main is bound to local/m"]);
    // Any other role is said to be no part of the owner's runs, whatever the answer.
    for (const restartRequired of [true, false]) {
      expect(formOutcome("models-set-role", { role: "fast", connectionId: "local", model: "m" }, { result: {}, restartRequired })).toEqual([
        "✓ role fast is bound to local/m",
        "  the owner's own runs resolve role main only; nothing it runs asks for this role yet",
      ]);
    }
    expect(
      formOutcome("models-test", { connectionId: "local" }, { ok: true, modelId: "m", latencyMs: 42, capabilities: ["chat", "tools"] }),
    ).toEqual(["✓ local/m answered in 42 ms; observed: chat, tools"]);
    expect(formOutcome("models-test", { connectionId: "local", model: "m" }, { ok: false, capabilities: [], message: "HTTP 401" })).toEqual(
      ["✗ local/m failed the test: HTTP 401"],
    );
  });

  it("knows a credential's shape in what is typed", () => {
    expect(looksLikeCredential("here is my key sk-live-abcdef123456")).toBe(true);
    expect(looksLikeCredential("Authorization: Bearer abcdefghijklmnop")).toBe(true);
    expect(looksLikeCredential("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksLikeCredential("what is a token, and where does tavi keep one?")).toBe(false);
    expect(looksLikeCredential("/chat connect postgres://admin:p@ssw0rd@db")).toBe(true);
    expect(looksLikeCredential("/chat connect postgres://admin:$ecretP4ss@db")).toBe(true);
    expect(looksLikeCredential("install https://registry.npmjs.org:443/@tavi/contracts")).toBe(false);
    expect(looksLikeCredential("use postgres://user:${DB_PASS}@db/app")).toBe(false);
  });
});
