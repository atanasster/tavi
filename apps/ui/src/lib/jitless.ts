import { config } from "zod";

/**
 * Imported first by the page, before any schema parses: Zod probes whether it
 * may compile a parser with `new Function`, which the bridge's CSP
 * (`script-src 'self'`, no `'unsafe-eval'`) refuses — and the browser reports
 * the refusal as a violation on every load. Jitless, Zod never asks.
 */
config({ jitless: true });
