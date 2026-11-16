import { createHmac } from "node:crypto";
import { join } from "node:path";
import { createCredentialKey, readCredentialKey } from "@tavi/runtime";
import { TaviError } from "@tavi/contracts";

/** A private profile key makes credential revisions stable without publishing secret hashes. */
export function providerCredentialRevision(directory: string) {
  let key: Promise<Buffer> | undefined;
  const load = async () => {
    const path = join(directory, "provider-bindings.key");
    await createCredentialKey(path);
    const value = await readCredentialKey(path);
    if (value === undefined) throw new TaviError("UNAVAILABLE", "Provider binding key vanished during activation");
    return value;
  };
  return async (reference: string, value: string | null): Promise<string> => {
    key ??= load();
    return createHmac("sha256", await key)
      .update(JSON.stringify({ reference, value }))
      .digest("hex");
  };
}
