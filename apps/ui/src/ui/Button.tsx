import type { ComponentProps } from "react";

/**
 * How a button looks, by what it does: `default` is the outlined base
 * button; `primary` the page's main action; `secondary` a filled quiet one;
 * `ghost` an action that stays out of the way until hovered; `destructive` a
 * main action that removes or ends something, `danger` a lesser one
 * (outlined in red) and `danger-ghost` the quietest (red text); `link` a
 * button that reads as a link; `bare` one stripped of the button look, for a
 * row, chip or switch its own class draws. Each is a class in `styles/controls.css`.
 */
type ButtonVariant = "default" | "primary" | "secondary" | "ghost" | "destructive" | "danger" | "danger-ghost" | "link" | "bare";

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  default: "",
  primary: "button-primary",
  secondary: "button-secondary",
  ghost: "ghost",
  destructive: "button-danger",
  danger: "danger",
  "danger-ghost": "button-danger-ghost",
  link: "button-link",
  bare: "button-bare",
};

/** `sm` is the compact button rows and cards use; `icon` the square one a glyph alone fills. */
type ButtonSize = "sm" | "icon";

const SIZE_CLASS: Readonly<Record<ButtonSize, string>> = { sm: "button-sm", icon: "button-icon" };

/** A button's classes: its size's, its variant's, then the caller's own. */
function buttonClass(variant: ButtonVariant = "default", size?: ButtonSize | readonly ButtonSize[], className?: string): string {
  const sizes = size === undefined ? [] : typeof size === "string" ? [size] : size;
  return [...sizes.map((each) => SIZE_CLASS[each]), VARIANT_CLASS[variant], className ?? ""].filter((part) => part !== "").join(" ");
}

type Props = Omit<ComponentProps<"button">, "type"> & {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | readonly ButtonSize[] | undefined;
  /** `button` unless it submits (or resets) its form. */
  readonly type?: "button" | "submit" | "reset" | undefined;
};

/** The canvas's button: one place that turns a variant and a size into the classes the stylesheet draws. */
export function Button({ variant, size, className, type = "button", ...props }: Props) {
  const classes = buttonClass(variant, size, className);
  return <button type={type} className={classes === "" ? undefined : classes} {...props} />;
}
