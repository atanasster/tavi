/** The local places site's handle (server.mjs). */
export function startPlacesSite(): Promise<{ readonly origin: string; readonly port: number; readonly asked: string[]; readonly posted: string[]; close(): Promise<void> }>;
