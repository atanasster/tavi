import { emitJson } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { errorMessage, plural } from "@tavi/contracts/util";
import { CREDENTIAL_KEYCHAIN_SERVICE, exportCredentialKey, ModelConfigService, SYSTEMD_CREDENTIAL_KEY_NAME } from "@tavi/runtime";
import {
  assertSecretReference,
  createLocalCredentialStore,
  credentialKeyFile,
  credentialKeyLocation,
  encryptCredentialDirectory,
  listCredentialRefs,
  moveCredentialKey,
  readCredentialValueFromFile,
  type CredentialEncryption,
  type CredentialKeyLocation,
  type CredentialKeyMoveResult,
} from "./store.js";
import type { CredentialsCommandOptions } from "./parse.js";
import type { OutputFormat } from "../../cli/parse.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withOwnership, withStore } from "../../cli/store.js";
import { connectionsNaming } from "../models/actions.js";
import { GLYPHS } from "../../tui/theme.js";

/**
 * `tavi credentials set|list|delete`.
 *
 * Operator-only: the agent has no path to any of this, and no action here
 * prints a value. With no owner running it takes the directory's ownership;
 * under a live `serve` it runs on the owner, whose chain reads a
 * credential at resolution time, so a new value applies to the next call.
 */
export async function credentialsCommand(options: ResolvedDataDirectory<CredentialsCommandOptions>, io: CliIo): Promise<number> {
  // Validate the reference before touching the filesystem, so a bad argument is
  // a usage error (2) rather than an internal one (70) — and costs no file read.
  let reference: string | undefined;
  try {
    reference = options.credentialRef === undefined ? undefined : assertSecretReference(options.credentialRef);
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return EXIT.usage;
  }

  if (options.action === "key") return credentialKeyCommand(options, io);

  const onOwner = await credentialsOnOwner(options, reference, io);
  if (onOwner !== undefined) return onOwner;

  try {
    // The connections still naming the key are read from the database: this one action opens it.
    if (options.action === "delete") {
      const name = reference ?? "";
      const namedBy = await withStore(options.dataDirectory, async (database) => {
        await createLocalCredentialStore(options.dataDirectory).deleteSecret(name);
        return await connectionsNaming(new ModelConfigService(database.asPort()), name);
      });
      renderCredentialDeleted(name, namedBy, io);
      return EXIT.ok;
    }
    return await withOwnership(options.dataDirectory, async () => {
      const store = createLocalCredentialStore(options.dataDirectory);
      switch (options.action) {
        case "set": {
          const name = reference ?? "";
          // Opened once with O_NOFOLLOW and fstat'ed, so the 0600 check applies
          // to the inode actually read.
          const value = await readCredentialValueFromFile(name, options.file ?? "");
          await store.setSecret(name, value);
          // The value is never echoed — only where it went.
          io.stdout(`stored credential ${name}\n`);
          return EXIT.ok;
        }
        case "list": {
          const { valid, invalid } = await listCredentialRefs(options.dataDirectory);
          renderCredentialList({ credentials: valid, unusable: invalid }, options.format, io);
          return EXIT.ok;
        }
        case "encrypt":
          renderCredentialEncryption(await encryptCredentialDirectory(options.dataDirectory), options.format, io);
          return EXIT.ok;
        default:
          io.stderr("unsupported credentials action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    // A mistyped or unreadable `--file` is a usage error (2), as under an owner;
    // ownership contention keeps its own exit (5).
    return reportCommandFailure(error, io, "credentials command failed");
  }
}

/**
 * `tavi credentials key [--to-file|--to-keychain|--export]`, here and not on
 * an owner: an owner run as a service may be exactly the process that cannot
 * reach the keychain, and this command needs it. Nor does it take the
 * directory's ownership, so a running service need not stop: it touches only
 * `credentials.key`, replaced whole with a rename after checking it is
 * unchanged, and an owner reads that file on each access — before the move or
 * after it, it finds the same key.
 *
 * A key kept as a systemd credential is the exception: only the service
 * systemd started reads it, so `--to-systemd`, and `--to-file` away from one,
 * run on the owner, and with none running they are refused.
 */
async function credentialKeyCommand(options: ResolvedDataDirectory<CredentialsCommandOptions>, io: CliIo): Promise<number> {
  try {
    if (options.keyExport === true) return await exportKey(options.dataDirectory, io);
    const location = await credentialKeyLocation(options.dataDirectory);
    const onService = options.keyTo === "systemd" || (options.keyTo === "file" && location.kept === "systemd");
    if (onService) return await credentialKeyOnService(options, io);
    if (options.keyTo === undefined) {
      renderCredentialKeyLocation(location, options.format, io);
      return EXIT.ok;
    }
    const result = await moveCredentialKey(options.dataDirectory, options.keyTo);
    renderCredentialKeyMove(result, options.format, io);
    return EXIT.ok;
  } catch (error) {
    return reportCommandFailure(error, io, "credentials key failed");
  }
}

/** `--export`: the key, for `systemd-creds encrypt` on standard input; never onto a terminal, where it would stay on screen. */
async function exportKey(dataDirectory: string, io: CliIo): Promise<number> {
  if (io.stdoutTty ?? io.isTty) {
    io.stderr(
      "credentials key --export writes the key itself: pipe it, as in " +
        `\`tavi credentials key --export | systemd-creds encrypt --name=${SYSTEMD_CREDENTIAL_KEY_NAME} - <file>\`, never to a terminal\n`,
    );
    return EXIT.usage;
  }
  io.stdout(`${await exportCredentialKey(credentialKeyFile(dataDirectory))}\n`);
  return EXIT.ok;
}

/** A move to or from the systemd credential, on the running service, which alone reads it. */
async function credentialKeyOnService(options: ResolvedDataDirectory<CredentialsCommandOptions>, io: CliIo): Promise<number> {
  const to = options.keyTo === "systemd" ? "systemd" : "file";
  const onOwner = await configOnOwner(options.dataDirectory, "credentials", io, {
    label: `tavi credentials key --to-${to}`,
    mutates: true,
    build: () => Promise.resolve({ action: "key", to }),
    render: (result) => {
      renderCredentialKeyMove(result as CredentialKeyMoveResult, options.format, io);
      return EXIT.ok;
    },
  });
  if (onOwner !== undefined) return onOwner;
  io.stderr(
    `credentials key --to-${to}: only the service systemd starts with LoadCredentialEncrypted=${SYSTEMD_CREDENTIAL_KEY_NAME}:<file> ` +
      "reads that credential; start it (`tavi service install --credential-encrypted …`) and run this again\n",
  );
  return EXIT.unavailable;
}

/** `credentials delete`'s answer, and on stderr the connections still naming the key, with the way back. */
function renderCredentialDeleted(reference: string, namedBy: readonly string[], io: CliIo): void {
  io.stdout(`deleted credential ${reference}\n`);
  if (namedBy.length === 0) return;
  io.stderr(
    `${GLYPHS.warning} the model ${namedBy.length === 1 ? "connection" : "connections"} ${namedBy.join(", ")} still ` +
      `${namedBy.length === 1 ? "names" : "name"} ${reference}: store it again with \`tavi credentials set ${reference} --file <path>\`, ` +
      "or point each at another with `tavi models rebind <id> --credential <name>`\n",
  );
}

/** Where the key is kept — never the key. */
function renderCredentialKeyLocation(location: CredentialKeyLocation, format: OutputFormat, io: CliIo): void {
  if (format === "json") {
    emitJson(io, location);
    return;
  }
  if (location.kept === "none") io.stdout(`no credential key: the store is not encrypted (\`tavi credentials encrypt\` turns it on)\n`);
  else if (location.kept === "file")
    io.stdout(
      `the credential key is in ${location.keyFile}; keep a copy of it, but not with the data directory's backups: ` +
        "a backup that holds both gives away every credential\n",
    );
  else if (location.kept === "systemd")
    io.stdout(
      `the credential key is the systemd credential ${location.systemd ?? ""}; ${location.keyFile} only refers to it, ` +
        "and only the service systemd starts with it can read it. `tavi credentials key --to-file`, against the running service, moves it back.\n",
    );
  else
    io.stdout(
      `the credential key is kept in ${location.keychain} (service ${CREDENTIAL_KEYCHAIN_SERVICE}, account ${location.item?.account ?? ""}); ` +
        `${location.keyFile} only refers to it.\n` +
        "A backup restored on another machine, or a service with no keychain, cannot read it: `tavi credentials key --to-file` moves it into the file.\n",
    );
}

/** What a move did, and what the key's new home asks of a backup. */
function renderCredentialKeyMove(result: CredentialKeyMoveResult, format: OutputFormat, io: CliIo): void {
  if (format === "json") emitJson(io, result);
  else if (!result.moved) io.stdout(`the credential key is in ${KEY_HOMES[result.to](result)} already; nothing changed\n`);
  else if ("systemd" in result) renderSystemdMove(result, io);
  else if (result.to === "file")
    io.stdout(
      `moved the credential key from ${result.keychain} into ${result.keyFile} (0600); no credential was re-encrypted.\n` +
        "Back it up as you would the credentials themselves, and keep the two copies apart.\n",
    );
  else
    io.stdout(
      `moved the credential key from ${result.keyFile} into ${result.keychain} (service ${CREDENTIAL_KEYCHAIN_SERVICE}, account ${result.item.account}); ` +
        `${result.keyFile} now refers to it, and no credential was re-encrypted.\n`,
    );
  if (result.moved && result.deleteError !== undefined && result.item !== undefined) {
    io.stderr(
      `${GLYPHS.warning} the key is in ${"systemd" in result ? `the systemd credential ${result.systemd}` : result.keyFile} and used from there, ` +
        `but the item in ${result.keychain} (service ${CREDENTIAL_KEYCHAIN_SERVICE}, account ${result.item.account}) could not be deleted: ` +
        `${result.deleteError}; delete it there\n`,
    );
  }
}

/** Where each home is, said of an unmoved key. */
const KEY_HOMES: Readonly<Record<CredentialKeyMoveResult["to"], (result: CredentialKeyMoveResult) => string>> = {
  file: (result) => result.keyFile,
  keychain: () => "the OS keychain",
  systemd: () => `the systemd credential ${SYSTEMD_CREDENTIAL_KEY_NAME}`,
};

/** A move to the systemd credential, or from it into the file. */
function renderSystemdMove(result: CredentialKeyMoveResult & { readonly moved: true; readonly systemd: string }, io: CliIo): void {
  if (result.to === "file") {
    io.stdout(
      `moved the credential key from the systemd credential ${result.systemd} into ${result.keyFile} (0600); no credential was re-encrypted.\n` +
        "Drop LoadCredentialEncrypted= from the unit once nothing needs it, and keep the file apart from the data directory's backups.\n",
    );
    return;
  }
  io.stdout(
    `${result.keyFile} now refers to the systemd credential ${result.systemd}, which holds the same key; no credential was re-encrypted.\n` +
      "The encrypted credential file is bound to this machine (and its TPM, if used): keep a copy of the key elsewhere, " +
      "for a restore on another machine.\n",
  );
}

/** `tavi credentials <action>` on a live owner, into the same `0600` store; a value is read here and never echoed. */
function credentialsOnOwner(
  options: ResolvedDataDirectory<CredentialsCommandOptions>,
  reference: string | undefined,
  io: CliIo,
): Promise<number | undefined> {
  const name = reference ?? "";
  return configOnOwner(options.dataDirectory, "credentials", io, {
    label: `tavi credentials ${options.action}`,
    mutates: options.action !== "list",
    build: async () => {
      switch (options.action) {
        case "set":
          // Opened once with O_NOFOLLOW and fstat'ed, as offline: the value
          // crosses the local socket once.
          return { action: "set", reference: name, value: await readCredentialValueFromFile(name, options.file ?? "") };
        case "delete":
          return { action: "delete", reference: name };
        case "encrypt":
          return { action: "encrypt" };
        default:
          return { action: "list" };
      }
    },
    render: (result) => {
      if (options.action === "set") io.stdout(`stored credential ${name}\n`);
      else if (options.action === "delete")
        renderCredentialDeleted(name, (result as { readonly namedBy?: readonly string[] }).namedBy ?? [], io);
      else if (options.action === "encrypt") renderCredentialEncryption(result as CredentialEncryption, options.format, io);
      else
        renderCredentialList(
          result as { readonly credentials: readonly string[]; readonly unusable: readonly string[] },
          options.format,
          io,
        );
      return EXIT.ok;
    },
  });
}

/** What `credentials encrypt` did, and the one thing to do next: keep the key. */
function renderCredentialEncryption(result: CredentialEncryption, format: OutputFormat, io: CliIo): void {
  if (format === "json") {
    emitJson(io, result);
    return;
  }
  io.stdout(
    `${result.keyCreated ? "created the key" : "used the key"} ${result.keychain === undefined ? result.keyFile : `in ${result.keychain} (referred to by ${result.keyFile})`}; ` +
      `encrypted ${result.encrypted.length === 0 ? "no credential" : plural(result.encrypted.length, "credential")}` +
      `${result.alreadyEncrypted.length === 0 ? "" : `, ${result.alreadyEncrypted.length} already encrypted`}\n` +
      (result.removedTemporaries === 0
        ? ""
        : `removed ${plural(result.removedTemporaries, "temporary file")} an interrupted write left behind\n`) +
      (result.keychain === undefined
        ? "Keep the key apart from any copy of the credentials: without it they cannot be read, and it is never regenerated.\n"
        : `Keep the item in ${result.keychain}: without it the credentials cannot be read, and it is never regenerated. ` +
          "A backup does not carry it; `tavi credentials key --to-file` moves it into the file, for a backup or a system service.\n"),
  );
  // Said, not skipped: what this key cannot read, and what is still in the clear.
  if (result.undecryptable.length > 0) {
    io.stderr(`${GLYPHS.warning} not readable with this key (another directory's key, or altered): ${result.undecryptable.join(", ")}\n`);
  }
  if (result.unencrypted.length > 0) {
    io.stderr(`${GLYPHS.warning} left as they are, not encrypted — they are no credential reference: ${result.unencrypted.join(", ")}\n`);
  }
}

/** `tavi credentials list`'s output: the references, and a warning for each file that is not one. */
function renderCredentialList(
  listed: { readonly credentials: readonly string[]; readonly unusable: readonly string[] },
  format: OutputFormat,
  io: CliIo,
): void {
  if (format === "json") {
    emitJson(io, { credentials: listed.credentials, unusable: listed.unusable });
    return;
  }
  io.stdout(listed.credentials.length === 0 ? "(no credentials configured)\n" : `${listed.credentials.join("\n")}\n`);
  // Surfaced rather than hidden: a hand-dropped file that can never be
  // resolved is a mistake the operator should see.
  for (const name of listed.unusable) {
    io.stderr(`warning: ${name} is present but is not a usable credential reference; ignoring it\n`);
  }
}
