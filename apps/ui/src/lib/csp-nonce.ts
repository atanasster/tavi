/**
 * The page's style nonce (`<meta name="csp-nonce">`, a fresh one each time the
 * owner serves the page), handed to what injects a `<style>` at run time: a
 * Radix select's scroll lock (react-remove-scroll, through react-style-singleton)
 * reads it from `get-nonce`, which falls back to the global `__webpack_nonce__`,
 * and a Radix select's viewport, which draws its own `<style>`, takes it from
 * `styleNonce()`. The canvas's policy allows that nonce and no other inline style.
 */
export function adoptStyleNonce(page: Pick<Document, "querySelector"> = document, scope: object = globalThis): string | undefined {
  const nonce = page.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? undefined;
  if (nonce !== undefined && nonce !== "") Reflect.set(scope, "__webpack_nonce__", nonce);
  return nonce === "" ? undefined : nonce;
}

/** The style nonce `adoptStyleNonce` adopted, for a component that draws its own `<style>`; undefined when there is none. */
export function styleNonce(scope: object = globalThis): string | undefined {
  const nonce: unknown = Reflect.get(scope, "__webpack_nonce__");
  return typeof nonce === "string" && nonce !== "" ? nonce : undefined;
}
