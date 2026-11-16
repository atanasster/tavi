import type { HeartbeatProvider } from "@tavi/contracts";

/** The fixture's rule-based provider: no model. */
export function createRuleProvider(): HeartbeatProvider;
export function register(context: { readonly provideHeartbeat: (provider: HeartbeatProvider) => void }): void;
