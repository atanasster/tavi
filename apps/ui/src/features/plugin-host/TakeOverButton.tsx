import { Button } from "../../ui/Button.js";

/** The host's "Take control" of a browser view: the page's main action while the browser needs the owner, quiet otherwise. */
export function TakeOverButton({ attention, onTakeOver }: { readonly attention: boolean; readonly onTakeOver: () => void }) {
  return (
    <Button variant={attention ? "primary" : "ghost"} size="sm" onClick={onTakeOver}>
      Take control
    </Button>
  );
}
