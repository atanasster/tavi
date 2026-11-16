import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateGate } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The Home Assistant preset against a real instance:
 * `TAVI_LIVE_HA=<secrets.json>` names a file holding `{ "token" }`
 * for a Home Assistant at `TAVI_LIVE_HA_URL` (default
 * http://localhost:18123/api/mcp) with its MCP server integration on, two
 * lights (`light.hallway_light` in the Hallway area, `light.kitchen_light`), a
 * lock (`lock.front_door`) and a script (`script.goodnight`) exposed to Assist.
 * Not in automated runs.
 */

const secretsFile = process.env["TAVI_LIVE_HA"];
const url = process.env["TAVI_LIVE_HA_URL"] ?? "http://localhost:18123/api/mcp";
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

describe.skipIf(secretsFile === undefined)("Home Assistant (live)", () => {
  it("adds the preset, reviews it, and calls it under its floors", async () => {
    const data = directories.create("tavi-ha-");
    const at = ["--data-dir", data];
    const token = (JSON.parse(readFileSync(secretsFile as string, "utf8")) as { token: string }).token;
    const tokenFile = join(data, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    expect((await tavi(["mcp", "add", "home", "--preset", "homeassistant", "--no-probe", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["credentials", "set", "plugins.mcp.home.token", "--file", tokenFile, ...at])).code).toBe(EXIT.ok);
    expect(
      (await tavi(["plugins", "config", "mcp.home", "--set", `url=${url}`, "--set", "token=plugins.mcp.home.token", ...at])).code,
    ).toBe(EXIT.ok);
    const probed = await tavi(["mcp", "probe", "mcp.home", ...at]);
    const approved = await tavi(["mcp", "approve", "mcp.home", "1.0.0", ...at]);
    writeFileSync(join(tmpdir(), "tavi-ha-review.txt"), `${probed.stdout}\n---\n${approved.stdout}\n${approved.stderr}`);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.home", ...at])).code).toBe(EXIT.ok);
    // MCP is off by default while it is a preview.
    expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);

    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    const context = { workspaceId: "default", principalId: "operator", runId: "task-ha", caller: "test" };
    const tool = (name: string) => {
      const found = runtime.tools.get(`mcp.home.${name}`);
      if (found === undefined) throw new Error(`no mcp.home.${name}`);
      return found;
    };
    const verdict = (name: string, input: unknown) => {
      const found = tool(name);
      const assessment = found.assess?.(input, context);
      return evaluateGate({
        toolId: found.id,
        effect: found.effect,
        ...(assessment === undefined ? {} : { assessment }),
        rules: [],
        sessionGrants: [],
        gatedEffects: new Set(["mutating", "external"]),
        tainted: false,
        sink: found.sink,
        ...(found.urlOnly === undefined ? {} : { urlOnly: found.urlOnly }),
      });
    };
    const state = async (entity: string): Promise<string> =>
      (
        (await (
          await fetch(url.replace(/\/api\/mcp$/, `/api/states/${entity}`), { headers: { authorization: `Bearer ${token}` } })
        ).json()) as { state: string }
      ).state;
    const call = async (name: string, input: unknown) => await tool(name).handler({ input, context, signal: new AbortController().signal });
    const lines: string[] = [];

    // A light by name and domain: a session grant may cover it; it turns on.
    const on = verdict("intent_hassturnon", { name: "Kitchen light", domain: ["light"] });
    lines.push(`HassTurnOn kitchen light (domain light): ${on.decision}, risk ${on.risk.level}, scopes ${on.allowedScopes.join("/")}`);
    expect(on.allowedScopes).toContain("session");
    await call("intent_hassturnon", { name: "Kitchen light", domain: ["light"] });
    expect(await state("light.kitchen_light")).toBe("on");
    // "Turn off the hallway" by area alone: critical, once only, no grant.
    const hallway = verdict("intent_hassturnoff", { area: "Hallway" });
    lines.push(
      `HassTurnOff area Hallway alone: ${hallway.decision}, risk ${hallway.risk.level}, scopes ${hallway.allowedScopes.join("/")}`,
    );
    expect(hallway).toMatchObject({ decision: "ask", allowedScopes: ["once"], risk: { level: "critical" } });
    // Unlocking (a lock's off): critical.
    const unlock = verdict("intent_hassturnoff", { name: "Front door", domain: ["lock"] });
    lines.push(
      `HassTurnOff front door (domain lock = unlock): ${unlock.decision}, risk ${unlock.risk.level}, scopes ${unlock.allowedScopes.join("/")}`,
    );
    expect(unlock).toMatchObject({ allowedScopes: ["once"], risk: { level: "critical" } });
    // A switch of class garage is not a safe switch.
    expect(verdict("intent_hassturnon", { name: "Garage", domain: ["switch"], device_class: ["garage"] }).risk.level).toBe("critical");
    const script = verdict("script_goodnight", {});
    lines.push(`script goodnight: ${script.decision}, risk ${script.risk.level}, scopes ${script.allowedScopes.join("/")}`);
    expect(script.risk.level).toBe("critical");
    // A read: no ask untainted.
    expect(verdict("homeassistant_getlivecontext", {}).decision).toBe("allow");

    // A rotated token applies on the next call: a wrong one fails it, the right one works again, no restart.
    // The running owner holds the data directory, so the token is rotated in its credential store directly, as
    // `tavi credentials set` does through it.
    const store = createLocalCredentialStore(data);
    await store.setSecret("plugins.mcp.home.token", "not-a-token");
    await expect(call("intent_hassturnoff", { name: "Kitchen light", domain: ["light"] })).rejects.toMatchObject({
      details: { mcpFailure: "auth" },
    });
    await store.setSecret("plugins.mcp.home.token", token);
    lines.push(`after the wrong token: ${JSON.stringify(runtime.mcp.supervisor.status("mcp.home"))}`);
    expect(runtime.mcp.supervisor.status("mcp.home")).toMatchObject({ failures: 0 });
    expect(runtime.mcp.supervisor.status("mcp.home").state).not.toBe("backing-off");
    await call("intent_hassturnoff", { name: "Kitchen light", domain: ["light"] });
    expect(await state("light.kitchen_light")).toBe("off");
    lines.push("token rotation: a wrong token failed the next call, the server not backed off; the right one worked on the very next call");

    // Drift: a newly exposed entity, then a new script.
    const ha = url.replace(/\/api\/mcp$/, "");
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${ha}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    };
    // A script of its own per run: the instance outlives a run.
    const movie = `movie${String(Date.now())}`;
    await post(`/api/config/script/config/${movie}`, {
      alias: movie,
      sequence: [{ action: "light.turn_off", target: { entity_id: "light.kitchen_light" } }],
    });
    await post("/api/services/script/reload", {});
    await delay(2_000);
    lines.push(`after adding a script, not exposed: ${JSON.stringify((await runtime.mcp.checkDrift("mcp.home")) ?? "no drift")}`);
    await exposeToAssist(ha, token, [`script.${movie}`]);
    const drift = await runtime.mcp.checkDrift("mcp.home");
    lines.push(`after exposing it to Assist: ${JSON.stringify(drift ?? "no drift")}`);
    expect(drift?.added).toEqual([`script__${movie}`]);
    expect(runtime.tools.get(`mcp.home.script_${movie}`)).toBeUndefined();
    // An entity newly exposed adds no tool (tools are intents and scripts): no drift.
    await exposeToAssist(ha, token, ["input_boolean.hallway_on"]);
    await runtime.mcp.supervisor.stop("mcp.home");
    const entity = await runtime.mcp.checkDrift("mcp.home");
    lines.push(`after exposing an entity, a new session: ${JSON.stringify(entity ?? "no drift")}`);
    expect(entity).toBeUndefined();
    writeFileSync(join(tmpdir(), "tavi-ha-run.txt"), `${lines.join("\n")}\n`);
  }, 120_000);
});

/** Exposes entities to Assist over Home Assistant's websocket API (no REST call does). */
async function exposeToAssist(base: string, token: string, entityIds: readonly string[]): Promise<void> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
  await new Promise<void>((done, fail) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; success?: boolean; error?: unknown };
      if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (message.type === "auth_ok")
        socket.send(
          JSON.stringify({
            id: 1,
            type: "homeassistant/expose_entity",
            assistants: ["conversation"],
            entity_ids: entityIds,
            should_expose: true,
          }),
        );
      else if (message.type === "result") message.success === true ? done() : fail(new Error(JSON.stringify(message.error)));
      else if (message.type === "auth_invalid") fail(new Error("auth invalid"));
    };
  });
  socket.close();
}
