import type { CatalogFor } from "../../i18n.js";

import type { presets as en } from "../en/presets.js";

/**
 * The `core` words for MCP presets and Tavi's steps for a provider's shared OAuth client, in Bulgarian. A third-party
 * console's own buttons and menus (Todoist's Settings, Google's Next and Branding) are named as that console shows them.
 */
export const presets = {
  "mcp.preset.todoist.description":
    "Задачите и проектите ти в Todoist през официалния хостван MCP сървър на Doist: там Tavi води задачите ти, ако ги държиш в Todoist.",
  "mcp.preset.todoist.summary": "Добавя, намира, променя и отбелязва като готови задачите ти в Todoist, като пита, преди да изтрие нещо.",
  "mcp.preset.todoist.tool.addTasks": "Добави задачи",
  "mcp.preset.todoist.tool.findTasks": "Намери задачи",
  "mcp.preset.todoist.tool.findTasksByDate": "Намери задачи по дата",
  "mcp.preset.todoist.tool.updateTasks": "Промени задачи",
  "mcp.preset.todoist.tool.completeTasks": "Отбележи задачи като готови",
  "mcp.preset.todoist.tool.uncompleteTasks": "Отвори задачи отново",
  "mcp.preset.todoist.tool.findProjects": "Намери проекти",
  "mcp.preset.todoist.tool.getOverview": "Обзор",
  "mcp.preset.todoist.tool.deleteObject": "Изтрий",
  "mcp.preset.todoist.tool.deleteObject.says": "Изтрива завинаги задача, проект, раздел или коментар",
  "mcp.preset.todoistToken.name": "Todoist (API токен)",
  "mcp.preset.todoistToken.description":
    "Задачите и проектите ти в Todoist през официалния хостван MCP сървър на Doist, със собствения ти API токен за Todoist вместо вход.",
  "mcp.preset.todoistToken.summary":
    "Todoist със собствения ти API токен вместо вход: добавя, намира, променя и отбелязва като готови задачи, като пита, преди да изтрие нещо.",
  "mcp.preset.todoistToken.apiToken.label": "API токенът ти за Todoist",
  "mcp.preset.todoistToken.apiToken.description": "API токенът ти за Todoist (Todoist → Settings → Integrations → Developer)",
  "mcp.preset.todoistToken.keyStep":
    "В Todoist отвори Settings → Integrations → Developer и копирай API токена си. Той дава достъп до целия ти акаунт: пази го само за себе си, а за да спреш достъпа на Tavi, издай нов там.",
  "mcp.preset.todoistToken.keyStep.link": "Отвори настройките на Todoist",
  "mcp.preset.googleMaps.description":
    "Места, маршрути и времето от Google Maps, на които моделът да основава отговорите си, със собствения ти API ключ за Maps Platform. " +
    "Всеки отговор трябва да показва връзките си към Google Maps, а моделът, който ползваш с него, не бива да кешира и пази съдържание от Google Maps, нито да се обучава върху него. " +
    "Google позволява тези отговори да се пазят най-много 30 дни; хранилището за места на Tavi пази само идентификатора на мястото.",
  "mcp.preset.googleMaps.summary":
    "Места, маршрути и времето от Google Maps, с връзките им към Google Maps. Условията на Google: показвай връзките към Google Maps на всеки отговор, пази тези отговори най-много 30 дни и ползвай модел, който не ги пази и не се обучава върху тях.",
  "mcp.preset.googleMaps.apiKey.label": "API ключът ти за Maps",
  "mcp.preset.googleMaps.apiKey.description":
    "API ключ за Google Maps Platform с включен Maps Grounding Lite API; ограничи го само до този API",
  "mcp.preset.googleMaps.tool.searchPlaces": "Търси места",
  "mcp.preset.googleMaps.tool.searchPlaces.says":
    "Изпраща въпроса ти и района му към Google; показвай връзката към Google Maps на всяко място",
  "mcp.preset.googleMaps.tool.lookupWeather": "Провери времето",
  "mcp.preset.googleMaps.tool.lookupWeather.says": "Времето, качеството на въздуха и полените за дадено място",
  "mcp.preset.googleMaps.tool.computeRoutes": "Изчисли маршрут",
  "mcp.preset.googleMaps.tool.computeRoutes.says": "Само разстояние и време",
  "mcp.preset.googleMaps.tool.searchAlongRoute": "Търси по маршрут",
  "mcp.preset.googleMaps.tool.searchAlongRoute.says":
    "Изпраща маршрута и въпроса ти към Google; показвай връзката към Google Maps на всяко място",
  "mcp.preset.googleMaps.tool.resolveNames": "Намери място по име",
  "mcp.preset.googleMaps.tool.resolveNames.says": "Превръща имена или адреси на места в идентификатори на места в Google Maps",
  "mcp.preset.googleMaps.tool.resolveMapsUrls": "Прочети връзка към Google Maps",
  "mcp.preset.googleMaps.tool.resolveMapsUrls.says": "Превръща връзки към Google Maps в идентификатори на места",
  "mcp.preset.googleMaps.keyStep.demo":
    "За да го пробваш без плащане, вземи Maps Demo Key от Google (само за прототипи, с дневни ограничения) и го постави по-долу.",
  "mcp.preset.googleMaps.keyStep.demo.link": "Вземи Demo Key",
  "mcp.preset.googleMaps.keyStep.enable":
    "За всекидневна употреба включи Maps Grounding Lite API в свой проект в Google Cloud (става и този за входа с Google) със свързано плащане: месечният безплатен лимит покрива личната употреба.",
  "mcp.preset.googleMaps.keyStep.enable.link": "Включи API",
  "mcp.preset.googleMaps.keyStep.create": "Създай API ключ, ограничи го до Maps Grounding Lite API и го постави по-долу.",
  "mcp.preset.googleMaps.keyStep.create.link": "Създай ключ",
  "mcp.preset.homeassistant.description": "Управлява устройствата, достъпни за Assist, през MCP сървъра на Home Assistant.",
  "mcp.preset.homeassistant.summary": "Питай за устройствата, достъпни за Assist, и ги управлявай.",
  "mcp.preset.homeassistant.url.label": "MCP адресът му",
  "mcp.preset.homeassistant.url.description": "напр. http://homeassistant.local:8123/api/mcp",
  "mcp.preset.homeassistant.token.label": "Дълготраен токен за достъп",
  "mcp.preset.homeassistant.token.description": "Дълготраен токен за достъп (Profile → Security)",
  "mcp.preset.homeassistant.tool.turnOn": "Включи",
  "mcp.preset.homeassistant.tool.turnOff": "Изключи",
  "mcp.preset.homeassistant.tool.turn.says": "Пита всеки път, освен ако е лампа, ключ, вентилатор, мултимедия или климатик",
  "mcp.preset.homeassistant.tool.toggle": "Превключи",
  "mcp.preset.homeassistant.tool.getLiveContext": "Прочети състоянието на устройствата",
  "mcp.preset.hosted.description":
    "Акаунтът ти в {name} през официалния хостван MCP сървър на {publisher}: един вход, без собствен клиент.",
  "mcp.preset.linear.summary": "Намира, създава и обновява задачите и проектите ти в Linear.",
  "mcp.preset.notion.summary": "Търси, чете и пише в страниците и базите данни в Notion, които споделиш с него.",
  "mcp.preset.sentry.summary": "Преглежда проблемите, събитията и проектите ти в Sentry.",
  "mcp.preset.stripe.summary": "Намира и управлява клиентите, плащанията и фактурите ти в Stripe.",
  "mcp.preset.figma.summary": "Чете дизайните ти във Figma: рамките, компонентите и променливите им.",
  "app.clientSetup.google.title": "Настрой Google",
  "app.clientSetup.google.project": "Създай свой проект в Google Cloud, например с име tavi.",
  "app.clientSetup.google.project.link": "Създай проект",
  "app.clientSetup.google.apis": "Включи в него Google Calendar и Gmail API: избери Next, после Enable.",
  "app.clientSetup.google.apis.link": "Включи API",
  "app.clientSetup.google.signIn":
    "Настрой входа: дай име на приложението, посочи имейла си за поддръжка и контакт, избери External, приеми правилата на Google и натисни Create.",
  "app.clientSetup.google.signIn.link": "Настрой входа",
  "app.clientSetup.google.signIn.appName": "Име на приложението",
  "app.clientSetup.google.branding":
    "В Branding добави начална страница, политика за поверителност и разрешения домейн github.com и натисни Save. После в Audience избери Publish app и Confirm: приложение, оставено в Testing, прекратява входа ти на всеки 7 дни.",
  "app.clientSetup.google.branding.link": "Отвори Branding",
  "app.clientSetup.google.branding.homePage": "Начална страница",
  "app.clientSetup.google.branding.privacy": "Политика за поверителност",
  "app.clientSetup.google.branding.domain": "Разрешен домейн",
  "app.clientSetup.google.client":
    "Създай OAuth клиент от тип Desktop app. Не е нужен адрес за пренасочване: клиент за Desktop се връща на този компютър през произволен порт.",
  "app.clientSetup.google.client.link": "Създай клиент",
  "app.clientSetup.google.download":
    "В прозореца с новия клиент избери Download JSON, преди да го затвориш (Google показва тайния му ключ само там), и пусни файла тук.",
} as const satisfies CatalogFor<typeof en>;
