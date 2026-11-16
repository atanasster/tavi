import type { ChannelHostServices, MessagingConnectorDefinition, TaviError } from "@tavi/contracts";
import type { z } from "zod";

/** One update the fake platform holds, numbered as the connector long-polls them. */
export interface GroupLikeUpdate {
  readonly seq: number;
  readonly type: "message" | "press" | "member";
  /** A message update's message; absent for history (`past`). */
  readonly message?: { readonly id: string };
}

/** What the bot put on the platform. */
export interface GroupLikeSent {
  readonly id?: string;
  readonly conversation: string;
  readonly visibleInRoom: boolean;
  readonly text: string;
  readonly buttons?: readonly (readonly { readonly label: string; readonly data: string }[])[];
  readonly replyTo?: string;
  readonly linkPreview: boolean;
  readonly massMention: boolean;
}

export interface GroupLikeSay {
  readonly author: string;
  /** Absent: a one-to-one message to the bot, in the chat `dm:<author>`. */
  readonly room?: string;
  readonly text?: string;
  readonly id?: string;
  readonly mention?: boolean;
  readonly bot?: boolean;
  readonly system?: boolean;
  readonly replyTo?: { readonly id: string; readonly author: string; readonly text?: string };
  readonly command?: string;
  readonly picked?: { readonly id: string; readonly author: string; readonly text?: string };
  readonly thread?: { readonly id: string; readonly startedByBot?: boolean };
  /** History from before the bot listened: recorded in the room, never an update. */
  readonly past?: boolean;
}

export interface GroupLikePlatform {
  readonly fetch: typeof globalThis.fetch;
  readonly token: string;
  readonly botId: string;
  say(input: GroupLikeSay): GroupLikeUpdate;
  press(input: { readonly presser: string; readonly data: string; readonly messageId?: string; readonly room?: string }): GroupLikeUpdate;
  member(input: { readonly room: string; readonly by: string; readonly change: "added" | "removed"; readonly name?: string }): GroupLikeUpdate;
  /** Resolves once the connector has taken every update so far. */
  settled(): Promise<void>;
  vote(pollId: string, voter: string, answer: number): void;
  sent(): readonly GroupLikeSent[];
  polls(): ReadonlyMap<string, { readonly channel: string; readonly question: string; readonly ended: boolean }>;
  events(): readonly { readonly id: string; readonly url: string; readonly title: string; readonly start: string; readonly end: string; readonly location: string }[];
  left(): readonly string[];
  readonly rooms: ReadonlyMap<string, { readonly id: string; readonly name: string; readonly place?: string }>;
}

/** The fake platform: `fetch` is what the connector calls; the rest is the test's side. */
export function createGroupLikePlatform(options?: { readonly token?: string; readonly closed?: readonly string[]; readonly rooms?: readonly { readonly id: string; readonly name: string; readonly place?: string }[] }): GroupLikePlatform;
/** The fixture's connector, over `fetch` (the fake platform). */
export function createGroupLikeDefinition(options: { readonly z: typeof z; readonly TaviError: typeof TaviError; readonly fetch?: typeof globalThis.fetch; readonly now?: () => string }): MessagingConnectorDefinition;
export function register(context: { readonly registerChannel: (definition: MessagingConnectorDefinition) => void; readonly z: typeof z; readonly TaviError: typeof TaviError; readonly channelHost?: ChannelHostServices<typeof globalThis.fetch> }): void;
