# Minimal browser view

The smallest plugin that can replace Tavi's built-in browser view
(`tavi.browserview`): a UI-only plugin — no owner code — that shows the
agent's page as a picture with its address. See
[PLUGINS.md](../../../docs/PLUGINS.md#ui-plugins) for the ABI.

```bash
tavi plugins install examples/ui-plugins/minimal-browser-view
tavi plugins approve example.browserview 1.0.0
tavi plugins enable example.browserview
tavi plugins ui set-role browser-view example.browserview --yes
```

Every open canvas picks it up at once. `tavi plugins ui set-role browser-view
builtin` goes back to the built-in.

What it can do: receive `browser.live` — frames, addresses, actions, and
`hidden` when a page is sensitive (never the page itself) or when too many
browsers are shown at once (`paused`) — and ask for a height,
a badge or a navigation. What it cannot: reach the network, the canvas or
its session, open windows, take the browser over or send it input. Taking
over always uses Tavi's own surface, whatever the view.

Its colours, type sizes and spacing are the canvas's theme tokens, which the
host sends in `init` and `theme`. `plugin-base.css` defines all of them with
the canvas's light and dark values until then, or outside Tavi: copy it into
your own plugin and link it before your stylesheet (see
[PLUGINS.md](../../../docs/PLUGINS.md#ui-plugins)).

It speaks the canvas's language. Its words are in `locales/en.json` and
`locales/bg.json`, declared under `locales` (manifest `schemaVersion: 3`). The
host hands the page its messages in `init` and again in a `locale` message when
the person changes language. `live.js` then says its status line, its title and
its picture's description in that language, and anything it lacks in English.
The Bulgarian pack also translates the plugin's name, description, panel title
and disclosure. If you copy it under your own name and title, change them in
`locales/bg.json` too, or delete the `manifest` part of that pack (see
[Translating your plugin](../../../docs/PLUGINS.md#translating-your-plugin)).
