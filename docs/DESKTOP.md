# Desktop Computer Use (`@tavi/plugin-desktop`)

`@tavi/plugin-desktop` is a macOS adapter that observes and acts in granted
applications through the macOS Accessibility (`AXUIElement`) tree,
`ScreenCaptureKit` captures, and `CGEvent` input synthesis, behind fail-closed
safety gates. The `desktop.observe`, `desktop.act` and `desktop.computer_use`
tools in `apps/cli/src/features/desktop/tools.ts` drive it through Tavi's
approval cards.

## Status: experimental, off until enabled

Desktop control is the built-in plugin `tavi.desktop`: macOS only, off until
you enable it. To use it:

1. **Enable it**, then restart `tavi serve`:
   `tavi plugins enable tavi.desktop`.
2. **Build its helper**, once, on the Mac it runs on. The plugin ships the
   helper as Swift source (`native/helper.swift`); Tavi looks for the built
   helper at `<data directory>/desktop/tavi-desktop-helper`. Until it is there,
   every `desktop.*` call refuses and prints the exact `mkdir`, `swiftc -O …`
   and `codesign -s - --force …` commands for your install. Run them in the
   terminal you will run `tavi serve` from. Tavi never runs them itself.
   `swiftc` and `codesign` come with Xcode or the Xcode Command Line Tools
   (`xcode-select --install`). With the Swift 6.1 Command Line Tools alone,
   `swiftc` may stop at "redefinition of module 'SwiftBridging'"; see
   [Build the helper with the Command Line Tools](#build-the-helper-with-the-command-line-tools).
3. **Grant the Accessibility and Screen Recording permissions.** macOS asks
   for them when the helper first reads another app or captures the screen,
   and grants them to the app that started it: the terminal running
   `tavi serve`. Screenshots need macOS 14 or newer. Until Accessibility is
   granted, `desktop.observe` and `desktop.act` refuse with **desktop control
   has no Accessibility permission**, naming where to grant it, rather than
   read an empty window; restart `tavi serve` from that terminal once it is
   granted. An owner started over SSH cannot be granted it: start it from a
   terminal on the Mac.
4. **Grant the apps** a workspace may see and act in:
   `tavi config set desktop.grantedApps com.apple.TextEdit,Notes` (bundle ids
   or app names; `none` clears the list). Each app gets its built-in tier
   (below). An app not on the list is refused on its approval card and at the
   gate. `desktop.observe` of one, the app in front included, refuses and
   names the granted apps, so the model can look at one of them or ask you to
   add it.

### Build the helper with the Command Line Tools

The Swift 6.1 Command Line Tools ship the `SwiftBridging` module in two module
maps (`module.modulemap` and `bridging.modulemap` in
`/Library/Developer/CommandLineTools/usr/include/swift`), and `swiftc` stops at
"redefinition of module 'SwiftBridging'". A full Xcode does not. Without one,
a file-system overlay that hides the second map builds it. Write the overlay
once:

```bash
mkdir -p ~/swiftfix && : > ~/swiftfix/empty.modulemap
cat > ~/swiftfix/overlay.yaml <<EOF
{ "version": 0, "case-sensitive": "false", "roots": [ { "type": "directory",
  "name": "/Library/Developer/CommandLineTools/usr/include/swift",
  "contents": [ { "type": "file", "name": "bridging.modulemap",
  "external-contents": "$HOME/swiftfix/empty.modulemap" } ] } ] }
EOF
```

Then run the `swiftc` command the refusal prints with the overlay added,
`swiftc -O -vfsoverlay ~/swiftfix/overlay.yaml -Xcc -ivfsoverlay -Xcc ~/swiftfix/overlay.yaml <helper.swift> -o <helper>`,
and the `codesign` command after it as printed.

Every desktop action runs only in an attended run, after its own approval
card. Looking at an app's window (`desktop.observe`) asks too: once per call,
or once for the chat with **Allow for this chat**; with a screenshot it also
runs only in an attended run. The abort hotkey, Cmd+Shift+Escape, works once the Accessibility
permission is granted. It stops the action in flight, refuses what was queued
behind it, and stops every run that used desktop control for the rest of that
run; the next run acts again. Each run it stopped says so in its chat at once:
**Desktop control stopped for this run** (the canvas chat's header, `tavi
chat`'s transcript, and `[plugin] tavi.desktop: …` in `tavi run`'s output). Desktop sessions are not streamed to the live
view yet.

An action's card names the element it acts on by its label or its kind. It
also shows the text the action types, or the key it presses.

What an app shows is untrusted content, held as a web page's is: once a
chat has read it, the chat header's chip says **Read a desktop app's screen
(TextEdit)**, naming the app, and so do a later card's source chips and the
line under a value it found there ("appears in a desktop app's screen
(TextEdit)"). The app's name is its developer's choice, so it is shown only
when it is plain words (letters, digits, spaces, `.`, `_`, `-`); otherwise its
bundle id is, or no name at all. A memory proposed after it says so too. A
call that refused before it read anything, such as a first
`desktop.observe` while the helper is not built, leaves the chat untainted.

## Safety Model: Gates That Fail Closed

Desktop control is the widest local surface an agent can touch, so every check
fails closed (`packages/builtin/desktop/src/gates.ts`):

1. **Unresolved means denied.** If the application or accessibility element at
   the target point or current focus cannot be resolved, or no hit-test is
   available, the action is refused.
2. **Hit-tested application blocklist (`BLOCKED_DESKTOP_APPS`).** Before any
   click, drag, scroll, or key event, the application owning the target point
   (not merely the frontmost application; both ends of a drag, and the centre
   of a ref's bounds) is resolved and checked against `BLOCKED_DESKTOP_APPS`:
   password managers (`com.1password.1password`, `com.agilebits.onepassword7`,
   `com.apple.keychainaccess`, `com.apple.Passwords`, Bitwarden, LastPass,
   Dashlane, Keeper, Proton Pass, KeePassXC, Enpass) and system authentication
   agents (`com.apple.securityagent`, `com.apple.CoreAuthUI`,
   `com.apple.LocalAuthentication.UIAgent`), and Tavi's own apps (`ai.tavi.*`).
3. **Tavi's own windows.** The helper leaves out of every screenshot the
   processes that run Tavi (its parent processes, and the app named by
   `__CFBundleIdentifier`, such as your terminal), and refuses a click, a drag
   or typing whose target is one of them.
4. **Credential fields refused (`AXSecureTextField`).** Any element whose role
   or subrole is `AXSecureTextField`, `AXPasswordField`, or `AXPasswordInput`,
   whether focused or under the target point, refuses typing, clicking, and
   screen capture.
5. **Authentication dialogs refused.** System elevation prompts (`SecurityAgent`,
   Touch ID / `CoreAuthUI`, `sudo`, `polkit`, Keychain prompts) are detected by
   bundle identifier and dialog text patterns and refused.
6. **Per-application grant tiers.** An application on `desktop.grantedApps`
   gets its built-in tier:
   - **`view-only`**: web browsers (`Safari`, `Chrome`, `Firefox`, `Arc`,
     `Brave`, `Edge`). Desktop tools may observe them, but every action is
     refused, so browsing stays in Tavi's `browser.*` tools.
   - **`click-only`**: terminals and IDEs (`Terminal`, `iTerm2`, `Warp`,
     `Ghostty`, `VS Code`, `Cursor`, `Xcode`, JetBrains IDEs). A plain left
     click or a scroll is allowed; typing, key presses, right clicks, modifier
     clicks and drags are refused, so shell commands stay in `sandbox.run`.
     Typing a terminal's name into a launcher (Spotlight, Alfred, Raycast),
     which would open it, is refused unless Terminal has the full tier.
   - **`warning`**: file managers, script editors and System Settings
     (`Finder`, `System Settings`, `Script Editor`, `Automator`, `Activity
     Monitor`). An action needs its card's approval, for that app only.
   - **`full`**: any other granted application (`TextEdit`, `Calculator`,
     `Notes`, `Preview`).
7. **Captures by allowlist.** A screenshot shows the granted apps' windows and
   no other's, and leaves out blocked apps and Tavi's own. Action and capture
   are gated as one unit: a refused action takes and returns no screenshot.
8. **Commit controls gated, by what is pressed.** A press is read by the
   control it lands in: a hit-test answers the deepest element (the text
   inside a "Delete" button), so the gate reads the button, menu item or link
   around it in the app's tree, as it stands now. Clicking, holding a mouse
   button down on, dragging from, or pressing Enter or Space on a control
   whose label names a commit (the browser's `pay`, `send`, `account`,
   `legal` and `destructive` categories) needs its card's approval for that
   label. Further rules, with key names read the way the helper reads them
   (`super` is ⌘, `keypadenter` is Enter):
   - **Enter.** Enter, or a typed newline, outside a text area may press the
     window's default button, so it is refused while that window holds a
     commit control nobody approved; it is refused on a web page's form too.
   - **Typed tab.** A typed tab, which moves focus to another control, is
     refused outside a text area.
   - **Held keys.** Holding Enter, Delete or Space down (`key_down`) is
     refused.
   - **Shortcuts.** ⌘ or Ctrl with Enter or Delete (`cmd+enter`) is a commit
     named by its keys, approved only by that name.
9. **Typing by ref.** Typing into a ref first clicks the field, checked as a
   click, then checks the element that took focus before the text goes there.
   What the helper receives is the point just checked, never the ref.
10. **Attended only.** Every `desktop.act` and `desktop.computer_use` call, and
    a `desktop.observe` that captures the screen, runs only in an attended run
    (`attendedOnly`); every action is also asked about each time while the run
    is tainted (`askWhenTainted`). The gate refuses every action of a run not
    marked attended.

## Architecture

### Contracts (`@tavi/contracts`)

- `DesktopPort` exposes `apps()`, `tree(app)`, `capture(target, options)`, and
  `act(action, options)`, plus `elementAtPoint(x, y)`, `focusedElement()`, and
  `abort()`.
- `DesktopNode` carries `ref` (`ax-0`, `ax-1`, ...), `role`, `subrole`, `title`,
  `value`, `description`, `bounds`, `enabled`, `focused`, and `children`.
- `createDesktopLiveTarget(desktop, options)` adapts `DesktopPort` into
  `LiveTarget` and `LiveControlTarget`. It hides the screen when focus cannot
  be read, and turns a held mouse button into a drag that is let go when the
  person's control ends. Nothing streams a desktop session to the live view
  or offers its takeover yet.
- Plugin manifests may declare `devices: ["screen"]`.

### macOS Co-Process (`@tavi/plugin-desktop`)

- `packages/builtin/desktop/native/helper.swift` is a native Swift helper that
  communicates over stdio using newline-delimited JSON (`NDJSON`) with a
  `ready` handshake (5 s ready timeout, 15 s per-request timeout). The bridge
  restarts a helper that exits, at most three times.
- Accessibility queries set `AXUIElementSetMessagingTimeout` so hung targets
  never block the bridge, read `kAXSubroleAttribute` on every node, and support
  `get_element_at_point` and `get_focused_element`.
- Screen captures use `ScreenCaptureKit`, downscale to the declared dimensions,
  and report `scale` (`logicalWidth`, `logicalHeight`, `imageWidth`,
  `imageHeight`) with clamped inverse coordinate mapping (`toLogicalPoint`).
- Keyboard input uses `CGEvent` Unicode string synthesis (never the system
  clipboard), mouse drags interpolate across 12 or more steps, and modifier
  flags are always released in a `defer` block.

### Tools and Computer-Use Loop (`apps/cli/src/features/desktop/tools.ts`)

A conversation's desktop calls run one at a time, in order. Screenshots are
kept as artifacts of the run, labelled as the app's content, and the model is
handed them by reference.

- **`desktop.observe`**: returns the focused application and window title, a
  compact accessibility tree with `ax-N` refs (each element's position only
  with `bounds: true`), and an optional downscaled screenshot. It also lists
  the workspace's `desktop.grantedApps` (`grantedApps`), so the model knows
  which apps it may focus and act in before it acts.
- **`desktop.act`**: acts by `ax-N` ref or logical coordinates and returns a
  deterministic before/after state diff (focused app, window title, focused
  element, and value).
- **`desktop.computer_use`**: runs a multi-step loop (8 steps by default, at
  most 25), using the vendor's native computer tool when the connection
  supports it and the generic function-tool adapter otherwise, which is shown
  the app's elements, as data, with each screenshot.
  - **No typing.** It clicks, drags, scrolls and waits, but never types or
    presses keys: it stops and leaves those to `desktop.act`, each asked about
    on its own card.
  - **Every call answered.** Every call of a turn is answered in order, with
    the screen as it stands; one after a refused action is answered as not
    run. Only the newest screenshot and elements are shown.
  - **Refused, never acknowledged.** A vendor's safety confirmation stops the
    loop and is never acknowledged on your behalf; an action with keys held
    down is refused; no step is approved as a commit or for a warning-tier
    app.
