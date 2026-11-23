import type { IdeaCadence, IdeaCapability, IdeaCategory, IdeaDraft } from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";

import { ideas as IDEAS_BG, ideaTriggers as IDEA_TRIGGERS_BG } from "./locales/bg.js";
import { ideas as IDEAS_EN } from "./locales/en.js";

/**
 * The idea catalogue: one template per researched personal-agent use case
 * that runs today or runs with a named gap (the cases that cannot run are
 * left out). It belongs to the providers, not the host: the built-in provider keeps the
 * templates whose `requires` the host's census has and scores them by how
 * many `triggers` the person's memory, chats and brief mention; any other
 * provider may use it or ignore it. With nothing known of the person, a
 * template is itself an idea (`catalogueIdea`): it at least teaches something
 * Tavi can really do.
 */
export interface IdeaTemplate {
  /** The use case's id. */
  readonly useCase: string;
  readonly key: string;
  readonly category: IdeaCategory;
  readonly icon: IdeaDraft["icon"];
  /** Everything the idea needs; one missing and the template is never a candidate. */
  readonly requires: readonly IdeaCapability[];
  /** Of `requires`, the ones that ask before acting (sending, booking, filling a form). */
  readonly asks?: readonly IdeaCapability[];
  /**
   * Lower-case words whose mention makes the template likelier, in every language the catalogue speaks (a person's
   * notes may mix them); matched as whole words.
   */
  readonly triggers: readonly string[];
  readonly title: string;
  readonly label: string;
  readonly pitch: string;
  readonly prompt: string;
  readonly cadence?: IdeaCadence;
}

/** A catalogue template's key, as the English words name it: a row without words is a type error. */
type KeyOf<Field> = Field extends `ideas.${infer Key}.title` ? Key : never;
export type CatalogueKey = KeyOf<keyof typeof IDEAS_EN>;

/** A row's words are in `./locales/{en,bg}.ts`, under `ideas.<key>.<field>`; the Bulgarian triggers too. */
type Row = readonly [
  useCase: string,
  key: CatalogueKey,
  category: IdeaCategory,
  icon: IdeaDraft["icon"],
  requires: readonly IdeaCapability[],
  triggers: readonly string[],
  extra?: { readonly asks?: readonly IdeaCapability[]; readonly cadence?: IdeaCadence },
];

const ROWS: readonly Row[] = [
  // 1. Shopping
  [
    "1.1",
    "shopping.landed-cost",
    "shopping",
    "🛒",
    ["browser", "web"],
    ["buy", "price", "wholesale", "alibaba", "temu", "amazon", "import"],
  ],
  ["1.2", "shopping.review-check", "shopping", "🔎", ["browser", "web"], ["reviews", "fake", "counterfeit", "brand", "listing"]],
  // 2. Local vetting
  [
    "2.1",
    "travel.specialist",
    "travel",
    "🔧",
    ["places", "web"],
    ["mechanic", "plumber", "electrician", "contractor", "doctor", "salon", "license"],
  ],
  [
    "2.2",
    "health-home.in-network",
    "health-home",
    "🦷",
    ["care", "web"],
    ["dentist", "insurance", "in-network", "doctor", "appointment", "plan"],
  ],
  // 3. Jobs
  [
    "3.1",
    "work.job-watch",
    "work",
    "💼",
    ["jobs"],
    ["job", "career", "resume", "cv", "hiring", "role", "interview", "salary"],
    { asks: ["jobs"], cadence: "daily" },
  ],
  [
    "3.2",
    "work.application-prefill",
    "work",
    "📋",
    ["browser", "pdf"],
    ["application", "apply", "greenhouse", "lever", "workday"],
    { asks: ["browser"] },
  ],
  // 4. Trends
  [
    "4.1",
    "work.trend-radar",
    "work",
    "📈",
    ["trends"],
    ["trend", "trending", "topic", "news", "market", "competitor", "industry"],
    { asks: ["trends"], cadence: "daily" },
  ],
  ["4.2", "work.comment-clusters", "work", "📰", ["browser"], ["comments", "sentiment", "controversy", "feedback", "thread"]],
  // 5. Leads
  ["5.1", "productivity.prospects", "productivity", "🔎", ["web"], ["leads", "prospects", "sales", "outreach", "clients", "customers"]],
  // 6. Travel
  [
    "6.1",
    "travel.fare-watch",
    "travel",
    "✈️",
    ["travel"],
    ["flight", "flights", "fare", "trip", "travel", "vacation", "holiday", "airport"],
    { cadence: "daily" },
  ],
  ["6.2", "travel.hotels", "travel", "🏨", ["web"], ["hotel", "hotels", "stay", "accommodation", "airbnb", "booking"]],
  ["6.3", "travel.car-or-rail", "travel", "🚆", ["web", "browser"], ["train", "rail", "car rental", "rental", "drive", "transit"]],
  ["6.4", "travel.fuel-route", "travel", "⛽", ["places"], ["road trip", "fuel", "gas", "ev", "charging", "drive"]],
  [
    "6.5",
    "travel.itinerary",
    "travel",
    "🗺️",
    ["places", "web"],
    ["itinerary", "city break", "sightseeing", "museums", "restaurants", "visit"],
  ],
  [
    "6.6",
    "travel.visa-packing",
    "travel",
    "🛂",
    ["web", "reminders"],
    ["visa", "passport", "border", "packing", "abroad", "international"],
  ],
  // 7. Hobbies
  ["7.1", "learning.sketch-critique", "learning", "🎨", ["image"], ["drawing", "sketch", "painting", "art", "illustration", "course"]],
  ["7.2", "learning.garden-plan", "learning", "🌱", ["web"], ["garden", "gardening", "plants", "seeds", "vegetables", "balcony"]],
  [
    "7.3",
    "health-home.fridge-recipes",
    "health-home",
    "🍳",
    ["image"],
    ["cooking", "recipe", "recipes", "baking", "fridge", "dinner", "bread"],
  ],
  ["7.4", "learning.mix-practice", "learning", "🎸", ["web"], ["music", "guitar", "piano", "mixing", "practice", "band", "song"]],
  [
    "7.5",
    "productivity.photo-organise",
    "productivity",
    "📷",
    ["files", "sandbox"],
    ["photos", "photography", "camera", "exif", "pictures"],
    { asks: ["files"] },
  ],
  ["7.6", "learning.cut-list", "learning", "🪚", ["sandbox"], ["woodworking", "diy", "lumber", "build", "shelf", "workshop"]],
  ["7.7", "learning.canon-audit", "learning", "✍️", ["files"], ["novel", "manuscript", "writing", "story", "worldbuilding", "chapter"]],
  // 8. Life ops
  [
    "8.1",
    "productivity.morning-brief",
    "productivity",
    "🌅",
    ["calendar", "mailbox"],
    ["morning", "brief", "schedule", "meetings", "inbox", "day"],
  ],
  ["8.2", "productivity.meeting-slots", "productivity", "📅", ["calendar"], ["meeting", "timezone", "schedule", "call", "availability"]],
  [
    "8.3",
    "productivity.inbox-triage",
    "productivity",
    "📥",
    ["mailbox"],
    ["email", "inbox", "unread", "replies", "mail"],
    { asks: ["mailbox"] },
  ],
  [
    "8.4",
    "productivity.downloads-cleanup",
    "productivity",
    "🗂️",
    ["files"],
    ["downloads", "files", "folder", "clutter", "documents", "organise", "organize"],
    { asks: ["files"] },
  ],
  [
    "8.5",
    "productivity.subscriptions",
    "productivity",
    "🧾",
    ["browser", "web"],
    ["subscription", "subscriptions", "cancel", "billing", "renewal"],
    { asks: ["browser"] },
  ],
  [
    "8.6",
    "health-home.appliance-records",
    "health-home",
    "🔧",
    ["web", "reminders"],
    ["appliance", "warranty", "manual", "boiler", "filter", "maintenance"],
  ],
  // 9. Learning
  ["9.1", "learning.tutor", "learning", "🎓", ["memory"], ["homework", "study", "math", "school", "exam", "tutor"]],
  [
    "9.2",
    "learning.language",
    "learning",
    "🗣️",
    ["memory"],
    ["language", "spanish", "french", "german", "learning", "fluent", "vocabulary"],
  ],
  ["9.3", "learning.flashcards", "learning", "📚", ["pdf"], ["book", "article", "reading", "flashcards", "anki", "notes"]],
  ["9.4", "learning.tech-roadmap", "learning", "🧠", ["web"], ["programming", "code", "developer", "bug", "stacktrace", "learn"]],
  ["9.5", "learning.exam-prep", "learning", "🎓", ["memory", "reminders"], ["exam", "certification", "test", "prep", "study"]],
  // 10. Health
  ["10.1", "health-home.form-check", "health-home", "🏃", ["video"], ["workout", "squat", "lifting", "gym", "form", "exercise"]],
  ["10.2", "health-home.meal-plan", "health-home", "🥗", ["memory"], ["meal", "nutrition", "diet", "macros", "protein", "meal prep"]],
  ["10.3", "health-home.sleep", "health-home", "😴", ["memory"], ["sleep", "insomnia", "tired", "jet lag", "rest"]],
  [
    "10.4",
    "health-home.thought-record",
    "health-home",
    "💬",
    ["memory"],
    ["stress", "anxious", "mood", "journal", "reflection", "overwhelmed"],
  ],
  [
    "10.5",
    "health-home.supplements",
    "health-home",
    "💊",
    ["reminders", "web"],
    ["supplement", "supplements", "vitamin", "medication", "pills"],
  ],
  // 11. Home
  [
    "11.1",
    "health-home.rental-watch",
    "health-home",
    "🏘️",
    ["web", "routines"],
    ["rent", "apartment", "flat", "rental", "house hunting", "moving"],
    { cadence: "daily" },
  ],
  [
    "11.2",
    "health-home.load-shift",
    "health-home",
    "⚡",
    ["home"],
    ["energy", "electricity", "smart home", "home assistant", "tariff"],
    { asks: ["home"] },
  ],
  ["11.3", "health-home.recycling", "health-home", "♻️", ["image", "web"], ["recycling", "waste", "bin", "trash", "compost"]],
  [
    "11.4",
    "health-home.neighbourhood",
    "health-home",
    "🏠",
    ["places"],
    ["neighbourhood", "neighborhood", "move", "area", "schools", "noise"],
  ],
  // 12. Family
  [
    "12.1",
    "health-home.school-forms",
    "health-home",
    "🧒",
    ["pdf"],
    ["school", "form", "permission slip", "kids", "child", "medical form"],
    { asks: ["pdf"] },
  ],
  ["12.3", "people.carpool", "people", "🚗", ["messaging"], ["carpool", "pickup", "practice", "team", "parents"], { asks: ["messaging"] }],
  // 13. Pets
  [
    "13.1",
    "health-home.pet-vaccines",
    "health-home",
    "🐾",
    ["reminders", "pdf"],
    ["dog", "cat", "pet", "vet", "vaccine", "boarding", "kennel"],
  ],
  ["13.2", "health-home.pet-diet", "health-home", "🐾", ["reminders"], ["dog food", "cat food", "pet", "diet", "switch food"]],
  ["13.3", "health-home.lost-pet", "health-home", "🐾", ["web"], ["lost", "missing", "pet", "shelter"]],
  // 14. Auto
  ["14.1", "travel.car-code", "travel", "🚗", ["web"], ["car", "check engine", "obd", "dtc", "warning light"]],
  ["14.2", "travel.bike-wear", "travel", "🚲", ["memory", "reminders"], ["bike", "cycling", "chain", "drivetrain", "bicycle"]],
  ["14.3", "travel.recalls", "travel", "🚗", ["web", "routines"], ["car", "recall", "vehicle", "safety"], { cadence: "weekly" }],
  // 15. Wardrobe
  ["15.1", "shopping.capsule", "shopping", "👕", ["image"], ["wardrobe", "clothes", "outfit", "style", "fashion"]],
  ["15.2", "shopping.outfit", "shopping", "👕", ["calendar", "web"], ["outfit", "weather", "dress", "clothes", "meeting"]],
  ["15.3", "shopping.mending", "shopping", "🧵", ["image", "web"], ["mending", "repair", "tailor", "sew", "resale", "vintage"]],
  // 16. Gaming
  ["16.1", "learning.dnd-lore", "learning", "🎲", ["memory"], ["d&d", "dnd", "campaign", "dungeon master", "tabletop", "rpg"]],
  ["16.2", "learning.rules", "learning", "🎲", ["pdf"], ["board game", "rules", "rulebook", "game night"]],
  [
    "16.3",
    "people.game-night",
    "people",
    "🎲",
    ["messaging"],
    ["game night", "co-op", "gaming", "friends", "steam"],
    { asks: ["messaging"] },
  ],
  // 17. Genealogy
  ["17.1", "learning.cursive", "learning", "🌳", ["image"], ["ancestors", "letter", "cursive", "handwriting", "archive", "genealogy"]],
  [
    "17.2",
    "learning.census",
    "learning",
    "🌳",
    ["browser", "web"],
    ["census", "ancestry", "family tree", "genealogy", "familysearch"],
    { asks: ["browser"] },
  ],
  ["17.3", "learning.gedcom", "learning", "🌳", ["files", "sandbox"], ["gedcom", "family tree", "genealogy"]],
  // 18. PKM
  [
    "18.1",
    "productivity.note-links",
    "productivity",
    "🗂️",
    ["files", "sandbox"],
    ["notes", "obsidian", "zettelkasten", "vault", "knowledge"],
  ],
  [
    "18.2",
    "productivity.distil",
    "productivity",
    "📋",
    ["pdf", "web"],
    ["highlights", "summary", "summarise", "summarize", "reading", "article"],
  ],
  ["18.3", "productivity.bookmarks", "productivity", "🔎", ["web", "files"], ["bookmarks", "read later", "saved", "links", "tabs"]],
  // 19. Culture
  [
    "19.1",
    "people.recommendations",
    "people",
    "🎬",
    ["memory", "web"],
    ["books", "films", "movies", "series", "reading", "watch", "novel"],
  ],
  [
    "19.2",
    "people.tour-radar",
    "people",
    "🎟️",
    ["web", "routines"],
    ["concert", "tour", "band", "theatre", "theater", "gig", "tickets"],
    { cadence: "weekly" },
  ],
  [
    "19.3",
    "people.keep-in-touch",
    "people",
    "👋",
    ["memory", "reminders"],
    ["friend", "friends", "family", "catch up", "birthday", "call"],
  ],
];

export const IDEA_CATALOGUE: readonly IdeaTemplate[] = ROWS.map(([useCase, key, category, icon, requires, triggers, extra]) => ({
  useCase,
  key,
  category,
  icon,
  requires,
  triggers: [...triggers, ...IDEA_TRIGGERS_BG[key]],
  title: IDEAS_EN[`ideas.${key}.title`],
  label: IDEAS_EN[`ideas.${key}.label`],
  pitch: IDEAS_EN[`ideas.${key}.pitch`],
  prompt: IDEAS_EN[`ideas.${key}.prompt`],
  ...(extra?.asks === undefined ? {} : { asks: extra.asks }),
  ...(extra?.cadence === undefined ? {} : { cadence: extra.cadence }),
}));

/** An idea's words: what the card says and the prompt it sends as the person's message. */
export type IdeaWords = Pick<IdeaTemplate, "title" | "label" | "pitch" | "prompt">;

/** The catalogue's words in each language besides English, by `ideas.<key>.<field>`. */
const TRANSLATIONS: { readonly [L in Exclude<Locale, "en">]: { readonly [key: string]: string | undefined } } = { bg: IDEAS_BG };

/** The catalogue's words in every language, English first. */
const WORDS: { readonly [L in Locale]: { readonly [key: string]: string | undefined } } = { en: IDEAS_EN, ...TRANSLATIONS };

/**
 * A template's words in `locale`. Only a template that still says what the catalogue says in one of its languages,
 * word for word, is translated (so an idea stored before a language change is said in the new one): a provider's own
 * template, or one it rewrote, stays as written.
 */
export function ideaWordsIn(template: IdeaWords & Pick<IdeaTemplate, "key">, locale: Locale): IdeaWords {
  const own = { title: template.title, label: template.label, pitch: template.pitch, prompt: template.prompt };
  const fields = ["title", "label", "pitch", "prompt"] as const;
  const catalogued = Object.values(WORDS).some((words) => fields.every((field) => words[`ideas.${template.key}.${field}`] === own[field]));
  if (!catalogued) return own;
  const words = WORDS[locale];
  const [title, label, pitch, prompt] = fields.map((field) => words[`ideas.${template.key}.${field}`]);
  return title === undefined || label === undefined || pitch === undefined || prompt === undefined ? own : { title, label, pitch, prompt };
}

/**
 * A template as an idea with nothing personal behind it: the cold start, and the fallback when memory is off. Its
 * words are in `locale`, the workspace's language (English when absent).
 */
export function catalogueIdea(template: IdeaTemplate, locale: Locale = "en"): IdeaDraft {
  const words = ideaWordsIn(template, locale);
  return {
    key: template.key,
    templateId: template.useCase,
    category: template.category,
    icon: template.icon,
    title: words.title,
    pitch: words.pitch,
    label: words.label,
    prompt: words.prompt,
    basis: [{ kind: "general", ref: template.useCase }],
    uses: template.requires.map((capability) => ({ capability, approval: template.asks?.includes(capability) ?? false })),
    ...(template.cadence === undefined ? {} : { recurring: { cadence: template.cadence } }),
  };
}

/** The templates whose every requirement is available. */
export function availableTemplates(
  available: ReadonlySet<IdeaCapability>,
  catalogue: readonly IdeaTemplate[] = IDEA_CATALOGUE,
): readonly IdeaTemplate[] {
  return catalogue.filter((template) => template.requires.every((capability) => available.has(capability)));
}

/**
 * How many of a template's triggers `text` mentions, as whole words (a
 * trigger of several words as a phrase). Lexical on purpose, like the
 * heartbeat's memory read: untrusted words never reach an embedding.
 */
export function triggerScore(template: IdeaTemplate, text: string): number {
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}&-]+/gu, " ")} `;
  return template.triggers.filter((trigger) => haystack.includes(` ${trigger} `)).length;
}
