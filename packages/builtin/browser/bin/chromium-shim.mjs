#!/usr/bin/env node
// @ts-check
// Inside the sandbox: Chromium itself, with
// its CDP pipe (fds 3 and 4) carried on this process's stdin and stdout.
//
// srt's proxy wants credentials it puts only in this environment
// (`HTTPS_PROXY=http://user:token@host:port`), and Chromium takes no
// credentials in `--proxy-server`. So a relay on loopback, here, adds them to
// each request and tunnel, and Chromium is pointed at it.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const [executable, ...flags] = process.argv.slice(2);
if (executable === undefined) {
  process.stderr.write("usage: chromium-shim.mjs <chromium> [flags…]\n");
  process.exit(2);
}
/** @type {readonly NodeJS.Signals[]} */
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * A loopback relay to srt's proxy carrying its credentials; resolves to its port, or undefined with no proxy.
 * @returns {Promise<number | undefined>}
 */
async function relay() {
  const raw = process.env["HTTPS_PROXY"] ?? process.env["HTTP_PROXY"];
  if (raw === undefined) return undefined;
  const upstream = new URL(raw);
  if (upstream.username === "") return undefined;
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString("base64")}`;
  const port = Number(upstream.port || 80);
  const server = createServer((incoming, outgoing) => {
    // A plain-HTTP request, its absolute URL kept: forwarded with the credentials.
    const forward = httpRequest(
      {
        host: upstream.hostname,
        port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, "proxy-authorization": authorization },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forward.on("error", () => outgoing.destroy());
    incoming.pipe(forward);
  });
  server.on("connect", (incoming, client, head) => {
    // A tunnel: srt's proxy answers the CONNECT itself, then carries the bytes.
    const tunnel = connect(port, upstream.hostname, () => {
      tunnel.write(
        `CONNECT ${incoming.url ?? ""} HTTP/1.1\r\nHost: ${incoming.url ?? ""}\r\nProxy-Authorization: ${authorization}\r\n\r\n`,
      );
      if (head.length > 0) tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    tunnel.on("error", () => client.destroy());
    client.on("error", () => tunnel.destroy());
  });
  await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
  server.unref();
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}

const relayPort = await relay();
const proxyFlags = relayPort === undefined ? [] : [`--proxy-server=http://127.0.0.1:${relayPort}`, "--proxy-bypass-list=<-loopback>"];
const chromium = spawn(executable, [...flags, ...proxyFlags], { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
// fds 3 and 4 are the "pipe" entries above: Chromium's CDP input and output.
const toChromium = /** @type {import("node:stream").Writable} */ (chromium.stdio[3]);
const fromChromium = /** @type {import("node:stream").Readable} */ (chromium.stdio[4]);
process.stdin.pipe(toChromium).on("error", () => undefined);
fromChromium.pipe(process.stdout).on("error", () => undefined);
for (const signal of FORWARDED) process.on(signal, () => chromium.kill(signal));
chromium.on("error", (error) => {
  process.stderr.write(`Chromium could not start: ${error.message}\n`);
  process.exit(127);
});
chromium.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
