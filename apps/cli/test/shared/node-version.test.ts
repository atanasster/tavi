import { readFileSync } from "node:fs";

import { capture } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { MIN_NODE_VERSION, nodeVersionReport } from "../../src/shared/node-version.js";

/** One patch release below the floor `engines.node` declares, whatever Node runs the tests. */
function belowTheFloor(): string {
  const [major = 0, minor = 0, patch = 0] = MIN_NODE_VERSION.split(".").map(Number);
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.99` : `${major - 1}.99.99`;
}

describe("node version floor", () => {
  it("is the floor package.json's engines declares", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    expect(manifest.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
  });

  it("compares versions part by part", () => {
    expect(nodeVersionReport("22.19.0")).toEqual({ version: "22.19.0", required: `>=${MIN_NODE_VERSION}`, ok: false });
    expect(nodeVersionReport("22.21.0").ok).toBe(true);
    expect(nodeVersionReport("22.100.0").ok).toBe(true);
    expect(nodeVersionReport("24.0.0").ok).toBe(true);
    expect(nodeVersionReport("21.99.99").ok).toBe(false);
  });

  it.each(["serve", "run", "chat", "ui"])(
    "refuses tavi %s on a Node.js older than the floor, before it starts anything",
    async (command) => {
      const captured = capture();
      const argv = command === "run" ? ["run", "hello", "--data-dir", "/nonexistent/tavi"] : [command, "--data-dir", "/nonexistent/tavi"];
      expect(await main(argv, { io: captured.io, nodeVersion: belowTheFloor() })).toBe(EXIT.unavailable);
      expect(captured.stderr()).toBe(
        `tavi ${command} needs Node.js ${MIN_NODE_VERSION} or later; this is Node.js ${belowTheFloor()}. Upgrade Node.js and run it again.\n`,
      );
    },
  );

  it("leaves every other command to run, doctor reporting the version instead", async () => {
    const captured = capture();
    expect(await main(["--version"], { io: captured.io, nodeVersion: belowTheFloor() })).toBe(EXIT.ok);
  });
});
