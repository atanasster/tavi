import { PLUGIN_UI_PATH_PREFIX } from "@tavi/contracts";
import { useState } from "react";

import { monogram } from "./model.js";

/**
 * An app's icon: the one its author's `apps` block names, from the bridge's
 * `/plugin-ui/` route, else two
 * letters. Nothing else is ever loaded, and an icon that fails shows the letters.
 */
export function AppIcon({ name, icon }: { readonly name: string; readonly icon?: string | undefined }) {
  // The icon that failed to load, so a new one (another version's) is tried again.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const served = icon !== undefined && icon.startsWith(PLUGIN_UI_PATH_PREFIX) && failed !== icon;
  return (
    <span className="apps-icon" aria-hidden="true">
      {served ? <img src={icon} alt="" width={20} height={20} onError={() => setFailed(icon)} /> : monogram(name)}
    </span>
  );
}
