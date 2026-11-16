import type { ModHook } from "@tavi/contracts";

/** The fixture's hook, quiet on `days` ("Sat,Sun"). */
export function quietDayHook(days: string, hold?: string): ModHook<"heartbeat.item">;
export function register(context: { readonly hooks: { on(event: "heartbeat.item", hook: ModHook<"heartbeat.item">): void }; readonly config: { readonly days?: string; readonly hold?: string } }): void;
