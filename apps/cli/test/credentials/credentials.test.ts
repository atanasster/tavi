import { chmodSync, existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi credentials` — the operator-only write path for the local credential
 * store. It exists because the runtime's credential chain
 * resolves `<dataDir>/credentials/<ref>` but is read-only by construction, so
 * there was no way to put a credential there at all. Nothing here is reachable
 * from the agent, and no command prints a value.
 */

const directories = temporaryDirectories({ prefix: "tavi-credentials-" });

afterEach(() => directories.cleanup());

/** Write a secret to a 0600 file, as an operator would. */
function secretFile(directory: string, name: string, value: string): string {
  const path = join(directory, name);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("tavi credentials set", () => {
  it("deletes a reference by delete, rm or remove, and its help names delete with the others as aliases", async () => {
    const directory = directories.create();
    const key = join(directory, "value.key");
    writeFileSync(key, "sk-test-alias\n", { mode: 0o600 });
    chmodSync(key, 0o600);
    for (const verb of ["delete", "rm", "remove"]) {
      expect(await main(["credentials", "set", "alias.key", "--file", key, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
      const removed = capture();
      expect(await main(["credentials", verb, "alias.key", "--data-dir", directory], { io: removed.io }), verb).toBe(EXIT.ok);
      expect(removed.stdout()).toBe("deleted credential alias.key\n");
    }
    const help = capture();
    await main(["credentials", "--help"], { io: help.io });
    expect(help.stdout()).toMatch(/delete <ref> +Remove a reference \(alias: rm, remove\)/);
  });
  it("stores a 0600 file and never echoes the value", async () => {
    const directory = directories.create();
    const source = secretFile(directory, "stripe.key", "sk_live_SUPERSECRET");

    const captured = capture();
    expect(await main(["credentials", "set", "acme.stripe.key", "--file", source, "--data-dir", directory], { io: captured.io })).toBe(
      EXIT.ok,
    );

    const stored = join(directory, "credentials", "acme.stripe.key");
    expect(readFileSync(stored, "utf8")).toBe("sk_live_SUPERSECRET");
    expect(lstatSync(stored).mode & 0o077).toBe(0);
    expect(lstatSync(join(directory, "credentials")).mode & 0o077).toBe(0);
    // The command output names the reference and nothing else.
    expect(captured.stdout()).toContain("acme.stripe.key");
    expect(captured.stdout()).not.toContain("SUPERSECRET");
    expect(captured.stderr()).not.toContain("SUPERSECRET");
  });

  it("refuses a group/world-readable source file", async () => {
    const directory = directories.create();
    const source = join(directory, "loose.key");
    writeFileSync(source, "value", { mode: 0o644 });
    chmodSync(source, 0o644);

    const captured = capture();
    expect(await main(["credentials", "set", "loose", "--file", source, "--data-dir", directory], { io: captured.io })).not.toBe(EXIT.ok);
    expect(existsSync(join(directory, "credentials", "loose"))).toBe(false);
  });

  it("refuses a symlinked source file", async () => {
    const directory = directories.create();
    const real = secretFile(directory, "real.key", "value");
    const link = join(directory, "link.key");
    symlinkSync(real, link);

    const captured = capture();
    expect(await main(["credentials", "set", "linked", "--file", link, "--data-dir", directory], { io: captured.io })).not.toBe(EXIT.ok);
    expect(existsSync(join(directory, "credentials", "linked"))).toBe(false);
  });
});

describe("tavi credentials list and delete", () => {
  it("lists references only and deletes them", async () => {
    const directory = directories.create();
    await main(["credentials", "set", "acme.stripe.key", "--file", secretFile(directory, "a", "sk_a"), "--data-dir", directory], {
      io: capture().io,
    });
    await main(["credentials", "set", "acme.ga4.sa", "--file", secretFile(directory, "b", '{"k":1}'), "--data-dir", directory], {
      io: capture().io,
    });

    const listed = capture();
    expect(await main(["credentials", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("acme.stripe.key");
    expect(listed.stdout()).toContain("acme.ga4.sa");
    expect(listed.stdout()).not.toContain("sk_a");

    const json = capture();
    expect(await main(["credentials", "list", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout())).toEqual({ credentials: ["acme.ga4.sa", "acme.stripe.key"], unusable: [] });

    // Two connections still naming the key: both said, with the way back.
    for (const id of ["one", "two"])
      await main(
        ["models", "add", id, "--base-url", "https://api.example.test/v1", "--credential", "acme.ga4.sa", "--data-dir", directory],
        {
          io: capture().io,
        },
      );
    const deleted = capture();
    expect(await main(["credentials", "delete", "acme.ga4.sa", "--data-dir", directory], { io: deleted.io })).toBe(EXIT.ok);
    expect(existsSync(join(directory, "credentials", "acme.ga4.sa"))).toBe(false);
    expect(deleted.stdout()).toBe("deleted credential acme.ga4.sa\n");
    expect(deleted.stderr()).toContain(
      "the model connections one, two still name acme.ga4.sa: store it again with `tavi credentials set acme.ga4.sa --file <path>`, " +
        "or point each at another with `tavi models rebind <id> --credential <name>`",
    );
    const unused = capture();
    expect(await main(["credentials", "delete", "acme.stripe.key", "--data-dir", directory], { io: unused.io })).toBe(EXIT.ok);
    expect(unused.stderr()).toBe("");

    const empty = capture();
    expect(await main(["credentials", "list", "--data-dir", directory], { io: empty.io })).toBe(EXIT.ok);
    expect(empty.stdout()).not.toContain("acme.ga4.sa");
  });

  it("reports an empty store rather than failing", async () => {
    const captured = capture();
    expect(await main(["credentials", "list", "--data-dir", directories.create()], { io: captured.io })).toBe(EXIT.ok);
    expect(captured.stdout()).toContain("no credentials configured");
  });
});

describe("tavi credentials — argument and ownership discipline", () => {
  it("rejects a set without --file and a positional reference that is missing", async () => {
    const directory = directories.create();
    expect(await main(["credentials", "set", "ref", "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
    expect(await main(["credentials", "set", "--file", "/tmp/x", "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
    expect(await main(["credentials", "delete", "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
    expect(await main(["credentials", "frobnicate", "--data-dir", directory], { io: capture().io })).toBe(EXIT.usage);
  });

  it("reports an unusable reference as a usage error, not an internal one", async () => {
    const directory = directories.create();
    const source = secretFile(directory, "value", "secret");
    // `../../outside/victim` cannot be a reference, so it is the operator's
    // argument that is wrong (2) — not an internal failure (70).
    const captured = capture();
    expect(await main(["credentials", "set", "../../outside/victim", "--file", source, "--data-dir", directory], { io: captured.io })).toBe(
      EXIT.usage,
    );
    expect(await main(["credentials", "delete", "bad ref", "--data-dir", directory], { io: captured.io })).toBe(EXIT.usage);
    expect(existsSync(join(directory, "credentials"))).toBe(false);
  });

  it("surfaces a hand-dropped file that can never be resolved", async () => {
    const directory = directories.create();
    await main(["credentials", "set", "good.key", "--file", secretFile(directory, "a", "value"), "--data-dir", directory], {
      io: capture().io,
    });
    // A file the store could never resolve: list must not present it as configured.
    writeFileSync(join(directory, "credentials", "Upper Ref"), "value", { mode: 0o600 });
    chmodSync(join(directory, "credentials", "Upper Ref"), 0o600);

    const captured = capture();
    expect(await main(["credentials", "list", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    expect(captured.stdout()).toContain("good.key");
    expect(captured.stdout()).not.toContain("Upper Ref");
    expect(captured.stderr()).toContain("Upper Ref");

    const json = capture();
    await main(["credentials", "list", "--format", "json", "--data-dir", directory], { io: json.io });
    expect(JSON.parse(json.stdout())).toEqual({ credentials: ["good.key"], unusable: ["Upper Ref"] });
  });

  it("lists a reference containing .tmp-, while still hiding the store's own temporary file", async () => {
    // `list` once filtered out any name containing `.tmp-`, which hid
    // references the pattern accepts and the secret reader resolves, so
    // `credentials list` disagreed with what a task can use. The store's
    // in-progress write is `<ref>.tmp-<12 hex>` and is still hidden.
    const directory = directories.create();
    await main(["credentials", "set", "acme.tmp-key", "--file", secretFile(directory, "a", "value"), "--data-dir", directory], {
      io: capture().io,
    });
    writeFileSync(join(directory, "credentials", "acme.key.tmp-9f3a1b2c4d5e"), "half written", { mode: 0o600 });

    const captured = capture();
    expect(await main(["credentials", "list", "--format", "json", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
    expect(JSON.parse(captured.stdout())).toEqual({ credentials: ["acme.tmp-key"], unusable: [] });
  });

  it("does not create a database just to store a credential", async () => {
    const directory = directories.create();
    await main(["credentials", "set", "acme.key", "--file", secretFile(directory, "a", "value"), "--data-dir", directory], {
      io: capture().io,
    });
    // Provisioning a credential must not depend on (or migrate) SQLite.
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(false);
    expect(existsSync(join(directory, "credentials", "acme.key"))).toBe(true);
  });

  it("refuses to change credentials while an owner holds the data directory", async () => {
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "credentials-test" });
    try {
      const captured = capture();
      expect(await main(["credentials", "list", "--data-dir", directory], { io: captured.io })).toBe(EXIT.alreadyOwned);
    } finally {
      ownership.release();
    }
  });
});
