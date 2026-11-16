import type { Browser } from "../../packages/builtin/browser/node_modules/playwright/index.js";

/** The browser plugin's Playwright types, for the TypeScript that drives these scripts' browser. */
export type { Browser, BrowserContext, Locator, Page } from "../../packages/builtin/browser/node_modules/playwright/index.js";

export const root: string;
export function launchBrowser(): Promise<Browser>;
export function missed(what: string): void;
