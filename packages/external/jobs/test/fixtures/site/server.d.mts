/** The local job board's handle (server.mjs). */
export function startJobsSite(): Promise<{ readonly origin: string; readonly port: number; readonly asked: string[]; readonly posted: string[]; close(): Promise<void> }>;
