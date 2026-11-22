import { useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";
import { SETTINGS_GROUPS, SETTINGS_VIEWS, type SettingsView } from "../shell/route.js";
import { SidebarFrame } from "../shell/SidebarFrame.js";
import { useWorkspace } from "../shell/Workspace.js";
import { useCurrentNavInView } from "../../ui/useCurrentNavInView.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

/**
 * Settings' own nav, in the left column the chats list holds elsewhere: the
 * views in their groups. It wears the Command Center nav's classes, so it
 * looks the same and, on a phone, becomes the same strip of tabs.
 */
export function SettingsNav({
  view,
  ideas = false,
  onView,
  onCollapse,
}: {
  readonly view: SettingsView;
  /** The owner offers Ideas: Settings → Ideas is listed. */
  readonly ideas?: boolean;
  readonly onView: (view: SettingsView) => void;
  readonly onCollapse?: (() => void) | undefined;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  useCurrentNavInView(view);
  const label = (value: SettingsView): string => SETTINGS_VIEWS.find((item) => item.value === value)?.label ?? value;
  return (
    <SidebarFrame panel="settings" className="center-nav settings-nav" onCollapse={onCollapse}>
      {SETTINGS_GROUPS.map((group) => {
        const views = group.views.filter((value) => ideas || value !== "ideas");
        return views.length === 0 ? null : (
          <section key={group.label} className="settings-nav-group">
            <h3 className="settings-nav-heading">{group.label}</h3>
            <ul className="center-nav-list list-reset">
              {views.map((value) => (
                <li key={value}>
                  <Button
                    variant="bare"
                    className="center-nav-item"
                    aria-current={value === view ? "page" : undefined}
                    onClick={() => onView(value)}
                  >
                    <span className="center-nav-label">{label(value)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="scope meta-sm center-nav-foot">{withParts(t("settings.nav.workspace"), { workspaceId: <code>{workspaceId}</code> })}</p>
    </SidebarFrame>
  );
}
