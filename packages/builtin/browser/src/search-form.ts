/** A form field as `isSearchFormIn` reads it, duck-typed: this package has no DOM types. */
interface SearchFormField {
  readonly tagName?: string;
  readonly type?: unknown;
  readonly isContentEditable?: boolean;
  readonly labels?: ArrayLike<{ readonly innerText?: string }> | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  checkVisibility?(options: Readonly<Record<string, boolean>>): boolean;
}

/** A form as `isSearchFormIn` reads it. */
export interface SearchFormElement {
  getAttribute(name: string): string | null;
  querySelectorAll?(selector: string): ArrayLike<SearchFormField>;
}

/** The pattern sources `isSearchFormIn` builds its tests from, passed in because it runs in the page. */
export interface SearchFormPatterns {
  readonly searchWord: string;
  readonly searchExact: string;
  readonly disqualifyingField: string;
  readonly secret: string;
}

/**
 * The strict search-form test, run in the page: the form has `role="search"`,
 * or every visible text field in it is search-like, and no field in it is a
 * password, email, tel, file, textarea, editable region, protected or secret
 * field. A drop-down counts as search-like: a form of a query and its filters
 * (a category, a sort order) is a search. Self-contained, so its source can be
 * embedded in the page scripts that need it (`scanPage`, the press re-check);
 * `isSearchFormFacts` is the same test over facts read in the utility world.
 */
export function isSearchFormIn(form: SearchFormElement | null, patterns: SearchFormPatterns): boolean {
  if (form === null || typeof form.querySelectorAll !== "function") return false;
  const searchWord = new RegExp(patterns.searchWord, "iu");
  const searchExact = new RegExp(patterns.searchExact, "iu");
  const disqualifyingField = new RegExp(patterns.disqualifyingField, "iu");
  const secret = new RegExp(patterns.secret, "i");
  const fields = Array.from(
    form.querySelectorAll(
      "input, select, textarea, [contenteditable=true], [role=textbox], [role=searchbox], [role=combobox], [role=checkbox], [role=radio], [role=switch]",
    ),
  );
  const nonTextTypes = new Set(["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "range", "color", "file"]);
  const badTypes = new Set(["password", "email", "tel", "file"]);
  let visibleTextCount = 0;
  let allSearchLike = true;
  for (const field of fields) {
    const tag = (field.tagName ?? "").toUpperCase();
    const type = tag === "INPUT" ? String(field.type ?? "text").toLowerCase() : "";
    const role = (field.getAttribute("role") ?? "").trim().toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "image") continue;
    if (tag === "TEXTAREA" || field.isContentEditable === true || (tag === "INPUT" && badTypes.has(type))) return false;
    const parts = [
      field.getAttribute("autocomplete"),
      field.getAttribute("name"),
      field.getAttribute("id"),
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder"),
      field.getAttribute("title"),
      field.labels?.[0]?.innerText,
    ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
    const joined = parts.join(" ");
    if (secret.test(joined) || disqualifyingField.test(joined)) return false;
    const rect = field.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      (typeof field.checkVisibility === "function" ? field.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) : true);
    if (!visible) continue;
    const isTextField =
      (tag === "INPUT" && !nonTextTypes.has(type)) || role === "textbox" || role === "searchbox" || role === "combobox" || tag === "SELECT";
    if (!isTextField) continue;
    visibleTextCount += 1;
    const searchLike =
      type === "search" ||
      role === "searchbox" ||
      role === "combobox" ||
      tag === "SELECT" ||
      parts.some((part) => searchWord.test(part.trim()) || searchExact.test(part.trim()));
    if (!searchLike) allSearchLike = false;
  }
  const formRole = (form.getAttribute("role") ?? "").trim().toLowerCase();
  return formRole === "search" || (visibleTextCount > 0 && allSearchLike);
}
