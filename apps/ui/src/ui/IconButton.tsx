import type { ButtonHTMLAttributes } from "react";
import { Button } from "./Button.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  readonly icon: IconName;
  readonly label: string;
  readonly tooltip?: string;
  readonly tooltipPlacement?: "top" | "bottom";
  readonly size?: "sm";
};

/**
 * All icon actions get the same styling, accessible name, and custom tooltip.
 * A disabled one stays a focusable, named button (`aria-disabled`) whose
 * presses do nothing, so a keyboard reader can still find it and hear why.
 */
export function IconButton({ icon, label, tooltip, tooltipPlacement, size, className = "", disabled, onClick, ...props }: Props) {
  const small = size === "sm" || /(^|\s)button-sm(\s|$)/.test(className);
  const own = className.replace(/(^|\s)button-sm(?=\s|$)/, " ").trim();
  const off = disabled === true;
  return (
    <Tooltip text={tooltip ?? label} {...(tooltipPlacement ? { placement: tooltipPlacement } : {})}>
      <Button
        {...props}
        variant="ghost"
        size={small ? ["icon", "sm"] : "icon"}
        className={own === "" ? undefined : own}
        aria-label={props["aria-label"] ?? label}
        aria-disabled={off ? true : props["aria-disabled"]}
        onClick={off ? (event) => event.preventDefault() : onClick}
      >
        <Icon name={icon} {...(size !== undefined ? { size } : {})} />
      </Button>
    </Tooltip>
  );
}
