// A worker that breaks the protocol on purpose (HOSTILE_STAGE): at its start, or in answer to a call.
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
};
let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
    const message = JSON.parse(pending.subarray(4, 4 + pending.readUInt32BE(0)).toString());
    pending = pending.subarray(4 + pending.readUInt32BE(0));
    if (message.t === "hello" && process.env.HOSTILE_STAGE === "start") frame(null);
    else if (message.t === "hello") frame({ t: "ready", protocol: 1, pluginId: message.pluginId, contentHash: message.contentHash, registrations: { tools: [{ name: "echo", inputJsonSchema: { type: "object" }, beforeCall: false }], hooks: [], commands: [], signalSources: [] } });
    else if (message.t === "call") frame({ t: "log", level: "shout", message: "x" });
  }
});
