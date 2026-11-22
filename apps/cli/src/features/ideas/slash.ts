import {
  ideaCategoryLabel,
  IDEA_FOR_YOU_MAX,
  type IdeaCapability,
  type ModCommandDeclaration,
  type ModCommandInput,
  type ModCommandResult,
  type ModHook,
  type MessagingServicePort,
  type ModHookDeclaration,
  type PersistencePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { digestPicked, ideaOfDigestReply } from "@tavi/agent-host/ideas-host";

import { ideasCommand, type IdeasCommandDependencies } from "./owner.js";

/**
 * `/ideas`: the operator's top ideas in any front
 * end or channel, as a short list with each one's starter prompt, and
 * `refresh` to ask the provider for new ones. It only reads and asks: steering
 * (not now, mute, pin…) is the Ideas tab's and `tavi ideas`'.
 */

export const IDEAS_COMMANDS: readonly ModCommandDeclaration[] = [
  { name: "ideas", description: "Things I can do for you: your top ideas, or refresh to look for new ones." },
];

const USAGE = "Usage: /ideas [refresh]. Steer them in the Ideas tab or with tavi ideas.";

/** Where a channel command was typed: a direct chat, a group, an email thread, or a place the owner could not tell. */
export type IdeasCommandPlace = "direct" | "group" | "email" | undefined;

export function ideasSlashCommand(
  deps: IdeasCommandDependencies & {
    /** Where the command was typed (the memory commands' rule): ideas are written from the person's own memory and chats. */
    readonly placeOf?: (envelope: ModCommandInput["envelope"]) => IdeasCommandPlace;
  },
): (input: ModCommandInput) => Promise<ModCommandResult> {
  return async ({ envelope, args }) => {
    if (deps.principalOf(envelope.workspaceId) !== envelope.principalId) return { text: "/ideas is the workspace operator's." };
    // Never where others read: a group, an email thread, or a channel place the owner could not tell.
    if (envelope.source === "messaging" && deps.placeOf?.(envelope) !== "direct")
      return { text: "/ideas answers only in your own direct chat with Tavi, never where others read." };
    const words = args
      .trim()
      .split(/\s+/u)
      .filter((part) => part !== "");
    const workspaceId = envelope.workspaceId;
    if (words.length === 1 && words[0] === "refresh") {
      const answer = await ideasCommand(deps, { action: "refresh", workspaceId });
      if (!answer.ok) return { text: answer.error.message };
      const status = "status" in answer.result ? answer.result.status : undefined;
      return {
        text:
          status === "busy"
            ? "Ideas are being looked for elsewhere; try /ideas in a minute."
            : status === "queued"
              ? "A look is under way; another follows it."
              : "Looking for new ideas; /ideas shows them in a moment.",
      };
    }
    if (words.length > 0) return { text: USAGE };
    const answer = await ideasCommand(deps, { action: "list", workspaceId });
    if (!answer.ok) return { text: answer.error.message };
    if (!("ideas" in answer.result)) return { text: USAGE };
    // Off, the tab shows no cards: neither does this, whatever is still stored.
    if (answer.result.enabled === false) return { text: "Ideas are off. Turn them on in Settings → Ideas, or with tavi ideas on." };
    const top = answer.result.ideas.filter((idea) => idea.status === "active").slice(0, IDEA_FOR_YOU_MAX);
    if (top.length === 0) return { text: "No ideas yet. /ideas refresh looks for some." };
    const lines = top.map((idea, index) => `${index + 1}. ${idea.title} (${ideaCategoryLabel(idea.category)})\n   Try: ${idea.prompt}`);
    return { text: ["Ideas for you:", ...lines, "More in the Ideas tab."].join("\n") };
  };
}

/** The ideas host's one hook: it reads channel messages for a reply to the weekly digest. */
export const IDEAS_HOOKS: readonly ModHookDeclaration[] = [
  {
    event: "prompt.submit",
    match: { sources: ["messaging"] },
    disclosure: "Reads your channel messages for a reply of 1, 2 or 3 to your weekly ideas digest, and adds the idea you picked.",
  },
];

/**
 * A reply of 1–3 to the weekly digest on its channel: the idea
 * it picks is added to the message as context — untrusted, as a provider's
 * words are — and counted as tried, so the chat the reply starts goes the
 * way of *Try it*. Anything else, and anyone but the operator, passes by.
 */
export function ideasDigestReplyHook(deps: {
  readonly repositories: Pick<PersistencePort["repositories"], "ideas">;
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** The channel chat a task is (`messagingConversations.getByTask`): a pick counts only in the chat the digest went to. */
  readonly chatOf: (taskId: string) => Promise<{ readonly connectionId: string; readonly chatId: string } | undefined>;
  /** What Tavi can do here now: a pick whose capability went is no longer offered, as on the tab. */
  readonly census: (workspaceId: string) => Promise<readonly IdeaCapability[]>;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}): ModHook<"prompt.submit"> {
  return async (input, next) => {
    const { envelope } = input;
    if (input.steer || deps.principalOf(envelope.workspaceId) !== envelope.principalId) return await next(input);
    const chat = await deps.chatOf(envelope.taskId);
    const idea = await ideaOfDigestReply(deps, {
      workspaceId: envelope.workspaceId,
      connectionId: chat?.connectionId,
      chatId: chat?.chatId,
      text: input.prompt,
    });
    if (idea === undefined) return await next(input);
    // One pick a digest, and it counts as *Try it*. Neither note failing changes what the person sent.
    try {
      await digestPicked(deps, envelope.workspaceId);
      if (idea.status === "active")
        await deps.repositories.ideas.feedback({
          id: `ifb-${deps.newId()}`,
          workspaceId: envelope.workspaceId,
          ideaId: idea.id,
          signal: "tried",
          now: deps.now().toISOString(),
        });
    } catch (error) {
      deps.log("a digest pick could not be noted", { workspaceId: envelope.workspaceId, ideaId: idea.id, reason: errorMessage(error) });
    }
    const below = await next(input);
    if ("drop" in below) return below;
    return {
      context: [...(below.context ?? []), `They picked this from their weekly ideas digest: "${idea.title}". What it asks: ${idea.prompt}`],
    };
  };
}

/**
 * The weekly digest's send: to the operator's own authorized
 * delivery target on the connection — the first such chat — and nowhere else.
 */
export function ideasDigestSender(deps: {
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly operatorTargets: (
    workspaceId: string,
    principalId: string,
  ) => Promise<readonly { readonly connectionId: string; readonly chatId: string }[]>;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildDestination">;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}): (input: {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly text: string;
  readonly effectId: string;
}) => Promise<{ readonly status: "sent"; readonly chatId: string } | { readonly status: "skipped" }> {
  return async ({ workspaceId, connectionId, text, effectId }) => {
    const principalId = deps.principalOf(workspaceId);
    const target =
      principalId === undefined
        ? undefined
        : (await deps.operatorTargets(workspaceId, principalId)).find((candidate) => candidate.connectionId === connectionId);
    const destination = target === undefined ? undefined : deps.messaging.buildDestination(connectionId, { to: target.chatId });
    if (target === undefined || destination === undefined) {
      deps.log("the ideas digest was skipped: no chat of the operator's on its connection can be sent to", { workspaceId, connectionId });
      return { status: "skipped" };
    }
    const outcome = await deps.messaging.send({ effectId, connectionId, workspaceId, destination, parts: [{ content: text }] });
    return outcome.status === "rejected" ? { status: "skipped" } : { status: "sent", chatId: target.chatId };
  };
}
