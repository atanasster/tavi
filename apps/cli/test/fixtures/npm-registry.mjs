// A loopback npm registry for the npm install tests: `node npm-registry.mjs <config.json>`.
// The config lists `{name, version, tarball, manifest}` per published version; the registry
// serves the packument at `/<name>` and `/<name>/<version>` (dist.tarball pointing back at it,
// dist.integrity the tarball's sha512) and the tarball at `/<name>/-/<file>.tgz`. It prints
// `PORT <n>` once listening and exits when its stdin closes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
let base = "";
const packages = new Map();
for (const entry of config.packages) {
  const bytes = readFileSync(entry.tarball);
  const file = basename(entry.tarball);
  const versions = packages.get(entry.name) ?? new Map();
  versions.set(entry.version, { entry, bytes, file });
  packages.set(entry.name, versions);
}

function versionDocument(name, version) {
  const { entry, bytes, file } = packages.get(name).get(version);
  return {
    ...entry.manifest,
    name,
    version,
    dist: {
      tarball: `${base}/${name}/-/${file}`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    },
  };
}

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\//, "");
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  const tarballAt = path.indexOf("/-/");
  if (tarballAt !== -1) {
    const name = path.slice(0, tarballAt);
    const file = path.slice(tarballAt + 3);
    for (const { file: candidate, bytes } of packages.get(name)?.values() ?? []) {
      if (candidate === file) return send(200, bytes, "application/octet-stream");
    }
    return send(404, JSON.stringify({ error: "not found" }));
  }
  // `@scope/name`, `@scope/name/1.0.0`, `name` or `name/1.0.0`.
  const parts = path.split("/");
  const nameParts = path.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameParts).join("/");
  const version = parts[nameParts];
  const versions = packages.get(name);
  if (versions === undefined) return send(404, JSON.stringify({ error: "not found" }));
  if (version !== undefined) {
    if (!versions.has(version)) return send(404, JSON.stringify({ error: "not found" }));
    return send(200, JSON.stringify(versionDocument(name, version)));
  }
  const all = Object.fromEntries([...versions.keys()].map((v) => [v, versionDocument(name, v)]));
  const latest = [...versions.keys()].at(-1);
  send(200, JSON.stringify({ name, "dist-tags": { latest }, versions: all }));
});

server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`PORT ${server.address().port}\n`);
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
