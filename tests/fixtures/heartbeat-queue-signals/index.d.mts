import type { HeartbeatSignalSource } from "@tavi/contracts";

/** The fixture's signal source over the JSON feed at `feed`. */
export function createQueueSource(feed: string): HeartbeatSignalSource;
export function register(context: { readonly config: { readonly feed: string }; readonly provideSignals: (source: HeartbeatSignalSource) => void }): void;
