import type { MessagingConnectorDefinition, TaviError } from "@tavi/contracts";
import type { z } from "zod";

/** The fixture's connector, over `fetch` (a fake provider in tests). */
export function createWhatsappLikeDefinition(options: { readonly z: typeof z; readonly TaviError: typeof TaviError; readonly fetch?: typeof globalThis.fetch }): MessagingConnectorDefinition;
export function register(context: { readonly registerChannel: (definition: MessagingConnectorDefinition) => void; readonly z: typeof z; readonly TaviError: typeof TaviError }): void;
