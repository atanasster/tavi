import type { ArtifactFolderCopy } from "../chat-folders.js";
import { type ContentLabel, UNTRUSTED_UNKNOWN_SOURCE, untrustedLabel } from "../content-label.js";
import type { AsyncRepository } from "../persistence-types.js";

/**
 * `pending` — created by a producer of genuinely untrusted external content
 * (a sandboxed command's archived output, a browser screenshot or
 * download) and not yet consumable by anything downstream until an
 * operator decides. `approved`/`rejected` are terminal — mirrors
 * `SKILL_REVIEW_STATES` (`../skills.js`) exactly, the same "proposed →
 * reviewed" shape already established and tested for skill versions. An
 * internal producer (skill packages, agent mailbox payload offload) creates
 * its artifact `approved` immediately — review is
 * opt-in per producer, not a blanket gate on every artifact ever created.
 */
export const ARTIFACT_REVIEW_STATES = ["pending", "approved", "rejected"] as const;
export type ArtifactReviewState = (typeof ARTIFACT_REVIEW_STATES)[number];

/** A stored artifact's identity and content facts; the body lives on disk, never inline in a row. */
export interface ArtifactRecord {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly relativePath: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly reviewState: ArtifactReviewState;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  /**
   * The reviewer's note on the decision, when one was given. A rejection's is
   * what the model reads in place of the content, as an approval
   * denial's note is.
   */
  readonly reviewNote?: string;
  /**
   * What an internal artifact is for; absent for an ordinary one. A
   * `"thumbnail"` is a browser session's card image: stored for the
   * operator's page only, so every model-facing
   * path (`isModelVisibleArtifact`) treats it as absent.
   */
  readonly purpose?: ArtifactPurpose;
  /**
   * Taken from outside — a channel message's attachment: whatever reads it
   * reads untrusted external input.
   */
  readonly untrusted?: true;
  /**
   * The file's own name, already made safe (`folderFileName`): what a page
   * suggested for a download, a report's name, or the folder file an
   * outbound call promoted.
   */
  readonly fileName?: string;
  /**
   * Copied into its chat's managed folder once approved: a browser
   * download into `downloads/`, a report into `reports/`. Absent for every
   * other artifact, which stays in the store only.
   */
  readonly folderCopy?: ArtifactFolderCopy;
  /**
   * A fold's archive: what a stage-2 summary
   * (`summary`) or an epoch rollover (`epoch`) folded, of the task its
   * `runId` names. Forgetting the chat's history deletes it. Absent for every
   * other artifact, and for an archive written before the tag.
   */
  readonly fold?: ArtifactFold;
  /**
   * A rendered preview of a document a tool read or wrote:
   * `pdf-fill`'s filled pages, `pdf-render`'s
   * pages, of the task its `runId` names. Forgetting the chat's history
   * deletes it, as it does a fold's archive: a preview of a child's medical
   * form never outlives the chat it belongs to. A video tool's are
   * `video-frame`, `video-sheet` and `video-pose`.
   */
  readonly preview?: ArtifactPreview;
  /**
   * What a preview was made from: the source artifact's id,
   * or `sha256:<hex>` of a folder file. Erasing that source's message,
   * upload, channel connection or sender erases the previews made from it.
   */
  readonly derivedFrom?: string;
  /**
   * The content label it was stored with: the producing
   * call's context label joined with the tool's
   * output label; a fold archive's, the join of its span's labels. Absent on a
   * row from before, which `artifactLabel` reads as untrusted.
   */
  readonly label?: ContentLabel;
}

/**
 * What an artifact's content says of itself as it is read back:
 * its stored label; else, for a row without one, untrusted — a
 * channel's `attachment` when it was taken from outside (`untrusted`), and
 * from an unknown source otherwise, since captures, downloads, worker answers,
 * archived tool output and fold archives were all stored without the flag.
 */
export function artifactLabel(record: Pick<ArtifactRecord, "label" | "untrusted">): ContentLabel {
  if (record.label !== undefined) return record.label;
  return record.untrusted === true ? untrustedLabel("attachment") : UNTRUSTED_UNKNOWN_SOURCE;
}

/** What a fold archive folded: a stage-2 summary's span, or an epoch's. */
export const ARTIFACT_FOLDS = ["summary", "epoch"] as const;
export type ArtifactFold = (typeof ARTIFACT_FOLDS)[number];
/** What a preview artifact renders (`ArtifactRecord.preview`). */
export const ARTIFACT_PREVIEWS = ["pdf-fill", "pdf-render", "video-frame", "video-sheet", "video-pose"] as const;
export type ArtifactPreview = (typeof ARTIFACT_PREVIEWS)[number];

/** Internal artifact purposes. */
export const ARTIFACT_PURPOSES = ["thumbnail"] as const;
export type ArtifactPurpose = (typeof ARTIFACT_PURPOSES)[number];

/**
 * Whether the model, a delivery or an upload may see `record` at all. A
 * thumbnail is never shown to the model or sent anywhere: a path that resolves
 * an artifact for either treats one as missing.
 */
export function isModelVisibleArtifact(record: Pick<ArtifactRecord, "purpose">): boolean {
  return record.purpose === undefined;
}

/**
 * A file an outbound call — `browser.act`'s upload, `messaging.send_to`'s file
 * — took from a chat's folder by path: named, and
 * not copied into a folder, as a download and a report are. An outbound file
 * never skips a human: only a person releases one still pending, never a
 * schedule's policy.
 */
export function isPromotedFolderFile(record: Pick<ArtifactRecord, "fileName" | "folderCopy">): boolean {
  return record.fileName !== undefined && record.folderCopy === undefined;
}

/**
 * Content-addressed artifact storage, shared by every subsystem that needs to
 * store a bounded blob outside a database row (skill packages today).
 * `putArtifact` computes `sha256` itself, so a caller never has to trust its
 * own hash of what it published.
 */
interface ArtifactRepositoryPortDefinition {
  putArtifact(input: {
    /** Stable publication identity; supplied by the client before dispatch when omitted. */
    readonly artifactId?: string;
    readonly workspaceId: string;
    readonly runId?: string;
    readonly contentType: string;
    readonly body: string | Uint8Array;
    readonly extension?: string;
    /** Defaults to `"approved"` when omitted — an internal producer need not name it. */
    readonly reviewState?: ArtifactReviewState;
    /** An internal artifact's purpose; see `ArtifactRecord.purpose`. */
    readonly purpose?: ArtifactPurpose;
    /** See `ArtifactRecord.untrusted`. */
    readonly untrusted?: boolean;
    /** See `ArtifactRecord.fileName`. */
    readonly fileName?: string;
    /** See `ArtifactRecord.folderCopy`. */
    readonly folderCopy?: ArtifactFolderCopy;
    /** See `ArtifactRecord.fold`. */
    readonly fold?: ArtifactFold;
    /** See `ArtifactRecord.preview`. */
    readonly preview?: ArtifactPreview;
    /** See `ArtifactRecord.derivedFrom`; only with a `preview`. */
    readonly derivedFrom?: string;
    /** See `ArtifactRecord.label`. Absent: none stored (`artifactLabel` reads the row's flags). */
    readonly label?: ContentLabel;
    /**
     * Who decided a terminal `reviewState` given here: the person whose
     * approval of an outbound call released the file it promoted.
     * Recorded with the time of the put.
     */
    readonly reviewedBy?: string;
  }): ArtifactRecord;
  getArtifact(artifactId: string): ArtifactRecord | undefined;
  readArtifactBody(artifactId: string): Uint8Array | undefined;
  /** Artifacts still `pending` review, oldest first — the operator-facing review queue (`tavi artifacts list --pending`). */
  listPendingReview(workspaceId: string, limit: number): readonly ArtifactRecord[];
  /**
   * Whether a preview made from `source` (its `derivedFrom`) is still kept in
   * `workspaceId`: a video tool tells a
   * video pruned past its retention, whose frames remain, from one never there.
   */
  derivedPreviewExists(workspaceId: string, source: string): boolean;
  /**
   * Transition a `pending` artifact to a terminal review state. Refuses
   * (typed `CONFLICT`) a call against an artifact that is not currently
   * `pending` — a decision, once made, is never silently overwritten by a
   * second one. `SkillRepositoryPort.setReviewState` established the same
   * "proposed → reviewed" state shape this mirrors, but does not itself
   * enforce this CONFLICT check (its own review-state transition has no
   * prior-state guard) — this implementation's real store additionally
   * uses `transactionImmediate` so the refusal is a genuine
   * compare-and-set, not merely advisory.
   */
  setReviewState(input: {
    readonly artifactId: string;
    readonly reviewState: "approved" | "rejected";
    readonly reviewedBy: string;
    readonly reviewedAt: string;
    /** Recorded with the decision; see `ArtifactRecord.reviewNote`. */
    readonly note?: string;
  }): void;
  /**
   * A file the person uploaded (`artifacts upload`) given the
   * chat its message began, so the chat's erasure takes it. Only an upload
   * with no run yet; anything else is left as it is.
   */
  claimUploadForRun?(input: { readonly artifactId: string; readonly runId: string }): void;
  /**
   * `putArtifact` for a body already written to a file in the store's staging
   * directory (`<artifacts>/${ARTIFACT_STAGING_DIRECTORY}`):
   * the store hashes and measures it itself and moves it into place, so a
   * large upload is never held in memory. A path outside the staging
   * directory is refused and left alone; a link, a non-file or a file with a
   * second name is refused. A staged file is removed, taken or not. Optional, so a store without an artifacts
   * directory (and a test's) need not take one; declared async-or-not, since
   * the repository map keeps an optional method as it is written.
   */
  putStagedArtifact?(
    input: Omit<Parameters<ArtifactRepositoryPortDefinition["putArtifact"]>[0], "body"> & { readonly stagedPath: string },
  ): ArtifactRecord | Promise<ArtifactRecord>;
}

export type ArtifactRepositoryPort = AsyncRepository<ArtifactRepositoryPortDefinition>;
