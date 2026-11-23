import type { CatalogFor } from "../../i18n.js";

import type { setup as en } from "../en/setup.js";

/** The `core` words for onboarding's narration, refusals and sign-in errors, and the workspace settings' refusals, in Bulgarian. */
export const setup = {
  // ---------------------------------------------------------------- onboarding's narration (`tavi onboard`, `tavi setup`)
  "onboard.say.checkingModel": "Проверявам {model} с една кратка заявка…",
  "onboard.say.mainReady": "Моделът е готов: {model}",
  "onboard.say.fastReady": "Бързият модел е готов: {model}",
  "onboard.say.withAdvice": "{line} — {advice}",
  "onboard.say.mainFailed": "Моделът {model} не отговори: {why}",
  "onboard.say.fastFailed": "Бързият модел {model} не отговори: {why}",
  "onboard.say.unknown": "неясна причина",
  "onboard.say.chatGptSigningIn":
    "Влизам с ChatGPT в браузъра ти. Ползва лимита на плана ти в ChatGPT; ChatGPT Settings → Usage го показва и ограничава.",
  "onboard.say.chatGptSignedIn": { one: "Влизането с ChatGPT е готово ({n} модел)", other: "Влизането с ChatGPT е готово ({n} модела)" },
  "onboard.say.previousDefault": "Предишният ти модел остава основен.",
  "onboard.say.notCheckedNow": "Сега не успях да го проверя: {why}",
  "onboard.say.noAnswer": "няма отговор",
  "onboard.say.answered": "{name} отговори",
  "onboard.say.unexpected": "Не отговори както очаквах",
  "onboard.say.needsModel": "Tavi има нужда от един модел, за да ти отговаря.",
  "onboard.say.besideIt":
    "Вече има връзка или ключ с име {id} (в употреба или добавени извън настройката), затова тази се добавя до тях като {connection}; настройката никога не променя нещо, което не е създала.",
  "onboard.say.cannotList": "{provider} не успя да изреди моделите си: {why}",
  "onboard.say.elsewhere": "{title} — тази стъпка се прави в tavi ui или сега с: {command}",
  "onboard.say.setup": "Настройка",
  "onboard.say.setupLeft": "Настройка — какво остава",
  "onboard.say.stopped": "\nСпрях. Настроеното досега се пази; `tavi onboard` продължава оттук.",
  "onboard.say.memoryRefused": "Паметта не ги прие ({why}); запазени са в настройките на работното пространство.",
  "onboard.say.willRemember": "Tavi ще запомни: {facts} (tavi memory list ги показва; tavi memory forget ги премахва).",
  "onboard.say.yourName": "името ти е {name}",
  "onboard.say.yourZone": "часовата ти зона е {zone}",
  "onboard.say.aboutSaved": "Данните за теб са запазени",
  "onboard.say.todoistBrowser": "Влизането в Todoist е през браузъра: свържи го на страницата за добре дошли в tavi ui или с",
  "onboard.say.todosTavi": "Задачи: собственият списък на Tavi (tavi todos го показва)",
  "onboard.say.todosApp":
    "Задачите отиват в {app}. Собственият списък на Tavi пази само неговите задачи за проследяване; нищо не се синхронизира (tavi todos export или поискай в чат да ги премести).",
  "onboard.say.sendCode": "Изпрати {code} на {to}{chat} до 10 минути (или `/link {code}`{link}). Чакам…",
  "onboard.say.taviOn": "Tavi в {channel}",
  "onboard.say.open": "отвори",
  "onboard.say.paired": "Сдвояването е готово: съобщенията ти от този чат стигат до Tavi. На непознати никога не се отговаря.",
  "onboard.say.notPaired": "Няма сдвояване. На ничии други съобщения не се отговаря.",
  "onboard.say.channelsNeedOwner":
    "Канали — сдвояването иска работещ сървър на Tavi: пусни `tavi serve` в друг терминал, после пусни пак `tavi onboard`.",
  "onboard.say.noChannel": "{title} — нито един от каналите, които тази настройка предлага, не е инсталиран тук.",
  "onboard.say.addChannel": "{title} — {commands}, после се сдвои в {path}.",
  "onboard.say.or": " или ",
  "onboard.say.channelConnected": "{label}: връзката е готова",
  "onboard.say.channelConnectedDetail": "{label}: връзката е готова: {detail}",
  "onboard.say.serviceWindows":
    "Постоянна работа — tavi serve още не работи под Windows: дръж сървъра на Tavi пуснат под WSL2. `tavi service unit --kind task` записва задачата при вход за момента, когато заработи (docs/WINDOWS.md).",
  "onboard.say.serviceOther": "Постоянна работа — услуга има само за macOS, Linux и Windows.",
  "onboard.say.serviceWsl1": "Постоянна работа — {why}",
  "onboard.say.wsl1":
    "WSL1 не се поддържа: няма пространства от имена на ядрото на Linux, затова изолираната среда не може да работи. Премести дистрибуцията на WSL2 (wsl --set-version <distro> 2).",
  "onboard.say.wslKeepRunning":
    "WSL спира тази дистрибуция, а с нея и tavi serve, скоро след като се затвори последният ѝ терминал. В %USERPROFILE%\\.wslconfig под Windows задай vmIdleTimeout=-1 в [wsl2] и instanceIdleTimeout=-1 в [general] (WSL 2.5 или по-нов), после пусни веднъж wsl --shutdown.",
  "onboard.say.removed": "Премахнато. Пускай `tavi serve` ти, когато искаш канали и графици.",
  "onboard.say.runYourself": "Пускаш го ти",
  "onboard.say.unitExists":
    "{path} вече съществува и не е записан от тази настройка. Оставям го както е: избери „{option}“ или първо го премахни.",
  "onboard.say.wrote": "Записах {path}",
  "onboard.say.stopServeFirst": "Първо спри този tavi serve (Ctrl-C в терминала му), после пусни:\n  {load}",
  "onboard.say.lingerNote": "\n  {command}   (за да продължи да работи, след като излезеш от системата)",
  "onboard.say.startLater": "Пусни го по-късно с:\n  {load}",
  "onboard.say.commandFailed": "{command} не успя: {output}",
  "onboard.say.lingerTail": ". За да продължи да работи, след като излезеш от системата: {command}",
  "onboard.say.started": "Пусната{linger}",
  "onboard.say.runningService": "Работи като услуга{linger}",
  "onboard.say.notService":
    "Сървърът на Tavi отговаря, но не като услугата: друг tavi serve държи тази папка с данни. Спри го и услугата ще поеме.",
  "onboard.say.noOwnerAnswered": "Услугата е пусната, но сървърът на Tavi не отговори до 10 секунди. Дневникът ѝ казва защо: {log}",
  "onboard.say.voiceUnavailable": "Гласови съобщения — {detail}",
  "onboard.say.voiceNeedsOwner":
    "Гласови съобщения — настройва ги работещият сървър на Tavi: пусни tavi serve, после tavi setup voice (или на ръка: brew install whisper-cpp ffmpeg)",
  "onboard.say.voiceReady": "Гласови съобщения: превеждат се в текст на този компютър",
  "onboard.say.runThese": "Пусни тези команди, после пак tavi setup voice:",
  "onboard.say.voiceStill": "Гласови съобщения — още се настройват на сървъра на Tavi; tavi doctor казва кога са готови",
  "onboard.say.voiceFailed": "Гласовите съобщения не се настроиха: {why}",
  "onboard.say.stillMissing": "още липсва: {missing}",
  "onboard.say.byHand": "За да ги настроиш на ръка:",
  "onboard.say.searchOn": "Търсене в мрежата: {kind}",
  "onboard.say.searchAllowed":
    "Търсенията отиват към {kind} без питане; заявка, която прилича на ключ или токен, пак пита първо, както и чат, прочел уеб страница или имейл, преди търсене, което може да изнесе лични данни.",
  "onboard.say.searchAsk":
    "За да те питам преди всяко търсене: tavi permissions rm {rule} (или го премахни в {path}). За да спра да търся: tavi search disable {kind}.",
  "onboard.say.searchFailed": "{kind} не се добави: {why}",
  "onboard.say.ideasSoon": "Личните идеи ще са в `tavi ideas` след минута.",
  "onboard.say.ideasLater": "Личните идеи започват, щом `tavi serve` работи; `tavi ideas` ги показва.",
  "onboard.say.providedBy": "Осигурява го {provider}: първият ход с отговор го проверява.",

  // ---------------------------------------------------------------- onboarding's refusals (the `onboarding` command)
  "onboard.refuse.canvasProvider":
    "Уеб интерфейсът не може да смени кой процес за първи стъпки се ползва; използвай tavi onboard provider в терминал",
  "onboard.refuse.noFlow": "няма инсталиран процес за първи стъпки {id}; инсталирани: {installed}",
  "onboard.refuse.none": "няма",
  "onboard.refuse.noOperator": "никой собственик не работи в работното пространство {workspace}",
  "onboard.refuse.modelSkip": "Стъпката за модела не може да се пропусне: Tavi има нужда от модел, за да отговаря",
  "onboard.refuse.notMarked": "стъпката {step} е готова, когато настройките ѝ го кажат, а не когато се отбележи",
  "onboard.refuse.canvasReset": "Уеб интерфейсът не може да нулира първите стъпки; използвай tavi onboard reset в терминал",
  "onboard.refuse.noDetection": "откриването не е налично тук",
  "onboard.refuse.noConnect": "свързването на доставчик не е налично тук",
  "onboard.refuse.unknownProvider": "{preset} не е доставчик, който Tavi познава",
  "onboard.refuse.needsEndpoint": "{provider} има нужда от адреса си",
  "onboard.refuse.endpointFixed": "Адресът на {provider} е фиксиран",
  "onboard.refuse.badEndpoint": "Въведи HTTP(S) адрес без данни за достъп, заявка и фрагмент",
  "onboard.refuse.chatGptPreview":
    "Влизането с ChatGPT е в предварителен преглед: за да се предлага, задай за tavi и tavi serve {variable}=1",
  "onboard.refuse.chatGptUnavailable": "Влизането с ChatGPT не е налично тук",
  "onboard.refuse.chatGptEncrypted":
    "Влизане с ChatGPT се пази само в шифровано хранилище за данни за достъп: пусни tavi credentials encrypt, после влез пак",
  "onboard.refuse.notChatGpt": "това не е влизане с ChatGPT",
  "onboard.refuse.noSignIn": "влизането не е налично тук",
  "onboard.refuse.openRouterOrigin": "Влизането с OpenRouter се връща в tavi ui: трябва му адресът му",
  "onboard.refuse.loopback": "влизането се връща в tavi ui на този компютър: локален http адрес",
  "onboard.refuse.noOpenRouter": "OpenRouter не е доставчик тук",
  "onboard.refuse.noConnectDetected": "свързването на открит доставчик не е налично тук",
  "onboard.refuse.notDetectable": "{preset} не е доставчик, който Tavi може да свърже от откритото",
  "onboard.refuse.notKeyFor": "{variable} не е ключ за {provider}; използвай някоя от: {allowed}",
  "onboard.refuse.notSet": "{variable} не е зададена там, където върви тази настройка",
  "onboard.refuse.needsKey": "{provider} иска ключ: посочи променливата, в която е",
  "onboard.refuse.notRunning": "{provider} не работи на този компютър",
  "onboard.refuse.noVerify": "проверката на модел не е налична тук",
  "onboard.refuse.noConnection": "Няма връзка {connection}",
  "onboard.refuse.noModel": "Още няма настроен модел: първо добави такъв",
  "onboard.refuse.noMainApart": "Няма основен модел, отделен от основния",
  "onboard.refuse.noFastApart": "Няма бърз модел, отделен от основния",
  "onboard.refuse.verifyMainSoon": "Основният модел беше проверен току-що; изчакай няколко секунди",
  "onboard.refuse.verifyFastSoon": "Бързият модел беше проверен току-що; изчакай няколко секунди",

  // ---------------------------------------------------------------- sign-in errors (ChatGPT, OpenRouter)
  "onboard.signIn.chatGptRefused": "ChatGPT отказа влизането ({why}). Започни отначало.",
  "onboard.signIn.notTokenSet": "Отговорът на ChatGPT не съдържа токени",
  "onboard.signIn.otherAccount": "Това е друг акаунт в ChatGPT: влез с този, който ползва връзката, или добави друга връзка.",
  "onboard.signIn.planScope":
    "Ползването на плана в ChatGPT не беше разрешено, затова Tavi не може да отговаря с него. Влез пак и го разреши или използвай API ключ.",
  "onboard.signIn.unreachable": "Не успях да се свържа с ChatGPT, за да подновя влизането: {why}",
  "onboard.signIn.invalidClient":
    "ChatGPT вече не приема регистрацията на тази инсталация (invalid_client). Влез пак с ChatGPT, за да я регистрираш наново: tavi setup model.",
  "onboard.signIn.ended": "Влизането с ChatGPT е изтекло. Влез пак с ChatGPT: tavi setup model.",
  "onboard.signIn.cannotRenew": "ChatGPT не поднови влизането ({code})",
  "onboard.signIn.renewedOther": "ChatGPT поднови влизането за друг акаунт. Влез пак с ChatGPT.",
  "onboard.signIn.chatGptStopped": "Влизането с ChatGPT беше спряно",
  "onboard.signIn.chatGptDenied": "Не разреши на Tavi да ползва ChatGPT. Нищо не е свързано.",
  "onboard.signIn.chatGptNotSignedIn": "ChatGPT не те пусна да влезеш. Нищо не е свързано.",
  "onboard.signIn.noCode": "ChatGPT не изпрати код за влизане. Започни отначало.",
  "onboard.signIn.otherRegistration": "ChatGPT отговори за друга регистрация. Нищо не е променено.",
  "onboard.signIn.notRegistered": "ChatGPT не довърши регистрацията на Tavi. Започни отначало.",
  "onboard.signIn.chatGptTooLong": "Влизането с ChatGPT отне твърде дълго. Започни отначало.",
  "onboard.signIn.endedBefore": "Влизането с ChatGPT приключи, преди да започне",
  "onboard.signIn.noKeyIssued": "OpenRouter не издаде ключ (HTTP {status}); влез пак или постави ключ",
  "onboard.signIn.noKey": "OpenRouter отговори без ключ; влез пак или постави ключ",
  "onboard.signIn.timedOut": "Времето за влизане изтече",
  "onboard.signIn.cancelled": "Влизането беше отменено",
  "onboard.signIn.accessDenied": "Не разреши достъп. Нищо не е свързано.",
  "onboard.signIn.openRouterNotSignedIn": "OpenRouter не те пусна да влезеш. Нищо не е свързано.",

  // ---------------------------------------------------------------- workspace settings' refusals (`tavi config set`, Settings)
  "error.settings.unknownWorkspace": "работното пространство {workspace} не е настроено на този сървър на Tavi",
  "error.settings.taintLower": "страницата може само да вдигне security.taint; свали го с `tavi permissions taint {mode}`",
  "error.settings.conflict":
    "Настройките на работното пространство {workspace} са променени, откакто бяха прочетени (очаквана версия {expected}, текуща версия {current})",
  "error.settings.providerVerbs":
    "Доставчикът на памет и какво му се изпраща се сменят само с tavi memory set-provider и tavi memory egress (или „Доставчик“ в командния център), които първо казват какво изпращат",
  "error.settings.personalNeedsHybrid":
    "Личната памет се превръща в ембединги само при хибридно припомняне: tavi memory config retrieval hybrid --include-personal",
  "error.settings.hybridUnchecked":
    "Тук не мога да проверя хибридното припомняне: включи го от командния център или с `tavi memory config retrieval hybrid`",
  "error.settings.needsEmbedding":
    "Хибридното припомняне иска модел за ембединги: задай такъв с `tavi models set-role embedding --connection <id> --model <id>`, после включи хибридното",
  "error.settings.confirmHybrid": "{disclosure} — потвърди, за да включа хибридното припомняне.",
  "error.settings.confirmIt": "{disclosure} — потвърди, за да го включа.",
  "error.settings.disclosures": "{first} {second}",
  "error.settings.homeDmOff":
    "chat.home-dm свързва личните ти разговори с „Начало“, което е изключено в това работно пространство: първо включи chat.home",
  "error.settings.notSender":
    "{identity} не е идентификатор на подател във връзка на чат канал, позната на тази папка с данни; използвай <connection>:<sender id>, например my-chat:123456789, с връзка, запазена в настройките, или такава, от която човекът е писал",
  "error.settings.timezone": "{value} не е часова зона по IANA; използвай име като Europe/Berlin или America/New_York",
  "error.settings.operatorName": "operator.name приема един ред с до {max} знака, например „Робин“",
  "error.settings.locale": "{value} не е език, който Tavi говори; използвай някой от: {locales}",
  "error.settings.onOff": "{value} не е on или off",
  "error.settings.homeDm":
    "{value} не е идентичност за личен разговор; използвай <connection>:<sender id>, например my-chat:123456789 (списък, разделен със запетаи), или off",
  "error.settings.desktopApps":
    "{value} не е приложение; използвай списък с идентификатори или имена на приложения, разделени със запетаи, например {example}, или none",
  "error.settings.thumbnailHosts": "{value} не е хост или *.домейн; използвай списък, разделен със запетаи, например {example}, или none",
  "error.settings.jsonObject": "{key} приема JSON обект, например {example}",
  "error.settings.notValid": "{key} не е валиден: {where}{issue}",
  "error.settings.unknownProblem": "неясен проблем",
  "error.settings.taint": "{value} не е режим за следене на съдържанието; използвай off, observe или enforce",
  "error.settings.injection": "{value} не е режим за откриване на инжекции; използвай off, patterns или model",
  "error.settings.sandboxNetwork": "{value} не е мрежов режим на изолираната среда; използвай granted или ask",
  "error.settings.mcpIds":
    "{value} не е списък с идентификатори на MCP сървъри; използвай списък, разделен със запетаи, например mcp.docs,mcp.home, или none",
  "error.settings.sandboxDomain":
    "{value} не е домейн, до който sandbox.run може да стигне; използвай списък, разделен със запетаи, например {example} (или @registries), или none",
  "error.settings.sandboxMax": "sandbox.domains побира най-много {max} домейна",
  "error.settings.wholeNumber": "{value} не е цяло число от {min} до {max}",
  "error.settings.videoDays": "{value} не е брой дни от 1 до {max}",
  "error.settings.vision": "{value} не е механизъм за зрение: {engines}",
  "error.settings.deferral": "{value} не е начин за отлагане на инструменти: {deferrals}",
  "error.settings.tasksHome": "{value} не е място за задачите: tavi или mcp:<server> (например mcp:todoist)",
  "error.settings.promptLayout": "{value} не е подредба на инструкциите: {layouts}",
  "error.settings.keptRequests": "{value} не е брой от 0 до {max}",
  "error.settings.maxTokens": "{value} не е брой токени от {min} до {max}",
  "error.settings.budget": "{value} не е брой токени от {min} до {max}; махни стойността, за да няма лимит",
  "error.settings.modelTarget": "{value} не е <connection>/<model>, например openrouter/openai/gpt-4.1-mini",
  "error.settings.or": "{first} или {second}",
} as const satisfies CatalogFor<typeof en>;
