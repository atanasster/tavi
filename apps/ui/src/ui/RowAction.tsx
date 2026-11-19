import type { ComponentProps } from "react";

import { Button } from "./Button.js";

/**
 * What a row's action is, and so how it is drawn — the same on every list:
 * `plain` (the default) an ordinary action, as small words with no box, so a
 * long list reads before its buttons; `danger` one that removes, revokes or
 * ends something, the only one outlined, in red; `awaited` the one action a row
 * is waiting on (a version to approve, a default not yet set), filled.
 */
export type RowActionTone = "plain" | "danger" | "awaited";

const VARIANT: Readonly<Record<RowActionTone, "ghost" | "danger" | "primary">> = {
  plain: "ghost",
  danger: "danger",
  awaited: "primary",
};

/** A list row's button: small, and drawn by its `tone` alone, never by a variant chosen page by page. */
export function RowAction({
  tone = "plain",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { readonly tone?: RowActionTone }) {
  return <Button size="sm" variant={VARIANT[tone]} {...props} />;
}

/** A row's action that goes somewhere (an `AppLink`), drawn as a plain `RowAction` is. */
export const ROW_LINK_CLASS = "button-sm ghost";
