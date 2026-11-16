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
 * keeps nothing from it but a place id.
 */
export const GOOGLE_MAPS_PRESET: McpPreset = {
  id: "google-maps",
  /** The live server's tools and annotations (`tools/list`), and Google's Grounding Lite page (header, attribution, the model rule), checked on this date. */
  checked: "2026-11-09",
  withdrawnIf:
    "Google ends Maps Grounding Lite, changes its address or its API-key header, or withdraws the terms that allow a model to ground answers in Maps data",
  name: "Google Maps",
  description:
    "Places, routes and weather from Google Maps for the model to ground answers in, with your own Maps Platform API key. " +
    "Each answer must show its Google Maps source links, and the model you use with it must not cache, store or train on Google Maps content. " +
    "Google allows grounded output to be kept at most 30 days; Tavi's places store keeps only a place id.",
  config: {
    apiKey: {
      type: "credential",
      required: true,
      label: "Your Maps API key",
      description: "A Google Maps Platform API key with the Maps Grounding Lite API enabled; restrict it to that API",
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
    summary:
      "Places, routes and weather from Google Maps, cited with their Maps links. Google's terms: show each answer's Google Maps links, keep grounded answers at most 30 days, and use a model that does not keep or train on them.",
    category: "search",
    publisher: "Google",
    accountScope: "owner",
    scopes: [],
    tools: {
      search_places: { title: "Search places", says: "Sends your question and its area to Google; show each place's Google Maps link" },
      lookup_weather: { title: "Look up weather", says: "Weather, air quality and pollen for a place" },
      compute_routes: { title: "Compute a route", says: "Distance and time only" },
      search_along_route: {
        title: "Search along a route",
        says: "Sends the route and your question to Google; show each place's Google Maps link",
      },
      resolve_names: { title: "Find a place by name", says: "Turns place names or addresses into Google Maps place ids" },
      resolve_maps_urls: { title: "Read a Google Maps link", says: "Turns Google Maps links into place ids" },
    },
  },
  // Tavi's links into Google's own pages; written from Google's Grounding Lite and Demo Key pages, not walked in the console.
  keySteps: [
    {
      text: "To try it without billing, get Google's Maps Demo Key (prototyping only, with daily caps) and paste it below.",
      link: { label: "Get a Demo Key", url: "https://mapsplatform.google.com/maps-demo-key/" },
    },
    {
      text: "For everyday use, enable the Maps Grounding Lite API in a Google Cloud project of yours (the one you made for Google sign-in will do), with billing linked: its monthly free tier covers personal use.",
      link: { label: "Enable the API", url: "https://console.cloud.google.com/flows/enableapi?apiid=mapstools.googleapis.com" },
    },
    {
      text: "Create an API key, restrict it to the Maps Grounding Lite API, and paste it below.",
      link: { label: "Create a key", url: "https://console.cloud.google.com/apis/credentials" },
    },
  ],
  // Its `tools/list` answers without a key (see above), so Save and test lists the tools whatever the key.
  keyCheckedOnUse: true,
  floors: () => undefined,
};
