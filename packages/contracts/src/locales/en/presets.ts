/**
 * The `core` words for MCP presets (Discover and each preset's page in Connected apps: its summary, tools, settings
 * and key steps) and Tavi's steps for a provider's shared OAuth client, in English. What the model reads of a server
 * (its tools' descriptions, its search line) is never one of these.
 */
export const presets = {
  "mcp.preset.todoist.description":
    "Your Todoist tasks and projects, through Doist's official hosted MCP server: Tavi's task home when you keep tasks there.",
  "mcp.preset.todoist.summary": "Add, find, change and complete your Todoist tasks, asking before anything is deleted.",
  "mcp.preset.todoist.tool.addTasks": "Add tasks",
  "mcp.preset.todoist.tool.findTasks": "Find tasks",
  "mcp.preset.todoist.tool.findTasksByDate": "Find tasks by date",
  "mcp.preset.todoist.tool.updateTasks": "Change tasks",
  "mcp.preset.todoist.tool.completeTasks": "Complete tasks",
  "mcp.preset.todoist.tool.uncompleteTasks": "Reopen tasks",
  "mcp.preset.todoist.tool.findProjects": "Find projects",
  "mcp.preset.todoist.tool.getOverview": "Overview",
  "mcp.preset.todoist.tool.deleteObject": "Delete",
  "mcp.preset.todoist.tool.deleteObject.says": "Deletes a task, project, section or comment for good",
  "mcp.preset.todoistToken.name": "Todoist (API token)",
  "mcp.preset.todoistToken.description":
    "Your Todoist tasks and projects through Doist's official hosted MCP server, reached with your own Todoist API token instead of a sign-in.",
  "mcp.preset.todoistToken.summary":
    "Todoist with your own API token instead of a sign-in: add, find, change and complete tasks, asking before anything is deleted.",
  "mcp.preset.todoistToken.apiToken.label": "Your Todoist API token",
  "mcp.preset.todoistToken.apiToken.description": "Your Todoist API token (Todoist → Settings → Integrations → Developer)",
  "mcp.preset.todoistToken.keyStep":
    "In Todoist, open Settings → Integrations → Developer and copy your API token. It reaches your whole account: keep it to yourself, and issue a new one there to cut Tavi off.",
  "mcp.preset.todoistToken.keyStep.link": "Open Todoist's settings",
  "mcp.preset.googleMaps.description":
    "Places, routes and weather from Google Maps for the model to ground answers in, with your own Maps Platform API key. " +
    "Each answer must show its Google Maps source links, and the model you use with it must not cache, store or train on Google Maps content. " +
    "Google allows grounded output to be kept at most 30 days; Tavi's places store keeps only a place id.",
  "mcp.preset.googleMaps.summary":
    "Places, routes and weather from Google Maps, cited with their Maps links. Google's terms: show each answer's Google Maps links, keep grounded answers at most 30 days, and use a model that does not keep or train on them.",
  "mcp.preset.googleMaps.apiKey.label": "Your Maps API key",
  "mcp.preset.googleMaps.apiKey.description":
    "A Google Maps Platform API key with the Maps Grounding Lite API enabled; restrict it to that API",
  "mcp.preset.googleMaps.tool.searchPlaces": "Search places",
  "mcp.preset.googleMaps.tool.searchPlaces.says": "Sends your question and its area to Google; show each place's Google Maps link",
  "mcp.preset.googleMaps.tool.lookupWeather": "Look up weather",
  "mcp.preset.googleMaps.tool.lookupWeather.says": "Weather, air quality and pollen for a place",
  "mcp.preset.googleMaps.tool.computeRoutes": "Compute a route",
  "mcp.preset.googleMaps.tool.computeRoutes.says": "Distance and time only",
  "mcp.preset.googleMaps.tool.searchAlongRoute": "Search along a route",
  "mcp.preset.googleMaps.tool.searchAlongRoute.says": "Sends the route and your question to Google; show each place's Google Maps link",
  "mcp.preset.googleMaps.tool.resolveNames": "Find a place by name",
  "mcp.preset.googleMaps.tool.resolveNames.says": "Turns place names or addresses into Google Maps place ids",
  "mcp.preset.googleMaps.tool.resolveMapsUrls": "Read a Google Maps link",
  "mcp.preset.googleMaps.tool.resolveMapsUrls.says": "Turns Google Maps links into place ids",
  "mcp.preset.googleMaps.keyStep.demo":
    "To try it without billing, get Google's Maps Demo Key (prototyping only, with daily caps) and paste it below.",
  "mcp.preset.googleMaps.keyStep.demo.link": "Get a Demo Key",
  "mcp.preset.googleMaps.keyStep.enable":
    "For everyday use, enable the Maps Grounding Lite API in a Google Cloud project of yours (the one you made for Google sign-in will do), with billing linked: its monthly free tier covers personal use.",
  "mcp.preset.googleMaps.keyStep.enable.link": "Enable the API",
  "mcp.preset.googleMaps.keyStep.create": "Create an API key, restrict it to the Maps Grounding Lite API, and paste it below.",
  "mcp.preset.googleMaps.keyStep.create.link": "Create a key",
  "mcp.preset.homeassistant.description": "Control exposed entities through Home Assistant's MCP server.",
  "mcp.preset.homeassistant.summary": "Ask about and control the devices you expose to Assist.",
  "mcp.preset.homeassistant.url.label": "Its MCP address",
  "mcp.preset.homeassistant.url.description": "e.g. http://homeassistant.local:8123/api/mcp",
  "mcp.preset.homeassistant.token.label": "A long-lived access token",
  "mcp.preset.homeassistant.token.description": "A long-lived access token (Profile → Security)",
  "mcp.preset.homeassistant.tool.turnOn": "Turn on",
  "mcp.preset.homeassistant.tool.turnOff": "Turn off",
  "mcp.preset.homeassistant.tool.turn.says": "Asked every time unless it is a light, a switch, a fan, media or climate",
  "mcp.preset.homeassistant.tool.toggle": "Toggle",
  "mcp.preset.homeassistant.tool.getLiveContext": "Read device states",
  "mcp.preset.hosted.description":
    "Your {name} account, through {publisher}'s official hosted MCP server: one sign-in, no client of your own.",
  "mcp.preset.linear.summary": "Find, create and update your Linear issues and projects.",
  "mcp.preset.notion.summary": "Search, read and write the Notion pages and databases you share with it.",
  "mcp.preset.sentry.summary": "Look into your Sentry issues, events and projects.",
  "mcp.preset.stripe.summary": "Look up and manage your Stripe customers, payments and invoices.",
  "mcp.preset.figma.summary": "Read your Figma designs: their frames, components and variables.",
  "app.clientSetup.google.title": "Set up Google",
  "app.clientSetup.google.project": "Create a Google Cloud project of your own, named, for example, tavi.",
  "app.clientSetup.google.project.link": "Create a project",
  "app.clientSetup.google.apis": "Enable the Google Calendar and Gmail APIs in it: choose Next, then Enable.",
  "app.clientSetup.google.apis.link": "Enable the APIs",
  "app.clientSetup.google.signIn":
    "Set up sign-in: give the app a name, your email as its support and contact email, choose External, agree to Google's policy, and Create.",
  "app.clientSetup.google.signIn.link": "Set up sign-in",
  "app.clientSetup.google.signIn.appName": "App name",
  "app.clientSetup.google.branding":
    "On Branding, add a home page, a privacy policy and the authorized domain github.com, and Save. Then on Audience, choose Publish app and Confirm: an app left in Testing signs you out every 7 days.",
  "app.clientSetup.google.branding.link": "Open Branding",
  "app.clientSetup.google.branding.homePage": "Home page",
  "app.clientSetup.google.branding.privacy": "Privacy policy",
  "app.clientSetup.google.branding.domain": "Authorized domain",
  "app.clientSetup.google.client":
    "Create an OAuth client of type Desktop app. No redirect address is needed: a Desktop client comes back to this computer on any port.",
  "app.clientSetup.google.client.link": "Create a client",
  "app.clientSetup.google.download":
    "In the dialog that shows the new client, choose Download JSON before you close it (Google shows its secret only there), and drop the file here.",
} as const;
