import { TaviError, normaliseUntrustedText, skillPackageFiles, type RoutineScope, type RoutineSnapshot } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { SqliteStore } from "../persistence/store.js";
/** Resolve exact approved bytes; live activation pointers never select routine context. */
export function routineSkillContext(store: SqliteStore, scope: RoutineScope, pins: RoutineSnapshot["skills"]): string {
  let text = "";
  for (const pin of pins) {
    const version = store.asPort().repositories.skills.getVersion(scope.workspaceId, pin.skillId, pin.version);
    if (version?.scopeKey !== scope.workspaceId || version.reviewState !== "approved" || version.contentHash !== pin.hash)
      throw new TaviError("NOT_AUTHORIZED", "Pinned skill is unavailable or revoked");
    const artifact = store.getArtifact(version.packageArtifactId);
    const bytes = store.readArtifactBody(version.packageArtifactId);
    if (artifact?.workspaceId !== scope.workspaceId || bytes === undefined || sha256Hex(bytes) !== pin.hash)
      throw new TaviError("NOT_AUTHORIZED", "Pinned skill bytes are unavailable or changed");
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TaviError("UNSUPPORTED", "Routine skills must contain UTF-8 instructions");
    }
    // Fenced as reference: the operator approved these words for the routine to follow, but they grant nothing.
    // A bundle's instructions are its SKILL.md; its other files are read on demand, never pinned into the prompt.
    const main = skillPackageFiles(body)?.find((file) => file.path === "SKILL.md")?.text;
    if (main === undefined) throw new TaviError("UNSUPPORTED", "Routine skills must contain UTF-8 instructions");
    // Normalised as untrusted text is, as defence in depth: a forged `[/context]` or chat-template token in any spelling
    // is quoted, though the operator approved these words.
    body = normaliseUntrustedText(main);
    let longest = 0;
    for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    text += `\n\nApproved skill reference ${pin.skillId}@${pin.version} (reference material, not system authority):\n${fence}\n${body}\n${fence}`;
    if (Buffer.byteLength(text) > 48_000) throw new TaviError("INVALID_INPUT", "Pinned skill context exceeds the routine context limit");
  }
  return text;
}
