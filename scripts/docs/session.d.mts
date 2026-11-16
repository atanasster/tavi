import type { Cell } from "./terminal-svg.mjs";
import type { Browser, BrowserContext, Page } from "../../packages/builtin/browser/node_modules/playwright/index.js";

export const cli: string;
export const MODEL: {
  readonly connection: string;
  readonly baseUrl: string;
  readonly main: string;
  readonly fast: string;
  readonly sight: string;
};
export function withDataDir(rest: readonly string[], dataDir: string): string[];
export function defaultKeyFile(): string;
export function keyFileProblem(keyFile: string): string | undefined;
export function cleanUp(): Promise<void>;
export function cleanUpOnSignals(): void;
export function settled(page: Page, name: string, miss?: (what: string) => void): Promise<void>;

export interface TerminalSpec {
  readonly args: readonly string[];
  readonly tty?: boolean;
  readonly record?: readonly string[];
  readonly input?: readonly { readonly text?: string; readonly wait?: number; readonly until?: string }[];
  readonly cols?: number;
  readonly lines?: number;
}
export function terminalLines(
  dataDir: string,
  spec: TerminalSpec,
  name?: string,
  redact?: (transcript: string) => string,
  miss?: (what: string) => void,
): Promise<Cell[][]>;

export interface Session {
  readonly dataDir: string;
  tavi(...rest: string[]): string;
  openUi(browser: Browser, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page; link: string }>;
}
export function openSession(options: {
  configured: boolean;
  withModel?: boolean;
  keyFile?: string;
  /** A `KEY=value` file with TAVILY_API_KEY, BRAVE_API_KEY and SERPER_API_KEY (any of them). */
  searchKeys?: string | undefined;
  seed?: readonly (readonly string[])[];
  /** Flags added to the owner's `tavi serve` (`--browser-allow-host 127.0.0.1:<port>`, `--fs-root <dir>`). */
  serve?: readonly string[];
  /** The main model in place of `MODEL.main`. */
  main?: string;
}): Promise<Session>;
