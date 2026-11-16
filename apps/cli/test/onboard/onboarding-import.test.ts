import { describe, expect, it } from "vitest";
import { partialFake } from "@tavi/test-support";

import { parseArgs } from "../../src/cli/parse.js";
import { describeImport, findImports, parseDotenv, parseJson5, runImport, type ImportFiles } from "../../src/features/onboard/import.js";
import type { OnboardTransport } from "../../src/features/onboard/transport.js";

/**
 * Importing another agent's setup:
 * OpenClaw's JSON5 config and Hermes's YAML, each with its `.env`, read for
 * model connections and a Telegram bot; described by name and place only, a
 * key copied only with consent, the other agent's default made Tavi's only
 * once it verifies and only while Tavi has no working model.
 */

const HOME = "/home/test";
const files = (contents: Record<string, string>, env: Record<string, string> = {}): ImportFiles => ({
  home: HOME,
  env,
  readText: async (path) => contents[path],
});

const OPENCLAW = `// OpenClaw's own config, as its wizard writes it
{
  env: { vars: { MY_STUDIO_KEY: "sk-studio-secret" } },
  agents: { defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.5" } } }, /* the default */
  models: {
    providers: {
      "my-studio": { baseUrl: "https://studio.example.ts.net/v1", apiKey: "\${MY_STUDIO_KEY}", api: "openai-completions", models: [{ id: "qwen3.8", name: "Qwen3.8" },], },
      local: { baseUrl: "http://localhost:11434/v1", auth: "none", models: [{ id: "qwen3:8b" }] },
      claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "sk-ant-inline" },
      vault: { baseUrl: "https://vault.example/v1", apiKey: { source: "store", id: "vault" } },
    },
  },
  channels: { telegram: { botToken: "123:tg-secret" } },
}`;

describe("reading another agent's files", () => {
  it("reads JSON5 with comments and trailing commas, and .env lines with quotes and export", () => {
    expect(parseJson5(`{ a: 1, // one\n b: "//not a comment", /* c */ d: [1, 2,], }`)).toEqual({ a: 1, b: "//not a comment", d: [1, 2] });
    // What YAML would read otherwise: compact keys, single quotes with escapes, hex and signed numbers, duplicates.
    expect(parseJson5(`{a:1,'b':'it\\'s','c':'C:\\\\x',d:0x1F,e:-.5,f:+1,a:2,g:"\\u0041\\x42",}`)).toEqual({
      a: 2,
      b: "it's",
      c: "C:\\x",
      d: 31,
      e: -0.5,
      f: 1,
      g: "AB",
    });
    expect(() => parseJson5("{ a: [1, }")).toThrow();
    expect([
      ...parseDotenv(`# keys\nexport OPENROUTER_API_KEY="sk-or-1"\nTELEGRAM_BOT_TOKEN=123:abc # the bot\nQUOTED="v" # note\nEMPTY=\n`),
    ]).toEqual([
      ["OPENROUTER_API_KEY", "sk-or-1"],
      ["TELEGRAM_BOT_TOKEN", "123:abc"],
      ["QUOTED", "v"],
    ]);
  });

  it("follows OPENCLAW_CONFIG_PATH and a relative tokenFile, and imports a keyless remote server without asking", async () => {
    const config = `{ models: { providers: { lan: { baseUrl: "http://10.0.0.5:8000/v1", auth: "none", models: [{ id: "llama" }] }, leaky: { baseUrl: "https://user:pw@llm.example/v1?api-key=sk-in-url" } } }, channels: { telegram: { tokenFile: "secrets/bot.txt" } } }`;
    const found = await findImports(
      files(
        { "/etc/claw/cfg.json5": config, "/etc/claw/secrets/bot.txt": "789:from-file\n" },
        { OPENCLAW_CONFIG_PATH: "/etc/claw/cfg.json5" },
      ),
      "openclaw",
    );
    const [claw] = found;
    expect(claw?.finding.telegramFrom).toBe("secrets/bot.txt");
    expect(claw?.secrets.get("telegram")).toBe("789:from-file");
    expect(claw?.finding.connections.find((connection) => connection.name === "lan")).toMatchObject({
      keyless: true,
      baseUrl: "http://10.0.0.5:8000/v1",
    });
    const leaky = claw?.finding.connections.find((connection) => connection.name === "leaky");
    expect(leaky).toMatchObject({
      baseUrl: "https://llm.example/v1",
      problem: "its endpoint carries credentials or a query, which Tavi does not store",
    });
    const said = `${JSON.stringify(claw?.finding)}${describeImport(claw!.finding).join("\n")}`;
    for (const secret of ["sk-in-url", "user:pw", "789:from-file"]) expect(said).not.toContain(secret);
    expect(describeImport(claw!.finding).join("\n")).toContain("✓ lan → Custom at http://10.0.0.5:8000/v1, llama; key: none needed");
    const { port, sent } = transport();
    const outcome = await runImport(port, claw!, { workspaceId: "default", secrets: false }, () => {});
    expect(outcome.connected).toEqual(["custom"]);
    expect(sent.find((entry) => entry.payload["action"] === "connect-key")?.payload).toMatchObject({
      key: "local-no-key",
      baseUrl: "http://10.0.0.5:8000/v1",
    });
  });

  it("finds OpenClaw's connections and bot, naming where each key is and never what it is", async () => {
    const found = await findImports(
      files({ [`${HOME}/.openclaw/openclaw.json`]: OPENCLAW, [`${HOME}/.openclaw/.env`]: "OPENROUTER_API_KEY=sk-or-from-env\n" }),
    );
    expect(found).toHaveLength(1);
    const [openclaw] = found;
    expect(
      openclaw?.finding.connections.map((connection) => [connection.name, connection.preset, connection.problem === undefined]),
    ).toEqual([
      ["my-studio", "custom", true],
      ["local", "ollama", true],
      ["claude", "custom", false],
      ["vault", "custom", false],
      ["openrouter", "openrouter", true],
    ]);
    expect(openclaw?.finding.connections.find((connection) => connection.name === "openrouter")).toMatchObject({
      isDefault: true,
      model: "anthropic/claude-sonnet-4.5",
      keyFrom: "OPENROUTER_API_KEY in ~/.openclaw/.env",
    });
    expect(openclaw?.finding.connections.find((connection) => connection.name === "my-studio")?.keyFrom).toBe(
      "MY_STUDIO_KEY in ~/.openclaw/openclaw.json (env.vars)",
    );
    expect(openclaw?.finding.telegramFrom).toBe("~/.openclaw/openclaw.json (channels.telegram.botToken)");
    expect(openclaw?.secrets.get("openrouter")).toBe("sk-or-from-env");
    const said = [
      JSON.stringify(openclaw?.finding),
      describeImport(openclaw?.finding ?? { source: "openclaw", root: "", connections: [] }).join("\n"),
    ].join("\n");
    for (const secret of ["sk-studio-secret", "sk-or-from-env", "123:tg-secret", "sk-ant-inline"]) expect(said).not.toContain(secret);
    expect(said).toContain("anthropic-messages endpoint is not OpenAI-compatible chat");
    expect(said).toContain("OpenClaw's own credential store is never read");
  });

  it("finds Hermes's default, its named and legacy providers, and the bot in its .env", async () => {
    const config = `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\nproviders:\n  my-gateway:\n    api: https://llm.internal.example.com/v1\n    api_key: sk-gateway\n    models:\n      - my-finetune-v2\ncustom_providers:\n  - name: old-box\n    base_url: http://localhost:1234/v1\n`;
    const found = await findImports(
      files(
        { "/opt/hermes/config.yaml": config, "/opt/hermes/.env": "OPENROUTER_API_KEY=sk-or-hermes\nTELEGRAM_BOT_TOKEN=456:hermes-bot\n" },
        { HERMES_HOME: "/opt/hermes" },
      ),
      "hermes",
    );
    const [hermes] = found;
    expect(hermes?.finding.root).toBe("/opt/hermes");
    expect(
      hermes?.finding.connections.map((connection) => [connection.name, connection.preset, connection.model, connection.isDefault]),
    ).toEqual([
      ["my-gateway", "custom", "my-finetune-v2", false],
      ["old-box", "lmstudio", undefined, false],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.7", true],
    ]);
    expect(hermes?.finding.telegramFrom).toBe("TELEGRAM_BOT_TOKEN in /opt/hermes/.env");
    expect(hermes?.secrets.get("my-gateway")).toBe("sk-gateway");
    const nous = await findImports(files({ [`${HOME}/.hermes/config.yaml`]: "model:\n  provider: nous\n" }));
    expect(nous[0]?.finding.connections[0]).toMatchObject({ name: "nous", problem: "nous is a sign-in Tavi does not offer" });
  });

  it("finds nothing where neither is installed, and says so for an unreadable config", async () => {
    expect(await findImports(files({}))).toEqual([]);
    const broken = await findImports(files({ [`${HOME}/.openclaw/openclaw.json`]: "{ not: [json" }));
    expect(broken[0]?.finding.connections[0]?.problem).toBe("its config could not be read");
  });
});

function transport(options: { readonly attached?: boolean; readonly modelDone?: boolean; readonly verifies?: boolean } = {}) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const port = partialFake<OnboardTransport>({
    attached: options.attached ?? false,
    request: async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const action = payload["action"];
      if (command === "onboarding" && action === "connect-key") return { connectionId: String(payload["preset"]), models: ["m1", "m2"] };
      if (command === "onboarding" && action === "status")
        return {
          steps: [
            { kind: "model", state: options.modelDone === true ? "done" : "todo", detail: "" },
            { kind: "channels", state: "todo", detail: "" },
          ],
        };
      if (command === "onboarding" && action === "verify")
        return { results: [{ ok: options.verifies !== false, ...(options.verifies === false ? { advice: "The key was refused." } : {}) }] };
      if (command === "channels" && action === "catalog")
        return { channels: [{ providerId: "telegram", auth: { kind: "secrets", fields: [{ key: "token" }] } }] };
      if (command === "channels" && action === "list") return { connections: [] };
      if (command === "channels" && action === "save") return { connectionId: "telegram" };
      if (command === "channels" && action === "probe") return { ok: true, detail: "Bot @imported_bot." };
      return {};
    },
  });
  return { port, sent, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

describe("importing", () => {
  const found = async () =>
    (
      await findImports(
        files({ [`${HOME}/.openclaw/openclaw.json`]: OPENCLAW, [`${HOME}/.openclaw/.env`]: "OPENROUTER_API_KEY=sk-or-from-env\n" }),
      )
    )[0]!;

  it("without consent imports only what needs no key, and copies no secret", async () => {
    const { port, sent } = transport();
    const said: string[] = [];
    const outcome = await runImport(port, await found(), { workspaceId: "default", secrets: false }, (line) => void said.push(line));
    expect(outcome.connected).toEqual(["ollama"]);
    expect(outcome.withoutKey).toEqual(["my-studio", "openrouter"]);
    expect(outcome.telegram).toBe("declined");
    expect(JSON.stringify(sent)).not.toContain("sk-");
    expect(sent.find((entry) => entry.payload["action"] === "connect-key")?.payload).toMatchObject({
      preset: "ollama",
      key: "local-no-key",
    });
  });

  it("with consent copies each key once, through connect-key, and makes the other agent's default Tavi's once it verifies", async () => {
    const { port, sent, actions } = transport();
    const outcome = await runImport(port, await found(), { workspaceId: "default", secrets: true }, () => {});
    expect(outcome.connected).toEqual(["custom", "ollama", "openrouter"]);
    expect(sent.find((entry) => entry.payload["preset"] === "custom")?.payload).toMatchObject({
      key: "sk-studio-secret",
      baseUrl: "https://studio.example.ts.net/v1",
    });
    expect(sent.find((entry) => entry.payload["preset"] === "openrouter")?.payload).toMatchObject({ key: "sk-or-from-env" });
    expect(sent.find((entry) => entry.payload["action"] === "verify")?.payload).toMatchObject({
      role: "main",
      target: { connectionId: "openrouter", model: "anthropic/claude-sonnet-4.5" },
    });
    expect(sent.find((entry) => entry.payload["action"] === "set-default")?.payload).toMatchObject({
      connectionId: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
    });
    expect(outcome.defaultSet).toBe("openrouter · anthropic/claude-sonnet-4.5");
    // Offline, the bot waits for an owner: no channel is touched.
    expect(outcome.telegram).toBe("needs-owner");
    expect(actions().some((action) => action.startsWith("channels:"))).toBe(false);
  });

  it("never moves a working default, nor sets one that fails its verify", async () => {
    const working = transport({ modelDone: true });
    await runImport(working.port, await found(), { workspaceId: "default", secrets: true }, () => {});
    expect(working.actions()).not.toContain("onboarding:verify");
    expect(working.actions()).not.toContain("models:set-default");
    const refused = transport({ verifies: false });
    const said: string[] = [];
    const outcome = await runImport(refused.port, await found(), { workspaceId: "default", secrets: true }, (line) => void said.push(line));
    expect(refused.actions()).not.toContain("models:set-default");
    expect(outcome.defaultSet).toBeUndefined();
    expect(said.join("\n")).toContain("did not answer: The key was refused.");
  });

  it("says a refused connection without its key, and a declined bot", async () => {
    const { port } = transport();
    const refusing = partialFake<OnboardTransport>({
      ...port,
      request: async (command: string, payload: Record<string, unknown>) => {
        if (command === "onboarding" && payload["action"] === "connect-key") throw new Error("OpenRouter refused the connection");
        return await (port.request as (command: string, payload: Record<string, unknown>) => Promise<unknown>)(command, payload);
      },
    });
    const said: string[] = [];
    await runImport(refusing, await found(), { workspaceId: "default", secrets: true }, (line) => void said.push(line));
    expect(said.join("\n")).toContain("✗ openrouter: OpenRouter refused the connection");
    expect(said.join("\n")).not.toContain("sk-or-from-env");
    const declined: string[] = [];
    await runImport(transport().port, await found(), { workspaceId: "default", secrets: false }, (line) => void declined.push(line));
    expect(declined.join("\n")).toContain("○ Telegram bot: its token was not copied");
  });

  it("adds and tests the bot on a running owner, leaving pairing to the channels step", async () => {
    const { port, sent } = transport({ attached: true });
    const said: string[] = [];
    const outcome = await runImport(port, await found(), { workspaceId: "default", secrets: true }, (line) => void said.push(line));
    expect(outcome.telegram).toBe("added");
    expect(sent.find((entry) => entry.payload["action"] === "save")?.payload).toMatchObject({
      providerId: "telegram",
      secrets: { token: "123:tg-secret" },
    });
    expect(said.join("\n")).toContain("✓ Telegram bot added (Bot @imported_bot.); pair yourself with tavi setup channels.");
    expect(said.join("\n")).not.toContain("123:tg-secret");
  });
});

describe("tavi onboard import", () => {
  it("parses --from, --dry-run and --with-secrets, and only with import", () => {
    expect(parseArgs(["onboard", "import", "--from", "hermes", "--dry-run"])).toMatchObject({
      command: "onboard",
      onboard: { action: "import", importFrom: "hermes", dryRun: true },
    });
    expect(parseArgs(["onboard", "import", "--with-secrets", "--json"])).toMatchObject({
      onboard: { action: "import", withSecrets: true, format: "json" },
    });
    expect(() => parseArgs(["onboard", "status", "--dry-run"])).toThrow("--dry-run goes with onboard import");
    expect(() => parseArgs(["onboard", "import", "--from", "claude"])).toThrow("--from is openclaw or hermes");
    expect(() => parseArgs(["onboard", "import", "--dry-run", "--with-secrets"])).toThrow("--dry-run copies nothing");
  });
});

describe("tavi onboard and tavi setup output", () => {
  it("take the global --format json as --json, and refuse a --format that contradicts it", () => {
    expect(parseArgs(["onboard", "status", "--format", "json"])).toMatchObject({ onboard: { action: "status", format: "json" } });
    expect(parseArgs(["onboard", "status", "--format", "text"])).toMatchObject({ onboard: { format: "text" } });
    expect(parseArgs(["setup", "--non-interactive", "--preset", "openrouter", "--key-stdin", "--format", "json"])).toMatchObject({
      onboard: { format: "json" },
    });
    expect(() => parseArgs(["onboard", "status", "--format", "yaml"])).toThrow("--format takes text or json");
    expect(() => parseArgs(["onboard", "status", "--format", "text", "--json"])).toThrow("--json and --format text");
  });
});
