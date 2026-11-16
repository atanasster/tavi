import { join } from "node:path";
import { TaviError, WebProviderConfigurationSchema, type WebProviderConfiguration } from "@tavi/contracts";
import { NoFollowReadError, readNoFollowSync } from "@tavi/node-kit";

/** The most `web-providers.json` may hold. */
const MAX_BYTES = 65_536;

/** Local operator configuration; captured once so editing it requires restart. */
export function readWebProviderConfiguration(directory: string): WebProviderConfiguration {
  let bytes: Buffer | undefined;
  try {
    bytes = readNoFollowSync(join(directory, "web-providers.json"), { maxBytes: MAX_BYTES });
  } catch (error) {
    if (error instanceof NoFollowReadError)
      throw new TaviError("INVALID_INPUT", "web-providers.json must be a regular file of at most 64 KiB", { cause: error });
    throw error;
  }
  if (bytes === undefined) return { schemaVersion: 1, workspaces: {} };
  // One line naming the file and its first problem, never the validator's whole report.
  const path = join(directory, "web-providers.json");
  const remedy = "fix it or remove it (it holds only the search provider choices)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", `${path} is not valid JSON; ${remedy}`);
  }
  const checked = WebProviderConfigurationSchema.safeParse(parsed);
  if (checked.success) return checked.data;
  const issue = checked.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  throw new TaviError("INVALID_INPUT", `${path} is not a valid search provider file${where}: ${issue?.message ?? "invalid"}; ${remedy}`);
}
