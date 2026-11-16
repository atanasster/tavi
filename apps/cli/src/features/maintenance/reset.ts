import { emit } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { BUILTIN_MEMORY_PROVIDER_ID, RESET_INSTANCE_CONFIRMATION, type ResetInstanceResult } from "@tavi/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CredentialKeychain, ResetResult } from "@tavi/runtime";
import { externalMemoryIndexNote } from "../memory/providers.js";
import type { ResetCommandOptions } from "./parse.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { withOwnership, withStore } from "../../cli/store.js";

/**
 * The memory providers other than the built-in that the directory's
 * workspaces select, every workspace with stored settings, read
 * through the database worker before a reset deletes them: an index such a
 * plugin keeps is outside the directory. Sorted, once each. None when there is
 * no database or it cannot be read; a reset never fails over it.
 */
export async function externalMemoryProvidersOf(dataDirectory: string): Promise<readonly string[]> {
  if (!existsSync(join(dataDirectory, "tavi.sqlite"))) return [];
  try {
    const records = await withStore(dataDirectory, async (store) => await store.asPort().repositories.workspaceSettings.list());
    const providers = new Set<string>();
    for (const record of records) {
      const provider = record.settings.memory?.provider;
      if (provider !== undefined && provider !== BUILTIN_MEMORY_PROVIDER_ID) providers.add(provider);
    }
    return [...providers].sort();
  } catch {
    return [];
  }
}

/** What a reset did: the directory's entries, and the credential key's keychain item when it had one. */
export type DataDirectoryReset = ResetResult & {
  /** What became of the keychain item the deleted `credentials.key` referred to. Absent when it referred to none. */
  readonly keychainItem?: string;
};

/**
 * Reset `dataDirectory` under its ownership, then delete the keychain item its
 * credential key was kept in: nothing refers to it once the directory is
 * reset. The item is read first and deleted only after the reset succeeded, so
 * a reset that stops part-way leaves a key the remaining files can still use.
 * `keychain` is the one the item is in; by default the one its reference names. Tests inject one.
 */
export async function resetDataDirectoryAndKey(
  dataDirectory: string,
  memoryProviders: readonly string[],
  keychain?: CredentialKeychain,
): Promise<DataDirectoryReset> {
  const { resetDataDirectory } = await import("@tavi/runtime");
  const { credentialKeyItemOf, forgetCredentialKeyItem } = await import("../credentials/store.js");
  return await withOwnership(
    dataDirectory,
    async () => {
      const item = await credentialKeyItemOf(dataDirectory);
      const result = resetDataDirectory(dataDirectory, { memoryProviders });
      return item === undefined ? result : { ...result, keychainItem: await forgetCredentialKeyItem(item, keychain) };
    },
    "a reset deletes the database it is using",
  );
}

/** What a reset deleted, and what it left because tavi did not put it there. */
export function resetSummary(dataDirectory: string, result: DataDirectoryReset): string {
  return (
    `reset ${dataDirectory}: deleted ${result.removed.length === 0 ? "nothing (it was empty)" : result.removed.join(", ")}\n` +
    (result.keychainItem === undefined ? "" : `${result.keychainItem}\n`) +
    (result.kept.length === 0 ? "" : `left in place (not tavi's): ${result.kept.join(", ")}\n`) +
    // An external memory provider's own index is outside the directory.
    (result.memoryProviders === undefined ? "" : `${externalMemoryIndexNote(result.memoryProviders)}\n`)
  );
}

/**
 * `tavi reset --yes`: delete the data directory's state. A live owner
 * does it itself — it stops, deletes and serves again — since its database is
 * open; with none, the directory is reset here under its ownership lock.
 */
export async function resetCommand(options: ResetCommandOptions, io: CliIo): Promise<number> {
  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  try {
    const onOwner = await configOnOwner(dataDirectory, "reset-instance", io, {
      label: "tavi reset",
      mutates: true,
      build: () => ({ confirm: RESET_INSTANCE_CONFIRMATION }),
      render: (answer) => {
        const memoryProviders = (answer as ResetInstanceResult | undefined)?.memoryProviders ?? [];
        emit(
          io,
          options.format,
          { dataDirectory, resetting: true, ...(memoryProviders.length === 0 ? {} : { memoryProviders }) },
          () =>
            `the owner of ${dataDirectory} is stopping to reset it, and starts again on the empty directory\n` +
            (memoryProviders.length === 0 ? "" : `${externalMemoryIndexNote(memoryProviders)}\n`),
        );
        return EXIT.ok;
      },
    });
    if (onOwner !== undefined) return onOwner;
    const memoryProviders = await externalMemoryProvidersOf(dataDirectory);
    const result = await resetDataDirectoryAndKey(dataDirectory, memoryProviders);
    emit(io, options.format, { dataDirectory, ...result }, () => resetSummary(dataDirectory, result));
    return EXIT.ok;
  } catch (error) {
    return reportCommandFailure(error, io, "reset command failed");
  }
}
