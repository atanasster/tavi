// A dependency-free MCP server that speaks only the legacy HTTP+SSE transport
// (2024-11-05), for the client's `transport` fallback: a Streamable HTTP POST is refused with 405; `GET /sse` opens the
// event stream, whose first `endpoint` event names where to POST messages;
// each answer comes back on the stream. Prints `port <n>` on stdout.
// Tools: `echo`.

import { createServer } from "node:http";

const streams = new Map();
let next = 0;

const send = (stream, message) => stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);

function answer(message) {
  if (message.id === undefined) return undefined;
  switch (message.method) {
    case "initialize":
      return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1.0.0" } } };
    case "ping":
      return { jsonrpc: "2.0", id: message.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echoes.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } };
    case "tools/call":
      return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] } };
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/sse" && request.method === "GET") {
    const session = String((next += 1));
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(`event: endpoint\ndata: /messages?session=${session}\n\n`);
    streams.set(session, response);
    request.on("close", () => streams.delete(session));
    return;
  }
  if (url.pathname === "/messages" && request.method === "POST") {
    const stream = streams.get(url.searchParams.get("session") ?? "");
    if (stream === undefined) return response.writeHead(404).end();
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(202).end();
      const reply = answer(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (reply !== undefined) send(stream, reply);
    });
    return;
  }
  // Streamable HTTP's POST (or anything else) to the address: not this server's transport.
  response.writeHead(405, { allow: "GET" }).end();
});

server.listen(0, "127.0.0.1", () => process.stdout.write(`port ${server.address().port}\n`));
