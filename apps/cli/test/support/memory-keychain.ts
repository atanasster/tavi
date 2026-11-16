import type { CredentialKeychain } from "@tavi/runtime";

/**
 * An in-memory macOS keychain for the credential-key tests, so no test runs
 * `security` or `secret-tool`. `refuse` makes every call throw, as a locked
 * keychain does; `items` is what it holds, by account.
 */
export function memoryKeychain(options: { readonly refuse?: boolean } = {}): {
  readonly keychain: CredentialKeychain;
  readonly items: Map<string, string>;
} {
  const items = new Map<string, string>();
  const keychain: CredentialKeychain = {
    kind: "macos",
    label: "the test keychain",
    async get(account) {
      if (options.refuse === true) throw new Error("locked");
      return items.get(account);
    },
    async add(account, secret) {
      if (options.refuse === true) throw new Error("locked");
      items.set(account, secret);
    },
    async delete(account) {
      if (options.refuse === true) throw new Error("locked");
      items.delete(account);
    },
  };
  return { keychain, items };
}
