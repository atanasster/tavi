import type { CatalogFor } from "../../i18n.js";

import type { plugins as en } from "../en/plugins.js";

/** The `core` words of the built-in plugins a person reads, in Bulgarian. */
export const plugins = {
  // Описанието на всеки вграден плъгин в списъка с плъгини.
  "plugins.catalog.tavi.providerreadiness": "Пуска одобрените доставчици, преди Tavi да започне да приема работа.",
  "plugins.catalog.tavi.providers": "Доставчиците на търсене, изтегляне и модели за всеки акаунт.",
  "plugins.catalog.tavi.logger": "Структурираният дневник на всички останали плъгини.",
  "plugins.catalog.tavi.persistence": "Базата SQLite и папката с данни на Tavi.",
  "plugins.catalog.tavi.tools": "Списъкът с инструменти, които Tavi дава на моделите.",
  "plugins.catalog.tavi.access": "Правилата за достъп до работното пространство и проверката на разрешенията.",
  "plugins.catalog.tavi.clock": "Общият часовник.",
  "plugins.catalog.tavi.router":
    "Доставчикът на маршрутизация Jev (TypeSafe). Маршрутизацията е изключена, докато не я настроиш с `tavi router`.",
  "plugins.catalog.tavi.models": "Връзките с модели (включват се, когато има настроена връзка с модел).",
  "plugins.catalog.tavi.workflow": "Двигателят, който изпълнява задачите (включва се, когато има настроена връзка с модел).",
  "plugins.catalog.tavi.retention": "На всеки шест часа чисти приключилите записи за съобщения (само при tavi serve).",
  "plugins.catalog.tavi.agentwaitscheduler": "Събужда задачите, които чакат отговор от помощник.",
  "plugins.catalog.tavi.schedules": "Пуска повтарящите се графици, които вървят без теб.",
  "plugins.catalog.tavi.ideas":
    "Домакинът на идеите: веднъж на ден, в часовете на работното пространство, търси нови идеи и отговаря на /ideas (само при tavi serve). Изключен, спира ежедневното търсене; опресняването пак работи.",
  "plugins.catalog.tavi.heartbeat":
    "Домакинът на пулса: събужда всеки пулс в активните му часове, пуска евтините проверки преди всяко извикване на модел и пази дневника му (само при tavi serve). Изключен, спира всеки пулс.",
  "plugins.catalog.tavi.heartbeatagent":
    "Вграденият доставчик на пулса: при всяка проверка един кратък ход само за четене на бързия модел, с отчетен разход, който ти казва само това, което докладва (само при tavi serve). Изключен, спира пулсовете, които го ползват.",
  "plugins.catalog.tavi.ideasagent":
    "Вграденият доставчик на идеи: подрежда каталога с идеи според това какво може Tavi тук и какво спомена, а бързият ти модел преформулира подходящите в рамките на дневния бюджет за идеи. Плъгин с „provides: ideas“ може да го замени за отделно работно пространство; изключен, пропуска търсенето за пространствата, които го ползват.",
  "plugins.catalog.tavi.onboarding":
    "Вграденият процес за първи стъпки: стъпките на tavi onboard, tavi setup и посрещането в уеб интерфейса — първо модел, после ти, приложения, канали, търсене, Tavi да работи постоянно и първа идея. Плъгин с „provides: onboarding“ може да го замени; изключен, оставя списъка за настройка с командата за всяка незавършена стъпка.",
  "plugins.catalog.tavi.heartbeatsignals":
    "Вградените източници на сигнали за пулса: какво те чака, какво предстои, неуспешни графици и рутини, канали, които искат внимание, задържани съобщения, съобщения без отговор, неуспешни изпращания, наблюдавани страници и чат папки или диск, които се пълнят (само при tavi serve).",
  "plugins.catalog.tavi.memoryprovider":
    "Вграденият доставчик на памет: подрежда какво паметта припомня за ходовете, инструмента memory.search и проверките на пулса със собствения индекс на Tavi, подготвя предложенията от прегледа при бездействие и от прехвърлянето в края на периода, а седмични предложения за подреждане — когато работното пространство ги включи. Той е резервният вариант за всеки друг доставчик; ако е изключен и няма избран друг, паметта се търси със собственото търсене на Tavi и никой не подготвя предложения.",
  "plugins.catalog.tavi.memory":
    "Домакинът на паметта: командите /remember, /forget, /memory и /why в приложението, терминала и личните чатове и седмичното обобщение за преглед (само при tavi serve). Ако е изключен, ги премахва и спира обобщението, прегледа при бездействие, седмичното подреждане и попълването на векторите; припомнянето, предложенията и премахванията от доставчика продължават да работят.",
  "plugins.catalog.tavi.reminderrule":
    "Добавя веднъж във всяко работно пространство правилото, което разрешава инструментите за напомняния; отменено правило не се връща.",
  "plugins.catalog.tavi.reminders": "Пуска напомнянията навреме, с бутоните им; напомняне само с текст не иска връзка с модел.",
  "plugins.catalog.tavi.tasksummaries":
    "Пише заглавието и обобщението на всяка задача в отделен цикъл, по едно извикване, никога по пътя, който приключва задачата.",
  "plugins.catalog.tavi.localmessaging":
    "Локалната връзка, през която минават чатовете от терминала и уеб интерфейса: основен, защото без него нищо написано там не стига до задача.",
  "plugins.catalog.tavi.channelhost":
    "Отваря запазените връзки на всеки инсталиран канал, вграден или от плъгин, и прилага промените от настройките веднага; всеки канал е отделен плъгин.",
  "plugins.catalog.tavi.telegram": "Каналът Telegram: бот, на който пишеш, свързан с теб.",
  "plugins.catalog.tavi.mailgun": "Имейл каналът през Mailgun: входящи маршрути и изпращане.",
  "plugins.catalog.tavi.gmail": "Каналът Gmail: пощата ти, четена и с чернови, с твое одобрение.",
  "plugins.catalog.tavi.flights":
    "travel.flights_search: търсене на полети през публичния MCP сървър на Kiwi.com, преди браузъра, с връзки към Google Flights и Kayak.",
  "plugins.catalog.tavi.browser":
    "Браузърът на агента и инструментите му browser.*. Изключен, агентът няма браузър от следващото пускане; друг браузър може да се вгради само при сглобяването на Tavi, никога с плъгин.",
  "plugins.catalog.tavi.pdf":
    "Четене и попълване на PDF файлове (инструментите pdf.*), като всеки документ се чете в изолиран процес за еднократна употреба. Изключен, инструментите за PDF не се предлагат от следващото пускане.",
  "plugins.catalog.tavi.video":
    "Разбиране на видеа и гласови съобщения със собствения ти FFmpeg (video.* и audio.transcribe), всяко прочетено в изолирано пускане с ограничения. Изключен, инструментите за видео не се предлагат от следващото пускане, а гласовото съобщение се пази, но не се превръща в текст.",
  "plugins.catalog.tavi.sandbox":
    "Изолираната среда, в която вървят помощните процеси на плъгините, sandbox.run, четенето на PDF и на видео. Основен: не може да се изключи, нито да се замени с плъгин, защото изолира всеки плъгин.",
  "plugins.catalog.tavi.limits":
    "Ограниченията за процесор, памет и време на изолираните пускания. Основен: не може да се изключи, нито да се замени с плъгин.",
  "plugins.catalog.tavi.worker":
    "Процесите, в които вървят одобрените плъгини, през изолираната среда. Основен: не може да се изключи, нито да се замени с плъгин.",
  "plugins.catalog.tavi.siteskills":
    "Какво се знае за сайтове, които агентът често отваря (Google Flights, Kayak, Skyscanner, Booking.com, Google Maps), научено при първото посещение.",
  "plugins.catalog.tavi.collectors":
    "Източниците на ежедневния бюлетин (проекти, GA4, Search Console, разходи за GCP, Stripe, новини) и инструментите му за доклади (reports.generate, reports.history).",
  "plugins.catalog.tavi.desktop":
    "Експериментален, само за macOS: инструменти desktop.*, които виждат и действат в приложенията, разрешени за работното пространство (desktop.grantedApps), като за всяко действие питат, докато си на линия. Изключен, докато не го включиш; помощната му програма се сглобява веднъж на компютъра, на който върви.",
  "plugins.catalog.tavi.guard":
    "Пита преди команди в терминала, които изтриват или презаписват файлове, и казва какво ще засегнат; отказва ги, където никой не може да одобри. Изключен, докато не го включиш.",

  // Вграденият процес за първи стъпки.
  "plugins.onboarding.title": "Добре дошли в Tavi",
  "plugins.onboarding.model.title": "Избери модела, с който мисли Tavi",
  "plugins.onboarding.model.body":
    "На Tavi му трябва един модел, за да ти отговаря. Облачният доставчик иска ключ и таксува на употреба; OpenRouter е един ключ за много модели. Модел на този компютър (Ollama, LM Studio) е безплатен и поверителен, но малките се справят по-слабо с работата на агент.\nКлючът се пази във файла с данни за достъп на Tavi на този компютър, никога в чат.",
  "plugins.onboarding.about.title": "За теб",
  "plugins.onboarding.about.body":
    "Името и часовата ти зона, за да се обръща Tavi към теб и да казва часовете по твоето време. Пазят се в настройките на работното пространство, а при включена памет — като две предпочитания, които можеш да видиш и забравиш.",
  "plugins.onboarding.apps.title": "Свържи приложение",
  "plugins.onboarding.apps.body":
    "Нека Tavi чете пощата или календара ти, за да ти помага с тях. Всяко приложение казва какво чете; всичко, което изпраща или променя нещо, първо те пита.",
  "plugins.onboarding.tasks.title": "Къде държиш задачите си?",
  "plugins.onboarding.tasks.body":
    "Tavi има свой списък със задачи, който работи навсякъде, където го намираш, без настройка. Ако вече държиш задачите си в приложение като Todoist, свържи го и Tavi ще добавя там; нищо не се копира между двата списъка.",
  "plugins.onboarding.channels.title": "Пиши на Tavi от телефона",
  "plugins.onboarding.channels.body": "Пиши на Tavi от чат приложение. Свързваш се с еднократен код; на непознати никога не се отговаря.",
  "plugins.onboarding.voice.title": "Разбирай гласови съобщения",
  "plugins.onboarding.voice.body":
    "Изпрати на Tavi гласово съобщение и то става текст на този компютър: нищо от казаното не излиза оттук. Трябват FFmpeg и whisper.cpp, които Homebrew инсталира от твоя потребител (никога със sudo), и базовият говорен модел на Whisper (около 148 МБ, лиценз MIT) от Hugging Face, запазен само ако контролната сума съвпада.",
  "plugins.onboarding.search.title": "Търсене в мрежата",
  "plugins.onboarding.search.body":
    "Доставчикът на търсене позволява на Tavi да проверява неща. Повечето искат собствен ключ; Tavily може да започне и без, а на SearXNG му трябва само адресът.",
  "plugins.onboarding.service.title": "Tavi да работи постоянно",
  "plugins.onboarding.service.body":
    "Каналите, напомнянията и графиците работят само докато върви tavi serve. Tavi може да го пуска с компютъра, от твоя потребител, никога със sudo.",
  "plugins.onboarding.ideas.title": "Опитай нещо",
  "plugins.onboarding.ideas.body":
    "Първо нещо, което да попиташ, според това какво може Tavi тук сега. Нищо не се изпраща, докато не го изпратиш.",
  "plugins.onboarding.ideas.week.label": "Планирай седмицата ми",
  "plugins.onboarding.ideas.week.prompt": "Помогни ми да планирам седмицата си: попитай ме какво имам, после предложи прост график.",
  "plugins.onboarding.ideas.research.label": "Проучи тема",
  "plugins.onboarding.ideas.research.prompt": "Проучи тема за мен и ми дай кратко обобщение с източници. Първо ме попитай коя тема.",
  "plugins.onboarding.ideas.remind.label": "Напомни ми по-късно",
  "plugins.onboarding.ideas.remind.prompt": "Напомни ми утре в 9:00 да проверя какво те попитах днес.",
  "plugins.onboarding.done.title": "Готово, можеш да започваш",
  "plugins.onboarding.done.body": "Питай Tavi каквото искаш. Пропуснатите стъпки остават в списъка на „Начало“ и в tavi onboard.",

  // Думите за настройка на Telegram.
  "plugins.telegram.app.summary": "Пиши на Tavi от Telegram през бот, който създаваш.",
  "plugins.telegram.description": "Пиши на агента през бот в Telegram.",
  "plugins.telegram.token.label": "Токен на бота",
  "plugins.telegram.token.help": "От @BotFather: /newbot, после копирай токена, който ти дава.",
  "plugins.telegram.sender.label": "Потребителски ID в Telegram",
  "plugins.telegram.target.label": "ID на чата",
  "plugins.telegram.target.help":
    "За да пишеш на някого директно, въведи потребителския му ID в Telegram: ID на личния чат е този на потребителя. ID на група е отрицателно число. Човекът трябва първо да е писал на бота.",
  "plugins.telegram.pairing.open": "Отвори в Telegram",
  "plugins.telegram.setupHelp":
    "Създай бот с @BotFather: изпрати му /newbot, избери име и потребителско име, завършващо на bot, и постави токена, с който отговаря. После се свържи с еднократен код.",
  "plugins.telegram.setupLink": "Отвори @BotFather",

  // Думите за настройка на Gmail: акаунтът в Google в свързаните приложения.
  "plugins.gmail.description":
    "Пиши на агента през собствения си акаунт в Gmail: чете само писмата с твой етикет и отговаря от твоя адрес.",
  "plugins.gmail.label.label": "Етикет за четене",
  "plugins.gmail.label.help":
    "До агента стигат само писмата с този етикет в Gmail; слагай го с филтър (например за писма до you+tavi@gmail.com). Всяко прочетено писмо получава етикета <label>-processed.",
  "plugins.gmail.receive.label": "Пиши на Tavi по имейл",
  "plugins.gmail.receive.help":
    "Приема писмата с етикета и отговаря от твоя адрес. Ако е изключено, акаунтът дава само инструментите за пощата и календара.",
  "plugins.gmail.address": "Имейл адрес",
  "plugins.gmail.app.summary": "Акаунтът ти в Google: календарът и Gmail, всеки включен от теб, и Tavi, достъпен по имейл.",
  "plugins.gmail.scope.email": "Вижда имейл адреса на акаунта ти в Google",
  "plugins.gmail.scope.mail": "Чете пощата ти и слага етикети, пише чернови и изпраща от твое име (само докато Gmail е включен)",
  "plugins.gmail.scope.calendar": "Вижда календарите и свободното ти време и добавя или променя събития (само докато календарът е включен)",
  "plugins.gmail.setupHelp":
    "Настрой Google веднъж от Настройки → Свързани приложения (Настрой Google): собствен проект в Google Cloud с включени Gmail и Calendar API, публикуван екран за съгласие и OAuth клиент от тип Desktop app, чийто изтеглен JSON пускаш там; или въведи тук неговия client ID и тайна. Другите ти приложения от Google ползват същия клиент. Приложение, оставено в режим Testing, остава с вход за по 7 дни. Писмата през този канал излизат от твое име, от твоя адрес, в папката ти с изпратени.",

  // Думите за настройка на Mailgun.
  "plugins.mailgun.app.name": "Имейл (Mailgun)",
  "plugins.mailgun.app.summary": "Пиши на Tavi по имейл на домейн, от който изпращаш през Mailgun.",
  "plugins.mailgun.label": "Имейл",
  "plugins.mailgun.description": "Пиши на агента по имейл през домейн и входящ маршрут в Mailgun.",
  "plugins.mailgun.domain.label": "Домейн за изпращане",
  "plugins.mailgun.from.label": "Адрес на подателя",
  "plugins.mailgun.from.help": "Адрес на домейна за изпращане; tavi@<domain>, ако е празно.",
  "plugins.mailgun.region.label": "Регион",
  "plugins.mailgun.region.help":
    "Регионът, в който е създаден домейнът, както го показва Mailgun → Domains: eu се достига на api.eu.mailgun.net.",
  "plugins.mailgun.apiKey.label": "API ключ",
  "plugins.mailgun.apiKey.help": "Mailgun → API Security → ключ за изпращане за този домейн.",
  "plugins.mailgun.signingKey.label": "Ключ за подписване на уебхукове",
  "plugins.mailgun.signingKey.help": "Mailgun → Webhooks → HTTP webhook signing key: отделна тайна от API ключа.",
  "plugins.mailgun.address": "Имейл адрес",
  "plugins.mailgun.setupHelp":
    "Добави входящ маршрут в Mailgun, който препраща към адреса за уебхукове на тази връзка (зад твоя обратен прокси с https), и разреши адреса на всеки подател в „Разрешени хора“.",

  // Пазачът: какво казва куката му и защо пита, както го казва картата за одобрение.
  "plugins.guard.disclosure": "Пита преди команда в терминала, която изтрива или презаписва файлове, и казва какво ще засегне.",
  "plugins.guard.reason": "Тази команда {does}.",
  "plugins.guard.reasonPaths": "Тази команда {does}: {paths}.",
  "plugins.guard.does.overwrite": "презаписва файл",
  "plugins.guard.does.dropDatabase": "изтрива обекти от база данни",
  "plugins.guard.does.removeRecursive": "изтрива файлове и папки заедно със съдържанието им",
  "plugins.guard.does.openToEveryone": "отваря всеки файл за всички",
  "plugins.guard.does.overwriteDevice": "презаписва файл или устройство",
  "plugins.guard.does.format": "форматира диск",
  "plugins.guard.does.findDelete": "изтрива файловете, които намери",
  "plugins.guard.does.truncate": "скъсява файлове",
  "plugins.guard.does.gitReset": "изхвърля незапазената в git работа",
  "plugins.guard.does.gitClean": "изтрива файловете, които git не следи",

  // Картата за одобрение на търсенето на полети.
  "plugins.flights.approval.title": "Търси полети {from} → {to}",
  "plugins.flights.approval.detail":
    "Изпраща пътуването (места, дати, пътници) на търсачката за полети на Kiwi.com и на Google Flights, ако е включен",
  "plugins.flights.approval.reason": "изпраща пътуването на търсачката за полети на Kiwi.com и на Google Flights",

  // PDF файлът на ежедневния бюлетин: рамката му.
  "plugins.collectors.brief.title": "Ежедневен бюлетин",
  "plugins.collectors.brief.heading": "Ежедневен бюлетин — всички проекти",
  "plugins.collectors.brief.meta": {
    one: "Период {start} → {end} · създаден {generatedAt} · {count} проект",
    other: "Период {start} → {end} · създаден {generatedAt} · {count} проекта",
  },
  "plugins.collectors.brief.crossProject": "Всички проекти",
  "plugins.collectors.brief.sessions": "Посещения",
  "plugins.collectors.brief.mrr": "Месечни абонаментни приходи (MRR)",
  "plugins.collectors.brief.revenue": "Платени приходи",
  "plugins.collectors.brief.metric": "Показател",
  "plugins.collectors.brief.source": "Източник",
  "plugins.collectors.brief.value": "Стойност",
  "plugins.collectors.brief.news": "Новини",
  "plugins.collectors.brief.noNews": "Няма новини, които да съвпадат с ключовите думи на проекта.",
  "plugins.collectors.brief.noMetrics": "За този проект не бяха събрани показатели.",
  "plugins.collectors.brief.dataQuality": "Качество на данните",
} as const satisfies CatalogFor<typeof en>;
