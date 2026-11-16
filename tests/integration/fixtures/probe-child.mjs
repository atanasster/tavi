// A stand-in PDF child, confined as PDF children are on Linux: what a compromised parser would try, each answered
// "denied" or what it got. Arguments: a file to write in its package directory, then files it must not read.
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createSocket } from "node:dgram";

const [write, ...reads] = process.argv.slice(2);
const found = {};
const attempt = (name, run) => {
  try {
    found[name] = `allowed: ${String(run()).slice(0, 40)}`;
  } catch (error) {
    found[name] = `denied: ${error.code ?? error.message}`;
  }
};
for (const path of reads) attempt(`read ${path}`, () => readFileSync(path, "utf8"));
attempt("write package", () => (writeFileSync(write, "pwned\n"), "written"));
found.tcp = await new Promise((resolve) => {
  const socket = connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
  socket.on("connect", () => (socket.destroy(), resolve("connected")));
  socket.on("error", (error) => resolve(`denied: ${error.code}`));
  socket.on("timeout", () => (socket.destroy(), resolve("timed out")));
});
// One DNS query for example.com straight to 8.8.8.8: an answer means a route out.
found.udp = await new Promise((resolve) => {
  const query = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
  let socket;
  try {
    socket = createSocket("udp4");
  } catch (error) {
    resolve(`denied: ${error.code}`);
    return;
  }
  const timer = setTimeout(() => (socket.close(), resolve("no answer")), 3000);
  socket.on("message", () => (clearTimeout(timer), socket.close(), resolve("answered")));
  socket.on("error", (error) => (clearTimeout(timer), socket.close(), resolve(`denied: ${error.code}`)));
  socket.send(query, 53, "8.8.8.8");
});
process.stdout.write(`${JSON.stringify(found)}\n`);
