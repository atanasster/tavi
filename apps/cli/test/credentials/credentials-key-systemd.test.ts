import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SYSTEMD_CREDENTIAL_KEY_NAME } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { parseCredentials } from "../../src/features/credentials/parse.js";
import {
  createLocalCredentialStore,
  credentialKeyLocation,
  encryptCredentialDirectory,
  moveCredentialKey,
} from "../../src/features/credentials/store.js";
import { credentialsCommand, type ConfigDependencies } from "../../src/server/config-commands.js";
import { renderServiceUnit } from "../../src/features/service/unit.js";
import { memoryKeychain } from "../support/memory-keychain.js";

/**
 * The credential key kept as a systemd credential (`LoadCredentialEncrypted=`):
 * `credentials.key` then only names it, and the key itself reaches the service
 * decrypted under `$CREDENTIALS_DIRECTORY`. Here that directory is a temporary
 * one holding the decrypted file systemd would; no test runs systemd.
 */

const directories = temporaryDirectories({ prefix: "tavi-key-systemd-" });

afterEach(() => {
  directories.cleanup();
});

const REFERENCE = `tavi-keychain:v1:systemd:${SYSTEMD_CREDENTIAL_KEY_NAME}\n`;

/** A data directory with a file key and one credential, and the credentials directory systemd would hand its service. */
async function serviceDirectories(
  credential: "same" | "other" | "none" = "same",
): Promise<{ data: string; credentials: string; key: string }> {
  const data = directories.create();
  await encryptCredentialDirectory(data, undefined);
  await createLocalCredentialStore(data).setSecret("acme.token", "s3cret-value");
  const key = readFileSync(join(data, "credentials.key"), "utf8").trim();
  const credentials = directories.create();
  if (credential !== "none") {
    const held = credential === "same" ? key : "c".repeat(64);
    writeFileSync(join(credentials, SYSTEMD_CREDENTIAL_KEY_NAME), `${held}\n`, { mode: 0o400 });
  }
  return { data, credentials, key };
}

/** `work` with `$CREDENTIALS_DIRECTORY` set as a service's would be, restored after. */
async function asService<T>(credentials: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env["CREDENTIALS_DIRECTORY"];
  if (credentials === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
  else process.env["CREDENTIALS_DIRECTORY"] = credentials;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
    else process.env["CREDENTIALS_DIRECTORY"] = previous;
  }
}

describe("moving the credential key to a systemd credential", () => {
  it("refers to the credential once it holds the same key, every credential still reads through it, and it moves back", async () => {
    const { data, credentials, key } = await serviceDirectories();
    const keyFile = join(data, "credentials.key");

    const result = await moveCredentialKey(data, "systemd", undefined, credentials);

    expect(result).toMatchObject({ to: "systemd", moved: true, systemd: SYSTEMD_CREDENTIAL_KEY_NAME });
    expect(readFileSync(keyFile, "utf8")).toBe(REFERENCE);
    expect(await credentialKeyLocation(data)).toMatchObject({ kept: "systemd", systemd: SYSTEMD_CREDENTIAL_KEY_NAME });
    expect(await asService(credentials, () => createLocalCredentialStore(data).getSecret("acme.token"))).toBe("s3cret-value");
    // A second run is a no-op.
    expect(await moveCredentialKey(data, "systemd", undefined, credentials)).toMatchObject({ moved: false });

    expect(await moveCredentialKey(data, "file", undefined, credentials)).toMatchObject({ to: "file", moved: true });
    expect(readFileSync(keyFile, "utf8").trim()).toBe(key);
    expect(await createLocalCredentialStore(data).getSecret("acme.token")).toBe("s3cret-value");
  });

  it("changes nothing when the credential holds another key, or is not there", async () => {
    for (const credential of ["other", "none"] as const) {
      const { data, credentials } = await serviceDirectories(credential);
      const before = readFileSync(join(data, "credentials.key"), "utf8");
      await expect(moveCredentialKey(data, "systemd", undefined, credentials)).rejects.toThrow(
        credential === "other" ? /holds a different key/ : /no credential tavi-credential-key|tavi-credential-key/,
      );
      expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(before);
    }
  });

  it("is refused outside a service systemd started, naming the line it needs", async () => {
    const { data } = await serviceDirectories();
    await asService(undefined, async () => {
      await expect(moveCredentialKey(data, "systemd")).rejects.toThrow(/LoadCredentialEncrypted=tavi-credential-key/);
    });
  });

  it("deletes the keychain item a key moved from", async () => {
    const { keychain, items } = memoryKeychain();
    const data = directories.create();
    await encryptCredentialDirectory(data, keychain);
    const [stored] = [...items.values()];
    const credentials = directories.create();
    writeFileSync(join(credentials, SYSTEMD_CREDENTIAL_KEY_NAME), `${stored}\n`, { mode: 0o400 });

    expect(await moveCredentialKey(data, "systemd", keychain, credentials)).toMatchObject({ moved: true, keychain: "the test keychain" });
    expect(items.size).toBe(0);
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(REFERENCE);
  });

  it("refuses the keychain for a key kept as a systemd credential", async () => {
    const { data, credentials } = await serviceDirectories();
    await moveCredentialKey(data, "systemd", undefined, credentials);
    await expect(moveCredentialKey(data, "keychain", memoryKeychain().keychain)).rejects.toThrow(/move it into its file first/);
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(REFERENCE);
  });
});

describe("the owner's credentials key action", () => {
  const deps = (dataDirectory: string, fromBridge: boolean): ConfigDependencies => ({ dataDirectory, fromBridge }) as ConfigDependencies;

  it("moves the key on the service, which reads its own credentials", async () => {
    const { data, credentials } = await serviceDirectories();
    const answer = await asService(credentials, () => credentialsCommand(deps(data, false), { action: "key", to: "systemd" }));
    expect(answer).toMatchObject({ ok: true, result: { moved: true, systemd: SYSTEMD_CREDENTIAL_KEY_NAME } });
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(REFERENCE);
  });

  it("refuses a page, moving nothing", async () => {
    const { data, credentials } = await serviceDirectories();
    const before = readFileSync(join(data, "credentials.key"), "utf8");
    const answer = await asService(credentials, () => credentialsCommand(deps(data, true), { action: "key", to: "systemd" }));
    expect(answer).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(before);
  });
});

describe("tavi credentials key --export and --to-systemd", () => {
  it("writes the key to a pipe, and refuses a terminal", async () => {
    const { data, key } = await serviceDirectories();
    const piped = capture();
    expect(await main(["credentials", "key", "--export", "--data-dir", data], { io: piped.io })).toBe(EXIT.ok);
    expect(piped.stdout()).toBe(`${key}\n`);

    const terminal = capture(true);
    expect(await main(["credentials", "key", "--export", "--data-dir", data], { io: terminal.io })).toBe(EXIT.usage);
    expect(terminal.stdout()).toBe("");
    expect(terminal.stderr()).toContain("systemd-creds encrypt");
  });

  it("refuses --to-systemd with no service running, leaving the key", async () => {
    const { data } = await serviceDirectories();
    const before = readFileSync(join(data, "credentials.key"), "utf8");
    const printed = capture();
    expect(await main(["credentials", "key", "--to-systemd", "--data-dir", data], { io: printed.io })).toBe(EXIT.unavailable);
    expect(printed.stderr()).toContain("LoadCredentialEncrypted=tavi-credential-key");
    expect(readFileSync(join(data, "credentials.key"), "utf8")).toBe(before);
  });

  it("says where a systemd-kept key is, never the key", async () => {
    const { data, credentials, key } = await serviceDirectories();
    await moveCredentialKey(data, "systemd", undefined, credentials);
    const printed = capture();
    expect(await main(["credentials", "key", "--data-dir", data], { io: printed.io })).toBe(EXIT.ok);
    expect(printed.stdout()).toContain("systemd credential tavi-credential-key");
    expect(printed.stdout() + printed.stderr()).not.toContain(key);
  });

  it("takes one of the key flags", () => {
    expect(() => parseCredentials(["key", "--export", "--to-systemd"])).toThrow(/not both/);
    expect(parseCredentials(["key", "--to-systemd"])).toMatchObject({ credentials: { keyTo: "systemd" } });
    expect(parseCredentials(["key", "--export"])).toMatchObject({ credentials: { keyExport: true } });
  });
});

describe("tavi service unit --credential-encrypted", () => {
  it("renders a LoadCredentialEncrypted= line and says what the key's credential is for", () => {
    const unit = renderServiceUnit({
      kind: "systemd",
      label: "tavi",
      nodePath: "/usr/local/bin/node",
      executablePath: "/opt/tavi/dist/executable.mjs",
      dataDirectory: "/var/lib/tavi",
      systemd: {
        user: "tavi",
        credentials: [{ name: SYSTEMD_CREDENTIAL_KEY_NAME, path: "/etc/tavi/key.cred", encrypted: true }],
      },
    });
    expect(unit).toContain("LoadCredentialEncrypted=tavi-credential-key:/etc/tavi/key.cred");
    expect(unit).toContain("tavi credentials key --to-systemd");
  });
});
