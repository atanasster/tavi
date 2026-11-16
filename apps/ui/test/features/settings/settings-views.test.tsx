import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SettingsView } from "../../../src/App.js";
import { Settings } from "../../../src/features/settings/SettingsPage.js";
import { SettingsNav } from "../../../src/features/settings/SettingsNav.js";
import { CredentialsSettings } from "../../../src/features/settings/CredentialsSettings.js";
import { ModelBrowser } from "../../../src/features/settings/ModelBrowser.js";
import { PasswordInput } from "../../../src/features/settings/PasswordInput.js";
import { SystemPromptSettings } from "../../../src/features/settings/SystemPromptSettings.js";
import { WebSearchFormModal } from "../../../src/features/settings/WebSearchFormModal.js";
import { WebSearchSettings } from "../../../src/features/settings/WebSearchSettings.js";
import { WorkspaceProvider } from "../../../src/features/shell/Workspace.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * Every `SettingsView`, with the heading its page renders before its data loads.
 *
 * `Record<SettingsView, string>` is the gate: the union gains a member and this
 * does not compile, so a view cannot be added to the type — and reachable through
 * the settings route — while rendering nothing and appearing in no tab.
 */
const SETTINGS_VIEW_HEADING: Readonly<Record<SettingsView, string>> = {
  general: "General",
  apps: "Connected apps",
  models: "Models",
  search: "Web search",
  "system-prompt": "System prompt",
  credentials: "Credentials",
  messaging: "Channels",
  people: "Allowed people",
  plugins: "Plugins",
  permissions: "Permissions",
  ideas: "Ideas",
};

/** The ported views, as first rendered (before their data loads). */

const client = { request: () => new Promise<never>(() => undefined) };
const noop = () => undefined;

describe("the settings views", () => {
  it("renders the web search form with tavi's four kinds, a masked key and no instance field for a hosted kind", () => {
    const html = renderToStaticMarkup(<WebSearchFormModal taken={["tavily"]} onSave={() => Promise.resolve(undefined)} onClose={noop} />);
    for (const label of ["Tavily", "Brave Search", "Serper", "SearXNG"]) expect(html).toContain(label);
    expect(html).toContain("<dialog");
    // The next free name, since `tavily` is taken.
    expect(html).toContain('value="tavily-2"');
    expect(html).toContain('class="secret"');
    expect(html).toContain("optional: Tavily also runs keyless");
    expect(html).not.toContain("Instance address");
  });

  it("masks a credential's value, and never prefills it", () => {
    const html = renderToStaticMarkup(<PasswordInput id="v" value="" placeholder="Paste the secret" invalid={false} onChange={noop} />);
    // Masked by CSS, not a password field, so password managers offer no saved logins.
    expect(html).not.toContain('type="password"');
    expect(html).toContain('class="secret"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('value=""');
  });

  it("renders each settings page's heading while its data loads", () => {
    expect(
      renderToStaticMarkup(
        <InWorkspace client={client} workspaceId="default">
          <ModelBrowser />
        </InWorkspace>,
      ),
    ).toContain("<h1>Models</h1>");
    expect(
      renderToStaticMarkup(
        <InWorkspace client={client}>
          <WebSearchSettings />
        </InWorkspace>,
      ),
    ).toContain("<h1>Web search</h1>");
    const credentials = renderToStaticMarkup(
      <InWorkspace client={client}>
        <CredentialsSettings />
      </InWorkspace>,
    );
    expect(credentials).toContain("<h1>Credentials</h1>");
    expect(credentials).toContain("never shown here");
    // The system prompt editor (step 4): its heading and activation copy render
    // before the load answers, so a slow owner is not a blank page. (The
    // labelled textarea appears once the answer arrives; the DOM suite covers
    // that.)
    const systemPrompt = renderToStaticMarkup(
      <InWorkspace client={client} workspaceId="default">
        <SystemPromptSettings />
      </InWorkspace>,
    );
    expect(systemPrompt).toContain("<h1>System prompt</h1>");
    expect(systemPrompt).toContain("each existing chat&#x27;s next message, run under it");
    expect(systemPrompt).toContain("Loading system prompt…");
  });

  it("renders every `SettingsView`, and offers exactly one tab per view", () => {
    const views = Object.keys(SETTINGS_VIEW_HEADING) as SettingsView[];
    for (const view of views) {
      // Ideas is offered only by an owner that advertises it; this owner does.
      const html = renderToStaticMarkup(
        <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
          <Settings view={view} ideas />
        </WorkspaceProvider>,
      );
      // Each page's own heading, not just the shared tab strip: a view wired
      // into the union but not into the render block would otherwise pass.
      expect(html, `${view} renders no page of its own`).toContain(`<h1>${SETTINGS_VIEW_HEADING[view]}</h1>`);
    }
    // Settings' nav is the only route to a settings view, so it must name each
    // one exactly once — a view with no entry is unreachable, and an entry whose
    // label the page does not bear is a dead end.
    const nav = renderToStaticMarkup(
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <SettingsNav view="models" onView={noop} ideas />
      </WorkspaceProvider>,
    );
    expect(nav.match(/center-nav-item"/g)).toHaveLength(views.length);
    for (const view of views) expect(nav, `${view} has no tab`).toContain(SETTINGS_VIEW_HEADING[view]);
  });

  it("offers Settings → Ideas only where the owner does", () => {
    const shell = renderToStaticMarkup(
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <Settings view="ideas" />
        <SettingsNav view="ideas" onView={noop} />
      </WorkspaceProvider>,
    );
    expect(shell).not.toContain(">Ideas<");
    expect(shell).toContain("This owner does not offer Ideas.");
  });
});
