// Sets up the disposable Home Assistant scripts/mcp-homeassistant-live.sh starts: a test user and a long-lived
// token (test values, written to the file named by argv[2], mode 0600), a Hallway area, the entities exposed to Assist,
// and the MCP server integration on the Assist API.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const base = process.env.TAVI_HA_URL ?? "http://localhost:18123";
const out = process.argv[2];
const client_id = `${base}/`;
const password = randomBytes(12).toString("hex");
const json = async (response) => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text === "" ? {} : JSON.parse(text);
};
const user = await json(
  await fetch(`${base}/api/onboarding/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id, name: "Tavi Test", username: "tavitest", password, language: "en" }),
  }),
);
const tokens = await json(
  await fetch(`${base}/auth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: user.auth_code, client_id }),
  }),
);
const auth = { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" };
await json(await fetch(`${base}/api/onboarding/core_config`, { method: "POST", headers: auth, body: "{}" }));
await json(await fetch(`${base}/api/onboarding/analytics`, { method: "POST", headers: auth, body: "{}" }));
await json(
  await fetch(`${base}/api/onboarding/integration`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ client_id, redirect_uri: `${base}/?auth_callback=1` }),
  }),
).catch(() => undefined);
// The websocket API: a long-lived token, an area, exposure to Assist.
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
let id = 0;
const waiting = new Map();
const ready = new Promise((resolve, reject) => {
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: tokens.access_token }));
    else if (message.type === "auth_ok") resolve();
    else if (message.type === "auth_invalid") reject(new Error("auth invalid"));
    else if (message.type === "result") {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      message.success ? done.resolve(message.result) : done.reject(new Error(JSON.stringify(message.error)));
    }
  };
});
await ready;
const call = (payload) =>
  new Promise((resolve, reject) => {
    id += 1;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, ...payload }));
  });
const llat = await call({ type: "auth/long_lived_access_token", client_name: "Tavi MCP test", lifespan: 30 });
const area = await call({ type: "config/area_registry/create", name: "Hallway" });
await call({ type: "config/entity_registry/update", entity_id: "light.hallway_light", area_id: area.area_id });
const entities = ["light.hallway_light", "light.kitchen_light", "lock.front_door", "script.goodnight"];
await call({ type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids: entities, should_expose: true });
// The MCP server integration, on the Assist API.
const flow = await json(
  await fetch(`${base}/api/config/config_entries/flow`, { method: "POST", headers: auth, body: JSON.stringify({ handler: "mcp_server" }) }),
);
let step = flow;
if (step.type === "form")
  step = await json(
    await fetch(`${base}/api/config/config_entries/flow/${flow.flow_id}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ llm_hass_api: ["assist"] }),
    }),
  );
writeFileSync(out, JSON.stringify({ token: llat, flow: step.type, area: area.area_id }), { mode: 0o600 });
console.log(`mcp_server: ${step.type}; area ${area.area_id}; exposed ${entities.length}`);
ws.close();
