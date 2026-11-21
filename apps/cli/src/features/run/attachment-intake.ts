import {
  MAX_PROMPT_ATTACHMENTS,
  TaviError,
  UPLOAD_CONTENT_TYPES,
  untrustedLabel,
  type ArtifactRepositoryPort,
  type InboundBlock,
} from "@tavi/contracts";
import { attachmentLine } from "@tavi/runtime";

import { ATTACHMENT_HEADING } from "../channels/inbound-turn.js";

/**
 * The attachments a web UI message names:
 * uploaded PDFs, photos, videos, GIFs and audio files of its workspace, each as the line a channel
 * attachment leaves in the prompt. Only what `artifacts upload` kept is named:
 * an approved, model-visible, untrusted file of a type it takes, labelled
 * `attachment`. Any other id is the same `NOT_FOUND`.
 */
export interface NamedAttachment {
  readonly artifactId: string;
  readonly filename?: string;
  readonly line: string;
}

export async function namedAttachments(
  artifacts: Pick<ArtifactRepositoryPort, "getArtifact">,
  workspaceId: string,
  ids: readonly string[] | undefined,
): Promise<readonly NamedAttachment[]> {
  if (ids === undefined || ids.length === 0) return [];
  if (new Set(ids).size !== ids.length || ids.length > MAX_PROMPT_ATTACHMENTS)
    throw new TaviError("INVALID_INPUT", `A message names up to ${MAX_PROMPT_ATTACHMENTS} attachments, each once`);
  const named: NamedAttachment[] = [];
  for (const artifactId of ids) {
    const record = await artifacts.getArtifact(artifactId);
    const kept =
      record !== undefined &&
      record.workspaceId === workspaceId &&
      (UPLOAD_CONTENT_TYPES as readonly string[]).includes(record.contentType) &&
      record.reviewState === "approved" &&
      record.purpose === undefined &&
      record.untrusted === true &&
      record.label?.sources.includes("attachment") === true;
    if (!kept)
      throw new TaviError("NOT_FOUND", `attachment ${artifactId} is not an uploaded file of workspace ${workspaceId}; attach it again`);
    named.push({
      artifactId,
      ...(record.fileName === undefined ? {} : { filename: record.fileName }),
      line: attachmentLine(record.fileName, record.contentType, record.byteSize, artifactId),
    });
  }
  return named;
}

/** `named`'s lines, as the message quotes them: "" for none. */
export const attachmentText = (named: readonly NamedAttachment[]): string => named.map((entry) => entry.line).join("\n\n");

/** `named` as one quoted block of a new chat's first turn, labelled `attachment` for `principal`. */
export function attachmentBlock(named: readonly NamedAttachment[], principal: string): InboundBlock | undefined {
  if (named.length === 0) return undefined;
  return { text: attachmentText(named), heading: ATTACHMENT_HEADING, label: untrustedLabel("attachment", { principal }) };
}
