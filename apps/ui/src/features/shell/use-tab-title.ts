import { useEffect } from "react";

/**
 * What the tab is called: the count of what is waiting first, so an unfocused
 * tab says so, then the view in front of the reader and, on a chat, its
 * title — "(2) Settings – Models – tavi", "Chat – Trip plan – tavi".
 */
function tabTitle(needs: number, truncated: boolean, where: readonly (string | undefined)[] = []): string {
  const count = needs === 0 ? "" : `(${needs}${truncated ? "+" : ""}) `;
  const named = where.filter((part): part is string => part !== undefined && part.trim() !== "");
  return `${count}${[...named, "tavi"].join(" – ")}`;
}

export function useTabTitle(needs: number, truncated: boolean, where: readonly (string | undefined)[] = []): void {
  const title = tabTitle(needs, truncated, where);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = title;
  }, [title]);
}
