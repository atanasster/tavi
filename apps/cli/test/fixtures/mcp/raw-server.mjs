// A dependency-free 2025-era MCP server over stdio, for sandbox tests: it imports nothing outside Node, so it runs from a
// plugin snapshot with no node_modules. Its tools try what a sandbox forbids:
// `read` reads a path, `connect` opens a TCP connection, `write` writes a
// file, `env` returns one environment variable, `echo` echoes.
// RAW_TOOLS (drift tests): a JSON file read on every listing — `{ "<name>":
// "<description>" }` replaces a tool's description, `"<name>": null` drops
// it, a name not listed above adds a read-only tool, and `__instructions`
// replaces its instructions.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const tools = [
  { name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "read", description: "Reads a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { name: "write", description: "Writes a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "connect", description: "Opens a connection.", inputSchema: { type: "object", properties: { host: { type: "string" }, port: { type: "number" } }, required: ["host", "port"] } },
  { name: "env", description: "One environment variable.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } },
  { name: "fetch", description: "Fetches a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

function listed() {
  if (process.env.RAW_TOOLS === undefined) return tools;
  const changes = JSON.parse(readFileSync(process.env.RAW_TOOLS, "utf8"));
  const known = tools.filter((tool) => changes[tool.name] !== null).map((tool) => (typeof changes[tool.name] === "string" ? { ...tool, description: changes[tool.name] } : tool));
  const added = Object.entries(changes).filter(([name, description]) => typeof description === "string" && name !== "__instructions" && !tools.some((tool) => tool.name === name))
    .map(([name, description]) => ({ name, description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }));
  return [...known, ...added];
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Its instructions: RAW_TOOLS' `__instructions`, read at each connect, else its own. */
function instructions() {
  if (process.env.RAW_TOOLS === undefined) return "Use the raw tools.";
  const given = JSON.parse(readFileSync(process.env.RAW_TOOLS, "utf8")).__instructions;
  return typeof given === "string" ? given : "Use the raw tools.";
}
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

async function call(name, args) {
  switch (name) {
    case "echo": return text(args.text ?? "");
    case "read": try { return text(readFileSync(args.path, "utf8")); } catch (error) { return text(`denied: ${error.code}`); }
    case "write": try { writeFileSync(args.path, "x"); return text("written"); } catch (error) { return text(`denied: ${error.code}`); }
    case "env": return text(process.env[args.name] ?? "(unset)");
    case "fetch": try { const response = await fetch(args.url, { signal: AbortSignal.timeout(8000) }); return text(`status ${response.status}`); } catch (error) { return text(`denied: ${error.cause?.code ?? error.code ?? error.message}`); }
    case "connect": return new Promise((done) => {
      const socket = connect({ host: args.host, port: args.port, timeout: 3000 });
      socket.on("connect", () => { socket.destroy(); done(text("connected")); });
      socket.on("timeout", () => { socket.destroy(); done(text("denied: timeout")); });
      socket.on("error", (error) => done(text(`denied: ${error.code}`)));
    });
    default: return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  }
}

let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${message.method}\n`);
    if (message.id === undefined) continue;
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1.0.0" }, instructions: instructions() } });
    else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: listed() } });
    else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: await call(message.params.name, message.params.arguments ?? {}) });
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
