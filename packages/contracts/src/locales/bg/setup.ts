import type { CatalogFor } from "../../i18n.js";

import type { setup as en } from "../en/setup.js";

/** The `core` words for onboarding's narration (`tavi onboard`, `tavi setup`), in Bulgarian: the server's alone (its refusals and sign-in errors, and the workspace settings' refusals, which the canvas shows too, are in `onboarding` and `errors`). */
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
  // ---------------------------------------------------------------- the heartbeat's first-run offer: a built-in source's line, as the person would write it
  "heartbeat.offer.needs": "Одобрения или въпроси, чакащи над час",
  "heartbeat.offer.agenda": "Напомняния и събития през следващите 2 часа",
  "heartbeat.offer.schedules": "Пускания по график, които се провалят",
  "heartbeat.offer.held": "Съобщения, задържани за моя преглед",
  "heartbeat.offer.messages": "Съобщения, които чакат отговор над час",
  "heartbeat.offer.sends": "Съобщения, които се връщат или не тръгват",
  "heartbeat.offer.routines": "Рутини, които се провалят",
  "heartbeat.offer.apps": "Приложения, които искат нов вход",
} as const satisfies CatalogFor<typeof en>;
