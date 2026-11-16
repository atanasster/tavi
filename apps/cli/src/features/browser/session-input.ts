import { type InvocationContext, TaviError } from "@tavi/contracts";
import type { z } from "zod";

/** Who opened a browser session in this process: its workspace, and the chat it was opened in (`chatOf`). */
export interface SessionOpener {
  readonly workspaceId: string;
  readonly chatId: string;
}

/** The chat a call is made in: a delegated task's is its delegation root (`chatTaskId`); any other task is its own chat. */
export function chatOf(context: Pick<InvocationContext, "runId" | "chatTaskId">): string {
  return context.chatTaskId ?? context.runId;
}

/**
 * Refuses a call on a session another workspace, or another chat, opened: a session is its chat's, and the chat's
 * sub-tasks', whichever of them opened it. A session this process did not open (`opener` undefined) is left to the port.
 */
export function requireSessionOf(
  sessionId: string,
  context: Pick<InvocationContext, "workspaceId" | "runId" | "chatTaskId">,
  opener: SessionOpener | undefined,
): void {
  if (opener === undefined) return;
  const other = opener.workspaceId !== context.workspaceId ? "workspace" : opener.chatId !== chatOf(context) ? "chat" : undefined;
  if (other !== undefined)
    throw new TaviError("NOT_AUTHORIZED", `that browser session belongs to another ${other}`, { details: { sessionId } });
}

/**
 * A browser tool's input, checked against its schema, for a session the calling chat may drive (`requireSessionOf`).
 * `openerOf` names who opened a session, when this process knows.
 */
export function sessionToolInput<Input extends { readonly sessionId: string }>(
  toolId: string,
  schema: z.ZodType<Input>,
  input: unknown,
  context: Pick<InvocationContext, "workspaceId" | "runId" | "chatTaskId">,
  openerOf: ((sessionId: string) => SessionOpener | undefined) | undefined,
): Input {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new TaviError("INVALID_INPUT", `${toolId} received invalid arguments`, {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  requireSessionOf(parsed.data.sessionId, context, openerOf?.(parsed.data.sessionId));
  return parsed.data;
}
