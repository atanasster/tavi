import {
  TRUSTED_PUBLIC,
  TaviError,
  joinLabels,
  untrustedLabel,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type ContentLabel,
  type InvocationContext,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";

import type { FolderFile } from "./fs-tools.js";

/**
 * A file of the chat's folder sent out by an outbound call — `browser.act`'s
 * upload, `messaging.send_to`'s file — by `path`. It leaves the chat only as an artifact, so the
 * review and audit store keeps what was sent: put once, from the bytes read
 * once (sha256 of those bytes, `run_id` the calling chat).
 *
 * Its review is the call's own approval: the card shows the file's name, size
 * and sha256 (`describe`, read by the assessor), and when a person approved
 * this very call (`ToolHandler.approvedBy`) the artifact is put `approved`
 * with them as its reviewer — refused if the bytes no longer have the hash
 * they were shown. A call no person was shown (a saved rule, a grant, a
 * flag) puts it `pending`: the turn then waits for its review like any
 * pending artifact, and nothing is sent by that call. A folder file never
 * becomes an artifact on its own.
 */

/** The largest folder file an outbound call sends. */
const PROMOTE_MAX_BYTES = 20 * 1024 * 1024;

/** What an approval card shows of a folder file. */
export interface FolderFileFacts {
  readonly shown: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** The assessor's reading of a path: the file's facts, or why the call is refused. */
export type FolderFileReading = FolderFileFacts | { readonly refused: string };

export interface PromotedFile {
  readonly record: ArtifactRecord;
  /** No person approved this call: the artifact waits for review, and nothing was sent. */
  readonly pending: boolean;
}

export interface FolderPromotion {
  describe(path: string, context: InvocationContext): FolderFileReading;
  /** `contextLabel`: the calling conversation's, stored with the artifact. */
  promote(input: {
    readonly path: string;
    readonly context: InvocationContext;
    readonly approvedBy?: string | undefined;
    readonly approvedContentHash?: string | undefined;
    readonly contextLabel?: ContentLabel | undefined;
  }): Promise<PromotedFile>;
}

/** Content types by extension, for the artifact's record; anything else is bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The facts as an approval card's detail shows them. */
export function folderFileDetail(facts: FolderFileFacts): string {
  return `File: ${facts.shown}\nSize: ${facts.size} bytes\nsha256: ${facts.sha256}`;
}

/** What a folder file carries from the chats that wrote it: their ids, and whether it is marked at all. */
export interface FolderFileTaint {
  readonly chats: readonly string[];
  readonly marked: boolean;
}

/**
 * What a promoted file is stored with: the
 * calling conversation's label, joined with the file's own origin — a page's,
 * for one in `downloads/`; the tainted chats', for one in a tainted chat's
 * managed folder or a host file a tainted chat wrote (`sandbox`, *Working
 * folders*).
 */
function promotedLabel(
  contextLabel: ContentLabel | undefined,
  file: Pick<FolderFile, "downloaded">,
  taint: FolderFileTaint,
  at: string,
): ContentLabel {
  const origin = file.downloaded === true ? untrustedLabel("download", { confidentiality: "personal" }) : TRUSTED_PUBLIC;
  const marked = taint.marked ? untrustedLabel("sandbox") : TRUSTED_PUBLIC;
  const folders = taint.chats.reduce(
    (label, chat) => joinLabels(label, untrustedLabel("sandbox", { ref: { ref: `chat:${chat}`, at } })),
    marked,
  );
  return joinLabels(joinLabels(contextLabel ?? TRUSTED_PUBLIC, origin), folders);
}

export function createFolderPromotion(options: {
  readonly read: (path: string, context: InvocationContext, maxBytes: number) => FolderFile;
  /** What the file carries from the chats that wrote it, read at promotion (`folderFileTaint`); absent, only its folder's stamped taint. */
  readonly taintOf?: (file: FolderFile, context: InvocationContext) => Promise<FolderFileTaint>;
  readonly artifacts: Pick<ArtifactRepositoryPort, "putArtifact">;
  /** The free-space floor: a promotion writes the artifact store, on the data directory's volume. */
  readonly space?: { checkFloor(): void };
}): FolderPromotion {
  return {
    describe: (path, context) => {
      try {
        const file = options.read(path, context, PROMOTE_MAX_BYTES);
        return { shown: file.shown, name: file.name, size: file.bytes.byteLength, sha256: file.sha256 };
      } catch (error) {
        return { refused: errorMessage(error) };
      }
    },
    promote: async ({ path, context, approvedBy, approvedContentHash, contextLabel }) => {
      options.space?.checkFloor();
      // Read once; these bytes are hashed, checked and stored (no second read to race).
      const file = options.read(path, context, PROMOTE_MAX_BYTES);
      if (approvedBy !== undefined && approvedContentHash !== file.sha256) {
        throw new TaviError(
          "CONFLICT",
          `${file.shown} changed after it was approved (sha256 ${approvedContentHash ?? "not shown"} then, ${file.sha256} now); nothing was sent. Call again to have it approved as it is now.`,
        );
      }
      const taint = (await options.taintOf?.(file, context)) ?? {
        chats: file.taintedChat === undefined ? [] : [file.taintedChat],
        marked: file.taintedChat !== undefined,
      };
      const extension = extensionOf(file.name);
      const record = await options.artifacts.putArtifact({
        workspaceId: context.workspaceId,
        runId: context.runId,
        contentType: (extension === undefined ? undefined : CONTENT_TYPES[extension]) ?? "application/octet-stream",
        body: file.bytes,
        ...(extension === undefined ? {} : { extension }),
        fileName: file.name,
        ...(approvedBy === undefined ? { reviewState: "pending" as const } : { reviewState: "approved" as const, reviewedBy: approvedBy }),
        ...(contextLabel === undefined && file.downloaded !== true && !taint.marked
          ? {}
          : { label: promotedLabel(contextLabel, file, taint, nowTimestamp()) }),
      });
      return { record, pending: approvedBy === undefined };
    },
  };
}

/**
 * The tool result for a file put `pending` (no person approved the call): it
 * names the artifact, so the turn waits for its review, and says how to send
 * it once approved.
 */
export function awaitingReview(tool: string, promoted: PromotedFile): Readonly<Record<string, unknown>> {
  return {
    status: "awaiting_review",
    artifactId: promoted.record.artifactId,
    detail:
      `Nothing was sent: no person approved this ${tool} call, so ${promoted.record.fileName ?? "the file"} ` +
      `was stored as artifact ${promoted.record.artifactId} pending review. Once it is approved, call ${tool} again with artifactId ${promoted.record.artifactId}.`,
  };
}
