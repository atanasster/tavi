/** The custom properties a stylesheet declares in its first `:root` block (light) and its dark-scheme one, comments aside. */
export function schemes(stylesheet: string): { readonly light: ReadonlyMap<string, string>; readonly dark: ReadonlyMap<string, string> };

/** `plugin-base.css` for these tokens, from the canvas's `tokens.css` text (light `:root`, then the dark-scheme one). */
export function pluginBase(tokensCss: string, tokens: readonly string[]): string;

/** The canvas's `tokens.css` and the two `plugin-base.css` copies the script writes, as absolute paths. */
export const PLUGIN_BASE_PATHS: { readonly tokens: string; readonly copies: readonly string[] };
