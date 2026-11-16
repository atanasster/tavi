// A test plugin for the worker's no-network guard: the same request six ways, from a tool declared sink none and one declared network.
import { request } from "node:http";
import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** One request to `url` by `how`; whether it got through, and why not. */
async function reach(how, url) {
  try {
    if (how === "fetch") {
      await (await fetch(url)).text();
    } else if (how === "http") {
      await new Promise((resolve, reject) => {
        const outgoing = request(url, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
    } else if (how === "https") {
      await new Promise((resolve, reject) => {
        const outgoing = httpsRequest(url.replace(/^http:/, "https:"), (response) => {
          response.resume();
          response.on("end", resolve);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
    } else if (how === "tls") {
      const { hostname, port } = new URL(url);
      await new Promise((resolve, reject) => {
        const socket = tlsConnect({ port: Number(port), host: hostname }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
    } else if (how === "http2") {
      await new Promise((resolve, reject) => {
        const session = http2Connect(url);
        session.on("error", reject);
        session.on("connect", () => {
          session.close();
          resolve();
        });
      });
    } else {
      const { hostname, port } = new URL(url);
      await new Promise((resolve, reject) => {
        const socket = connect(Number(port), hostname, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
    }
    return { reached: true };
  } catch (error) {
    return { reached: false, error: String(error?.cause?.message ?? error?.message ?? error) };
  }
}

export function register(ctx) {
  const input = ctx.z.object({ how: ctx.z.enum(["fetch", "http", "https", "tls", "http2", "net"]), url: ctx.z.string() });
  ctx.registerTool({ name: "peek", inputSchema: input, handler: ({ how, url }) => reach(how, url) });
  ctx.registerTool({ name: "pull", inputSchema: input, handler: ({ how, url }) => reach(how, url) });
  ctx.registerTool({ name: "think", inputSchema: ctx.z.object({}), handler: async () => ({ thought: "no request" }) });
}
