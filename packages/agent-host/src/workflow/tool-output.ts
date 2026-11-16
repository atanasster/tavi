import {
  type ContentLabel,
  type ArtifactRepositoryPort,
  type InvocationContext,
  MAX_TOOL_RESULT_BYTES,
  boundToolOutput,
} from "@tavi/contracts";

/** The most of an archived result the model is shown in place, in characters of its JSON. */
export const ARCHIVED_PREVIEW_CHARS = 8_000;

/** The caps `previewOf` tries, longest first: a string past `chars` keeps its head and tail, an array past `items` its first ones. */
const PREVIEW_CAPS: readonly { readonly chars: number; readonly items: number }[] = [
  { chars: 4_000, items: 50 },
  { chars: 1_500, items: 20 },
  { chars: 600, items: 10 },
  { chars: 200, items: 5 },
  { chars: 80, items: 3 },
];

/** `value` with every string over `chars` cut to its head and tail, and every array over `items` to its first ones. */
function shortened(value: unknown, cap: { readonly chars: number; readonly items: number }, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= cap.chars) return value;
    const half = Math.floor(cap.chars / 2);
    return `${value.slice(0, half)}…[${value.length - 2 * half} characters left out]…${value.slice(-half)}`;
  }
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, cap.items).map((entry) => shortened(entry, cap, depth + 1));
    return value.length > cap.items ? [...kept, `…[${value.length - cap.items} more items left out]`] : kept;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shortened(entry, cap, depth + 1)]));
}

/**
 * What the model is shown in place of an archived result: its own shape, its
 * long strings cut to head and tail (a log's error is at its end) and its long
 * lists to their first items, within `ARCHIVED_PREVIEW_CHARS` — never a byte
 * slice cut mid-structure. A result no cap brings that low is shown as the head
 * of its JSON.
 */
export function previewOf(output: unknown): string {
  for (const cap of PREVIEW_CAPS) {
    const text = JSON.stringify(shortened(output, cap)) ?? "null";
    if (text.length <= ARCHIVED_PREVIEW_CHARS) return text;
  }
  return (JSON.stringify(output) ?? "null").slice(0, ARCHIVED_PREVIEW_CHARS);
}

/**
 * Bound a tool result for the message/receipt it enters, archiving it as a
 * retrievable artifact instead of discarding it.
 * Without `artifacts` configured, falls back to `boundToolOutput`'s
 * existing lossy truncation unchanged — matching the "capability omitted ⇒
 * byte-identical" invariant already used for `memory`. Within the
 * bound, `output` passes through unchanged except that `undefined` is
 * normalized to `null`, matching `boundToolOutput`'s own behavior.
 *
 * Archiving is additive, never blocking: an `artifacts` implementation that
 * cannot durably store a payload (for example a store with no configured
 * artifacts directory, as `--in-memory` CLI mode currently is) falls back to
 * `boundToolOutput`'s lossy-but-successful truncation rather than failing
 * the tool call — a thrown `putArtifact` is treated as "archiving
 * unavailable for this call," never as a reason to surface `TOOL_FAILED` to
 * the model.
 *
 * **Created `approved`, with its label**: size is not a risk signal, so a large
 * result does not stop the turn for a person. The archive keeps the call's
 * label, so taint travels with it, and a tool that made an artifact a person
 * must review (a capture, a download) still has it reviewed: dispatch looks
 * for pending artifacts in the result as the tool returned it, before it is
 * archived (`collectPendingReviewArtifactIds`); the archive itself is never
 * pending.
 */
export async function archiveToolOutput(
  artifacts: ArtifactRepositoryPort | undefined,
  context: InvocationContext,
  output: unknown,
  /** The call's context label joined with its result's, stored with the archive. */
  label?: ContentLabel,
): Promise<unknown> {
  if (artifacts === undefined) return boundToolOutput(output);
  const bytes = new TextEncoder().encode(JSON.stringify(output ?? null));
  if (bytes.byteLength <= MAX_TOOL_RESULT_BYTES) return output ?? null;
  try {
    const record = await artifacts.putArtifact({
      workspaceId: context.workspaceId,
      runId: context.runId,
      contentType: "application/json",
      body: bytes,
      reviewState: "approved",
      ...(label === undefined ? {} : { label }),
    });
    return {
      truncated: true,
      note: `tool output exceeded ${MAX_TOOL_RESULT_BYTES} bytes: the preview shortens it, and the whole result is kept as artifact ${record.artifactId} (read it with artifacts.read)`,
      preview: previewOf(output),
      artifactId: record.artifactId,
    };
  } catch {
    return boundToolOutput(output);
  }
}

/**
 * Every artifact a tool's output references that is still `pending` review in
 * the call's workspace right now — read live from the repository, never
 * guessed from the tool's name or output shape, so ANY producer
 * (`browser.capture`, `browser.act` downloads, a sandbox run's files) is
 * covered by one mechanism. Dispatch reads the result as the tool returned
 * it, before archiving, so a large result cannot hide what it named.
 * Recognizes exactly the two field shapes this codebase's real producers
 * use: `artifactId: string` (`BrowserCaptureResult`) and
 * `artifactIds: readonly string[]` (`SandboxRunResult`).
 *
 * The result may be large and hold untrusted text, so the walk is bounded:
 * `MAX_SCAN_DEPTH` deep, and at most `MAX_SCANNED_IDS` ids looked up. An id
 * of another workspace's artifact is not this call's to review, and is left
 * out.
 */
const MAX_SCAN_DEPTH = 6;
/** The most artifact ids one result's scan looks up: a real producer names a few. */
const MAX_SCANNED_IDS = 32;

export async function collectPendingReviewArtifactIds(
  artifacts: ArtifactRepositoryPort | undefined,
  workspaceId: string,
  value: unknown,
): Promise<string[]> {
  if (artifacts === undefined) return [];
  const candidates = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > MAX_SCAN_DEPTH || candidates.size >= MAX_SCANNED_IDS) return;
    const record = node as Record<string, unknown>;
    const note = (id: unknown): void => {
      if (typeof id === "string" && candidates.size < MAX_SCANNED_IDS) candidates.add(id);
    };
    note(record["artifactId"]);
    if (Array.isArray(record["artifactIds"])) for (const id of record["artifactIds"]) note(id);
    for (const nested of Object.values(record)) walk(nested, depth + 1);
  };
  walk(value, 0);
  const found: string[] = [];
  for (const id of candidates) {
    const record = await artifacts.getArtifact(id);
    if (record?.reviewState === "pending" && record.workspaceId === workspaceId) found.push(id);
  }
  return found;
}
