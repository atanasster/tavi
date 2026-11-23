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
 * The commands' words in the languages Tavi speaks besides English, by Discord's own locale code,
 * which each person's Discord client shows by its own language. Slash command and option names
 * stay as they are (`/tavi ask`): only the message menu's name is localized, and Discord still
 * delivers it by its English name.
 */
const COMMAND_WORDS_BG = {
  menu: "Попитай Tavi за това",
  tavi: "Попитай Tavi или започни нов чат с него",
  ask: "Попитай Tavi нещо",
  question: "Какво да попиташ",
  new: "Започни нов чат с Tavi",
} as const;

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
    description_localizations: { bg: COMMAND_WORDS_BG.tavi },
    contexts: [0, 1],
    integration_types: [0],
    options: [
      {
        type: 1,
        name: "ask",
        description: "Ask Tavi something",
        description_localizations: { bg: COMMAND_WORDS_BG.ask },
        options: [
          {
            type: 3,
            name: "question",
            description: "What to ask",
            description_localizations: { bg: COMMAND_WORDS_BG.question },
            required: true,
            max_length: 2000,
          },
        ],
      },
      { type: 1, name: "new", description: "Start a new chat with Tavi", description_localizations: { bg: COMMAND_WORDS_BG.new } },
    ],
  },
  { name: ASK_ABOUT_THIS, name_localizations: { bg: COMMAND_WORDS_BG.menu }, type: 3, contexts: [0, 1], integration_types: [0] },
] as const;

/** The commands as Tavi registers them: what a test checks against Discord's limits. */
export const discordCommands: readonly unknown[] = DISCORD_COMMANDS;

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

/** The words of a command's private answer, in one language. */
interface AnswerWords {
  readonly failed: string;
  readonly unknown: string;
  readonly taken: string;
  readonly dropped: Readonly<Record<RoomDropReason, string>>;
}

const ANSWERS_EN: AnswerWords = {
  failed: "Tavi could not take that just now: try again.",
  unknown: "Tavi doesn't know you yet: ask its owner to allow you.",
  taken: "Got it: Tavi answers in this chat.",
  dropped: {
    "unlisted-room": "Tavi doesn't listen in this channel.",
    "room-disabled": "Tavi is paused in this channel.",
    "not-addressed": "This channel doesn't take Tavi's commands.",
    unbound: "Tavi answers only people its owner allowed here.",
    "not-operator": "Tavi answers only its owner here.",
    flood: "Too many messages here right now: try again in a minute.",
    bot: "Tavi doesn't take commands from bots.",
    system: "Tavi doesn't take that here.",
    membership: "Tavi doesn't take that here.",
  },
};

const ANSWERS_BG: AnswerWords = {
  failed: "Tavi не успя да приеме това. Опитай пак.",
  unknown: "Tavi още не те познава. Помоли собственика на Tavi да ти даде достъп.",
  taken: "Прието. Tavi ще отговори в този чат.",
  dropped: {
    "unlisted-room": "Tavi не слуша в този канал.",
    "room-disabled": "Tavi е на пауза в този канал.",
    "not-addressed": "Този канал не приема командите на Tavi.",
    unbound: "Тук Tavi отговаря само на хора с достъп от собственика си.",
    "not-operator": "Тук Tavi отговаря само на собственика си.",
    flood: "Твърде много съобщения тук. Опитай пак след минута.",
    bot: "Tavi не приема команди от ботове.",
    system: "Tavi не приема това тук.",
    membership: "Tavi не приема това тук.",
  },
};

/** The answers in the workspace's language (`bg`, `bg-BG`); English for any other or none. */
function answersIn(locale: string | undefined): AnswerWords {
  return locale?.toLowerCase().split(/[-_]/)[0] === "bg" ? ANSWERS_BG : ANSWERS_EN;
}

/** What the asker is told, privately, of a command the host took or did not, in the workspace's language. */
export function commandAnswer(receipt: MessagingIngestReceipt | void, locale?: string): string {
  const words = answersIn(locale);
  if (receipt === undefined) return words.failed;
  if (receipt.dropped !== undefined) return words.dropped[receipt.dropped];
  if (receipt.resolvedPrincipalId === undefined) return words.unknown;
  return words.taken;
}

interface CommandShape {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly description?: unknown;
  readonly name_localizations?: unknown;
  readonly description_localizations?: unknown;
  readonly required?: unknown;
  readonly max_length?: unknown;
  readonly contexts?: unknown;
  readonly integration_types?: unknown;
  readonly options?: unknown;
}

/** A localization map as sorted pairs; none, `null` (Discord's answer for none) and `{}` are alike. */
function localizationsOf(value: unknown): readonly (readonly [string, unknown])[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What of a command registering again would change, as Tavi sends it: Discord's own answer carries more (ids, versions, defaults). */
export function shapeOf(command: unknown): unknown {
  const value = (command ?? {}) as CommandShape;
  return [
    value.name,
    value.type ?? 1,
    value.description ?? "",
    localizationsOf(value.name_localizations),
    localizationsOf(value.description_localizations),
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
  // Without `with_localizations` Discord leaves the localization maps out of its answer, and every start would re-register.
  const current = await rest.request<unknown>("GET", `${path}?with_localizations=true`, { signal });
  const shapes = (commands: readonly unknown[]): string =>
    JSON.stringify(commands.map((command) => JSON.stringify(shapeOf(command))).sort());
  if (current.ok && Array.isArray(current.body) && shapes(current.body) === shapes(DISCORD_COMMANDS)) return true;
  // A connection stopped meanwhile registers nothing.
  if (signal.aborted) return false;
  const put = await rest.request("PUT", path, { body: DISCORD_COMMANDS, signal });
  return put.ok;
}
