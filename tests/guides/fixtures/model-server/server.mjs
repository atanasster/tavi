// A made-up model server for the run-and-maintain guides' walks: an
// OpenAI-compatible endpoint on 127.0.0.1, standing in for a local server
// (llama.cpp's llama-server, Ollama, LM Studio) or a provider's API. It knows
// nothing and calls nothing: `GET /v1/models` lists the models it was given,
// and a chat completion answers "ok", calling the first tool it is offered
// once when there are tools, so a `tavi models test` sees both. Run with `node`:
//
//   node server.mjs [--port <n>] [--model <id>]... [--key-file <path>]
//
// It listens on `--port` when that is free, else on a port the system picks,
// and prints its base URL (`http://127.0.0.1:<port>/v1`) on the first line.
// With `--key-file`, a request must bear the key that file holds when it
// arrives (re-read each time, so the walk can rotate it), else it is refused
// with 401 as a provider refuses a wrong key. Each request is printed as
// `request <method> <path> key=<first 12 hex of the key's SHA-256>`, never the
// key itself.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] !== undefined ? [args[index + 1]] : []));
const port = Number(flag("--port")[0] ?? 0);
const models = flag("--model").length > 0 ? flag("--model") : ["stand-in"];
const keyFile = flag("--key-file")[0];

const hash = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);
const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** The answer to a completion: a call of the first tool offered when no tool has answered yet, else "ok". */
function answer(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const answered = (Array.isArray(body.messages) ? body.messages : []).some((message) => message?.role === "tool");
  const name = tools[0]?.function?.name;
  return tools.length > 0 && !answered && typeof name === "string"
    ? { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: "{}" } }], finish: "tool_calls" }
    : { content: "ok", finish: "stop" };
}

function complete(response, body) {
  const model = typeof body.model === "string" ? body.model : models[0];
  const { finish, ...message } = answer(body);
  const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 };
  if (body.stream !== true) {
    json(response, 200, {
      id: "chatcmpl-stand-in",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: message.content ?? null, ...message }, finish_reason: finish }],
      usage,
    });
    return;
  }
  const chunk = (delta, reason, extra = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-stand-in", object: "chat.completion.chunk", created: 1, model, choices: delta === undefined ? [] : [{ index: 0, delta, finish_reason: reason }], ...extra })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(chunk({ role: "assistant", ...message }, null));
  response.write(chunk({}, finish));
  response.write(chunk(undefined, null, { usage }));
  response.end("data: [DONE]\n\n");
}

const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const path = (request.url ?? "/").split("?")[0];
    console.log(`request ${request.method} ${path} key=${key === "" ? "-" : hash(key)}`);
    if (keyFile !== undefined && key !== readFileSync(keyFile, "utf8").trim()) {
      json(response, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
      return;
    }
    if (path === "/v1/models" && request.method === "GET") {
      json(response, 200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "stand-in" })) });
      return;
    }
    if (path === "/v1/chat/completions" && request.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        json(response, 400, { error: { message: "the body is not JSON" } });
        return;
      }
      complete(response, body);
      return;
    }
    json(response, 404, { error: { message: "not found" } });
  });
});

const listen = (at) =>
  server.listen(at, "127.0.0.1", () => {
    const address = server.address();
    console.log(`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/v1`);
  });
server.once("error", (error) => {
  if (error.code !== "EADDRINUSE" || port === 0) throw error;
  listen(0);
});
listen(port);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
