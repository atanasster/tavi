import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import type { McpPreset } from "./index.js";

/**
 * Google Maps Grounding Lite (`https://mapstools.googleapis.com/mcp`,
 * Streamable HTTP): the
 * one Google route whose terms let a model write answers from Maps data
 * (Service Specific Terms §10). The person's own Maps
 * Platform API key goes in `X-Goog-Api-Key`.
 *
 * Its six tools are reads: `search_places`, `lookup_weather`,
 * `compute_routes`, `search_along_route` (added by Google after 17 Oct 2026),
 * `resolve_names` and `resolve_maps_urls`, each annotated
 * `readOnlyHint: true` (and not destructive) in the live server's `tools/list`
 * on 9 Nov 2026, which answers without a key. The annotations are right, so
 * the preset sets no effect of its own. The guide walk
 * (docs/use-cases/connected-apps/google-maps.md) connects it with a real key.
 *
 * Google's terms bind the operator, not only Tavi: every grounded answer shows
 * its Google Maps source links (`googleMapsLinks`), and the model connection
 * used with it must not cache, store or train on Google Maps content. Places
 * keeps nothing from it but a place id. Its words a person reads are `t`'s (English by default).
 */
export function googleMapsPreset(t: CoreT = coreEnglish): McpPreset {
  return {
    id: "google-maps",
    /** The live server's tools and annotations (`tools/list`), and Google's Grounding Lite page (header, attribution, the model rule), checked on this date. */
    checked: "2026-11-09",
    withdrawnIf:
      "Google ends Maps Grounding Lite, changes its address or its API-key header, or withdraws the terms that allow a model to ground answers in Maps data",
    name: "Google Maps",
    description: t("mcp.preset.googleMaps.description"),
    config: {
      apiKey: {
        type: "credential",
        required: true,
        label: t("mcp.preset.googleMaps.apiKey.label"),
        description: t("mcp.preset.googleMaps.apiKey.description"),
      },
    },
    block: {
      transport: "http",
      url: { value: "https://mapstools.googleapis.com/mcp" },
      headers: { "X-Goog-Api-Key": { setting: "apiKey" } },
      auth: "headers",
      exposure: "auto",
    },
    app: {
      id: "google-maps",
      name: "Google Maps",
      summary: t("mcp.preset.googleMaps.summary"),
      category: "search",
      publisher: "Google",
      accountScope: "owner",
      scopes: [],
      tools: {
        search_places: { title: t("mcp.preset.googleMaps.tool.searchPlaces"), says: t("mcp.preset.googleMaps.tool.searchPlaces.says") },
        lookup_weather: { title: t("mcp.preset.googleMaps.tool.lookupWeather"), says: t("mcp.preset.googleMaps.tool.lookupWeather.says") },
        compute_routes: { title: t("mcp.preset.googleMaps.tool.computeRoutes"), says: t("mcp.preset.googleMaps.tool.computeRoutes.says") },
        search_along_route: {
          title: t("mcp.preset.googleMaps.tool.searchAlongRoute"),
          says: t("mcp.preset.googleMaps.tool.searchAlongRoute.says"),
        },
        resolve_names: { title: t("mcp.preset.googleMaps.tool.resolveNames"), says: t("mcp.preset.googleMaps.tool.resolveNames.says") },
        resolve_maps_urls: {
          title: t("mcp.preset.googleMaps.tool.resolveMapsUrls"),
          says: t("mcp.preset.googleMaps.tool.resolveMapsUrls.says"),
        },
      },
    },
    // Tavi's links into Google's own pages; written from Google's Grounding Lite and Demo Key pages, not walked in the console.
    keySteps: [
      {
        text: t("mcp.preset.googleMaps.keyStep.demo"),
        link: { label: t("mcp.preset.googleMaps.keyStep.demo.link"), url: "https://mapsplatform.google.com/maps-demo-key/" },
      },
      {
        text: t("mcp.preset.googleMaps.keyStep.enable"),
        link: {
          label: t("mcp.preset.googleMaps.keyStep.enable.link"),
          url: "https://console.cloud.google.com/flows/enableapi?apiid=mapstools.googleapis.com",
        },
      },
      {
        text: t("mcp.preset.googleMaps.keyStep.create"),
        link: { label: t("mcp.preset.googleMaps.keyStep.create.link"), url: "https://console.cloud.google.com/apis/credentials" },
      },
    ],
    // Its `tools/list` answers without a key (see above), so Save and test lists the tools whatever the key.
    keyCheckedOnUse: true,
    floors: () => undefined,
  };
}

export const GOOGLE_MAPS_PRESET: McpPreset = googleMapsPreset();
