import { useEffect } from "react";

import type { Translate } from "@tavi/contracts/i18n";

import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";

/**
 * What the tab is called: the count of what is waiting first, so an unfocused
 * tab says so, then the view in front of the reader and, on a chat, its
 * title — "(2) Settings – Models – tavi", "Chat – Trip plan – tavi".
 */
function tabTitle(t: Translate<UiKey>, needs: number, truncated: boolean, where: readonly (string | undefined)[] = []): string {
  const named = where.filter((part): part is string => part !== undefined && part.trim() !== "");
  const place = [...named, "tavi"].join(" – ");
  if (needs === 0) return place;
  return t(truncated ? "shell.tabTitle.waitingMore" : "shell.tabTitle.waiting", { count: needs, where: place });
}

export function useTabTitle(needs: number, truncated: boolean, where: readonly (string | undefined)[] = []): void {
  const t = useT();
  const title = tabTitle(t, needs, truncated, where);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = title;
  }, [title]);
}
