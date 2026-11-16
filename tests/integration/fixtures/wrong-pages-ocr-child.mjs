// An OCR child that answers a page it was not sent: the owner must not take it.
process.stdin.resume();
process.stdin.on("end", () => {
  const json = Buffer.from(JSON.stringify({ ok: true, pages: [{ page: 99, text: "not this page", confidence: 90 }], maxRssKb: 1 }));
  const u32 = (value) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value);
    return out;
  };
  process.stdout.write(Buffer.concat([u32(json.length), json, Buffer.from([0]), u32(0)]), () => process.exit(0));
});
