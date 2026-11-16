import type { InboundEvent, MessagingIngestReceipt, RoomDropReason } from "@tavi/contracts";
import type { z as Zod } from "zod";

import type { DiscordRest } from "./rest.js";

/**
 * Discord's commands:
 * `/tavi ask <question>`, `/tavi new`, and the message menu's "Ask Tavi about
 * this". Each is a message to the host, addressed as a command or as a picked
 * message, whose sender goes through the same binding check and room policy as
 * any message's. The connector acknowledges each at once, privately,
 * and says privately whether it was taken: the agent's answer is the chat's.
 */

const ASK_ABOUT_THIS = "Ask Tavi about this";

/**
 * The commands, global: in every server the bot is in and in its DMs. A
 * server's own commands would need the rooms the host lists, which a
 * connector does not know; the room policy decides where one is heard.
 */
const DISCORD_COMMANDS = [
  {
    name: "tavi",
    type: 1,
    description: "Ask Tavi, or start a new chat with it",
    contexts: [0, 1],
    integration_types: [0],
    options: [
      {
        type: 1,
        name: "ask",
        description: "Ask Tavi something",
        options: [{ type: 3, name: "question", description: "What to ask", required: true, max_length: 2000 }],
      },
      { type: 1, name: "new", description: "Start a new chat with Tavi" },
    ],
  },
  { name: ASK_ABOUT_THIS, type: 3, contexts: [0, 1], integration_types: [0] },
] as const;

export interface DiscordCommandInteraction {
  readonly id: string;
  readonly type: 2;
  readonly token: string;
  readonly channel_id: string;
  readonly guild_id?: string | undefined;
  readonly member?: { readonly user: { readonly id: string } } | undefined;
  readonly user?: { readonly id: string } | undefined;
  readonly data: {
    readonly name: string;
    readonly type: number;
    readonly target_id?: string | undefined;
    readonly options?:
      | readonly {
          readonly name: string;
          readonly type: number;
          readonly value?: unknown;
          readonly options?: readonly { readonly name: string; readonly type: number; readonly value?: unknown }[] | undefined;
        }[]
      | undefined;
    readonly resolved?:
      | {
          readonly messages?:
            | Readonly<Record<string, { readonly id: string; readonly author: { readonly id: string }; readonly content: string }>>
            | undefined;
        }
      | undefined;
  };
}

/** The command slice, from the host's `z`. */
export function commandSchema(z: typeof Zod): Zod.ZodType<DiscordCommandInteraction> {
  const Snowflake = z.string().regex(/^[1-9]\d{16,19}$/);
  const User = z.object({ id: Snowflake }).passthrough();
  const option = z.object({ name: z.string().max(32), type: z.number().int(), value: z.unknown().optional() }).passthrough();
  return z
    .object({
      id: Snowflake,
      type: z.literal(2),
      token: z.string().min(1).max(500),
      channel_id: Snowflake,
      guild_id: Snowflake.optional(),
      member: z.object({ user: User }).passthrough().optional(),
      user: User.optional(),
      data: z
        .object({
          name: z.enum(["tavi", ASK_ABOUT_THIS]),
          type: z.union([z.literal(1), z.literal(3)]),
          target_id: Snowflake.optional(),
          options: z
            .array(option.extend({ options: z.array(option).max(25).optional() }))
            .max(25)
            .optional(),
          resolved: z
            .object({
              messages: z
                .record(Snowflake, z.object({ id: Snowflake, author: User, content: z.string().max(4000) }).passthrough())
                .optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    })
    .passthrough()
    .refine((interaction) => (interaction.member?.user ?? interaction.user) !== undefined, "a command names its user");
}

/** What a command is to the host: a message's words and how it addressed the agent, or nothing for one Tavi does not have. */
export function commandMessage(
  interaction: DiscordCommandInteraction,
): Pick<InboundEvent, "content" | "addressed" | "referenced"> | undefined {
  const { data } = interaction;
  if (data.name === ASK_ABOUT_THIS && data.type === 3) {
    const target = data.target_id === undefined ? undefined : data.resolved?.messages?.[data.target_id];
    if (target === undefined) return undefined;
    // The menu delivers the target's text: the author's words, which the host labels as theirs.
    return {
      addressed: ["picked"],
      referenced: {
        externalSenderId: target.author.id,
        externalMessageId: target.id,
        ...(target.content === "" ? {} : { content: target.content }),
        via: "picked",
      },
    };
  }
  if (data.name !== "tavi" || data.type !== 1) return undefined;
  const sub = data.options?.find((option) => option.type === 1);
  if (sub?.name === "new") return { addressed: ["command"], content: "/new" };
  if (sub?.name !== "ask") return undefined;
  const question = sub.options?.find((option) => option.name === "question")?.value;
  if (typeof question !== "string" || question.trim() === "") return undefined;
  return { addressed: ["command"], content: question.trim().slice(0, 2000) };
}

/** What the asker is told, privately, of a command the host took or did not. */
export function commandAnswer(receipt: MessagingIngestReceipt | void): string {
  if (receipt === undefined) return "Tavi could not take that just now: try again.";
  if (receipt.dropped !== undefined) return DROPPED[receipt.dropped];
  if (receipt.resolvedPrincipalId === undefined) return "Tavi doesn't know you yet: ask its owner to allow you.";
  return "Got it: Tavi answers in this chat.";
}

const DROPPED: Readonly<Record<RoomDropReason, string>> = {
  "unlisted-room": "Tavi doesn't listen in this channel.",
  "room-disabled": "Tavi is paused in this channel.",
  "not-addressed": "This channel doesn't take Tavi's commands.",
  unbound: "Tavi answers only people its owner allowed here.",
  "not-operator": "Tavi answers only its owner here.",
  flood: "Too many messages here right now: try again in a minute.",
  bot: "Tavi doesn't take commands from bots.",
  system: "Tavi doesn't take that here.",
  membership: "Tavi doesn't take that here.",
};

interface CommandShape {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly description?: unknown;
  readonly required?: unknown;
  readonly max_length?: unknown;
  readonly contexts?: unknown;
  readonly integration_types?: unknown;
  readonly options?: unknown;
}

/** What of a command registering again would change, as Tavi sends it: Discord's own answer carries more (ids, versions, defaults). */
function shapeOf(command: unknown): unknown {
  const value = (command ?? {}) as CommandShape;
  return [
    value.name,
    value.type ?? 1,
    value.description ?? "",
    value.required === true,
    value.max_length ?? null,
    Array.isArray(value.contexts) ? [...(value.contexts as unknown[])].sort() : null,
    Array.isArray(value.integration_types) ? [...(value.integration_types as unknown[])].sort() : null,
    Array.isArray(value.options) ? (value.options as unknown[]).map(shapeOf) : [],
  ];
}

/**
 * Registers the commands, only when Discord's differ: a bulk overwrite on
 * every start would spend the application's daily command budget. Answers
 * whether they are registered.
 */
export async function registerCommands(rest: DiscordRest, applicationId: string, signal: AbortSignal): Promise<boolean> {
  const path = `/applications/${applicationId}/commands`;
  const current = await rest.request<unknown>("GET", path, { signal });
  const shapes = (commands: readonly unknown[]): string =>
    JSON.stringify(commands.map((command) => JSON.stringify(shapeOf(command))).sort());
  if (current.ok && Array.isArray(current.body) && shapes(current.body) === shapes(DISCORD_COMMANDS)) return true;
  // A connection stopped meanwhile registers nothing.
  if (signal.aborted) return false;
  const put = await rest.request("PUT", path, { body: DISCORD_COMMANDS, signal });
  return put.ok;
}
