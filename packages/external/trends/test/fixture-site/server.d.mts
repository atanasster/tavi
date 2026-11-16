/** The local trending site's handle (server.mjs). */
export function startTrendsSite(): Promise<{ readonly origin: string; readonly port: number; readonly asked: string[]; close(): Promise<void> }>;
