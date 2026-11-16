import { protectedFieldClass } from "./protected-fields.js";

/**
 * What a press commits, read the same way when
 * an action's card is drawn and again in the browser on the element it is
 * about to press: a control that pays, books, orders, sends, posts, registers,
 * authorizes, accepts or deletes across the protected-field languages;
 * "Apply" only where it submits a form (on job sites it mostly opens one, and
 * "Check all that apply" and "Apply filters" never commit); and a stage
 * profile's final step, which is refused, never asked.
 */

export const COMMIT_CATEGORIES = ["pay", "send", "account", "legal", "destructive"] as const;
export type CommitCategory = (typeof COMMIT_CATEGORIES)[number];

/** A pattern of whole words, read as Unicode: `\b` treats non-ASCII letters as boundaries. */
const words = (alternation: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "iu");

export const COMMIT_CATEGORY_SOURCES: Readonly<Record<CommitCategory, string>> = {
  pay: [
    "pay|buy|purchase|book|reserve|order|checkout|check\\s+out|place|donate|transfer",
    "bezahlen|zahlen|kaufen|buchen|reservieren|bestellen|zur\\s+kasse|spenden|überweisen",
    "payer|acheter|réserver|commander|passer(?:\\s+la)?\\s+commande|faire\\s+un\\s+don|transférer|virer",
    "pagar|comprar|reservar|pedir|realizar(?:\\s+el)?\\s+pedido|finalizar(?:\\s+la)?\\s+compra|donar|transferir",
    "betalen|kopen|boeken|reserveren|bestellen|afrekenen|doneren|overmaken",
    "betala|köp|köpa|boka|reservera|beställ|beställa|till\\s+kassan|donera|överföra",
    "paga|pagare|acquista|acquistare|acquisto|compra|comprare|prenota|prenotare|ordina|ordinare|vai\\s+alla\\s+cassa|dona|donare|trasferisci|trasferire",
    "encomendar|finalizar(?:\\s+a)?\\s+compra|doar",
    "zapłać|kup|kupić|zarezerwuj|rezerwuj|zamów|zamówić|przekaż\\s+darowiznę|przelej",
    "плати|плащане|купи|резервирай|поръчай|дари|преведи",
  ].join("|"),
  send: [
    "submit|send|post|publish|reply|confirm",
    "absenden|abschicken|senden|einreichen|veröffentlichen|posten|antworten|bestätigen",
    "envoyer|soumettre|publier|poster|répondre|confirmer|valider",
    "enviar|publicar|responder|confirmar",
    "verzenden|versturen|indienen|plaatsen|publiceren|beantwoorden|reageren|bevestigen",
    "skicka(?:\\s+in)?|publicera|posta|svara|bekräfta",
    "invia|inviare|pubblica|pubblicare|rispondi|rispondere|conferma|confermare",
    "submeter",
    "wyślij|prześlij|opublikuj|odpowiedz|potwierdź",
    "изпрати|публикувай|отговори|потвърди",
  ].join("|"),
  account: [
    "subscribe|sign\\s+up|register|enroll|enrol|authorize|authorise|allow",
    "abonnieren|registrieren|einschreiben|autorisieren|erlauben|zulassen",
    "s['’]abonner|abonner|s['’]inscrire|inscrire|autoriser|permettre",
    "suscribirse|suscribir|registrarse|registrar|inscribirse|inscribir|autorizar|permitir",
    "abonneren|inschrijven|registreren|autoriseren|toestaan",
    "prenumerera|registrera|anmäla|auktorisera|tillåt|tillåta",
    "abbonati|abbonarsi|iscriviti|iscriversi|registrati|registrarsi|autorizza|autorizzare|consenti|consentire",
    "subscrever|assinar|registar|inscrever(?:-se)?",
    "subskrybuj|zarejestruj(?:\\s+się)?|zapisz\\s+się|autoryzuj|zezwól",
    "абонирай(?:\\s+се)?|регистрирай(?:\\s+се)?|запиши(?:\\s+се)?|разреши",
  ].join("|"),
  legal: [
    "accept|agree|approve",
    "akzeptieren|zustimmen|annehmen|genehmigen|einwilligen",
    "accepter|approuver|consentir",
    "aceptar|aprobar",
    "accepteren|akkoord(?:\\s+gaan)?|goedkeuren|instemmen",
    "acceptera|godkänn|godkänna|samtycka",
    "accetta|accettare|approva|approvare|acconsenti|acconsentire",
    "aceitar|concordar|aprovar",
    "akceptuj|zaakceptuj|zgadzam\\s+się|zatwierdź",
    "приеми|приемам|одобри|съгласен\\s+съм",
  ].join("|"),
  destructive: [
    "delete|remove|cancel\\s+(?:my\\s+|your\\s+|the\\s+|this\\s+|an?\\s+)?(?:booking|reservation|order|subscription|account|membership|plan|application)",
    "löschen|entfernen|(?:buchung|reservierung|bestellung|abonnement|abo|konto|mitgliedschaft)\\s+(?:stornieren|kündigen)|(?:stornieren|kündigen)\\s+(?:sie\\s+)?(?:ihre[n]?\\s+|meine[n]?\\s+|die\\s+|das\\s+)?(?:buchung|reservierung|bestellung|abonnement|abo|konto|mitgliedschaft)",
    "supprimer|retirer|effacer|annuler\\s+(?:ma\\s+|votre\\s+|la\\s+|le\\s+|mon\\s+|l['’])?(?:réservation|commande|abonnement|compte|adhésion)|résilier(?:\\s+(?:mon\\s+|votre\\s+|l['’])?(?:abonnement|compte))?",
    "eliminar|borrar|quitar|cancelar\\s+(?:mi\\s+|su\\s+|tu\\s+|la\\s+|el\\s+)?(?:reserva|pedido|suscripción|cuenta|membresía)|darse\\s+de\\s+baja",
    "verwijderen|wissen|(?:boeking|reservering|bestelling|abonnement|account|lidmaatschap)\\s+(?:annuleren|opzeggen)|(?:annuleren|annuleer|opzeggen)\\s+(?:mijn\\s+|uw\\s+|je\\s+|de\\s+|het\\s+)?(?:boeking|reservering|bestelling|abonnement|account|lidmaatschap)",
    "ta\\s+bort|radera|avboka|avsluta\\s+(?:min\\s+|din\\s+|mitt\\s+|ditt\\s+)?(?:prenumeration|konto|medlemskap|bokning|beställning)",
    "elimina|eliminare|rimuovi|rimuovere|cancella\\s+(?:la\\s+|il\\s+|mia\\s+|tua\\s+|sua\\s+|l['’])?(?:prenotazione|ordine|abbonamento|account|iscrizione)|annulla(?:re)?\\s+(?:la\\s+|il\\s+|mia\\s+|tua\\s+|sua\\s+|l['’])?(?:prenotazione|ordine|abbonamento|account|iscrizione)|disdici|disdire",
    "excluir|remover|apagar|cancelar\\s+(?:a\\s+|o\\s+|minha\\s+|sua\\s+|tua\\s+)?(?:reserva|encomenda|pedido|assinatura|subscrição|conta)",
    "usuń|usunąć|skasuj|anuluj\\s+(?:rezerwację|zamówienie|subskrypcję|konto)|zamknij\\s+konto",
    "изтрий|премахни|отмени\\s+(?:резервация(?:та)?|поръчка(?:та)?|абонамент(?:а)?)|закрий\\s+профил",
  ].join("|"),
};

const COMMIT_CATEGORY_PATTERNS: readonly (readonly [CommitCategory, RegExp])[] = COMMIT_CATEGORIES.map(
  (category) => [category, words(COMMIT_CATEGORY_SOURCES[category])] as const,
);

export const COMMITTING_LABEL_SOURCE = COMMIT_CATEGORIES.map((category) => COMMIT_CATEGORY_SOURCES[category]).join("|");

/** Labels of controls that pay, book, order, send, post, register, authorize, accept or delete. */
export const COMMITTING_LABEL = words(COMMITTING_LABEL_SOURCE);

/** A whole label that applies: committing only on a control that submits a form. */
export const APPLY_LABEL =
  /^\s*(apply(\s+now)?|(submit|send)(\s+(my|your))?\s+application|bewerben|jetzt\s+bewerben|postuler|solicitar|solliciteren|ansök(\s+nu)?|ansöka|candidati|candidarsi|candidatar(?:-se)?|aplikuj|кандидатствай)\s*$/iu;

/** Extra verbs refused on `assist-only` sites (sign in, log in, apply, save, with translations). */
export const ASSIST_ONLY_EXTRA_SOURCE = [
  "sign\\s+in|log\\s+in|login|apply|save",
  "anmelden|einloggen|bewerben|speichern|sichern",
  "se\\s+connecter|connexion|postuler|enregistrer|sauvegarder",
  "iniciar\\s+sesión|conectarse|solicitar|guardar",
  "inloggen|aanmelden|solliciteren|opslaan|bewaren",
  "logga\\s+in|ansök|ansöka|spara",
  "accedi|accedere|candidati|candidarsi|salva|salvare",
  "entrar|iniciar\\s+sessão|candidatar(?:-se)?|salvar",
  "zaloguj(?:\\s+się)?|aplikuj|zapisz",
  "вход|влез|кандидатствай|запази",
].join("|");

/** What a press on an `assist-only` site may not be: built from the shared commit table plus sign-in, apply and save. */
export const ASSIST_ONLY_COMMIT_LABEL = words(`${COMMITTING_LABEL_SOURCE}|${ASSIST_ONLY_EXTRA_SOURCE}`);

/** Search-field words matched anywhere in a field's name, id, label or placeholder. */
export const SEARCH_FIELD_WORD_SOURCE =
  "(?<![\\p{L}\\p{N}_])(?:search|suche|suchen|suchbegriff\\w*|recherche|rechercher|buscar|búsqueda|zoeken|zoek\\w*|sök|söka|cerca|ricerca|pesquisar|pesquisa|busca|szukaj|wyszukaj|търси|търсене|query|abfrage|requête|consulta|zapytanie|заявка|origin|origine|origen|origem|herkomst|ursprung|destination|ziel|zielort|destino|bestemming|destinazione|where|wohin|où|dónde|donde|waar|vart|dove|onde|skąd|dokąd|къде|check[- ]?in|check[- ]?out|anreise|abreise|inchecken|uitchecken|incheckning|utcheckning|zameldowanie|wymeldowanie|departure|arrival|abflug|ankunft|départ|arrivée|salida|llegada|vertrek|aankomst|avgång|ankomst|partenza|arrivo|partida|chegada|wylot|przylot)(?![\\p{L}\\p{N}_])";

/** Short search-field identifiers or labels (`q`, `from`, `to`, `city` and translations) matched when they are the whole token. */
export const SEARCH_FIELD_EXACT_SOURCE =
  "^\\s*(?:q|from|to|von|nach|de|vers|desde|hacia|van|naar|från|till|da|a|para|z|od|do|от|до|city|stadt|ville|ciudad|stad|città|cidade|miasto|град|location|ort|lieu|ubicación|locatie|plats|luogo|local|miejsce|местоположение)(?:\\s*[?:*])?\\s*$";

/** Protected or personal field words that disqualify a form from being a search form in page-side scripts. */
export const DISQUALIFYING_SEARCH_FIELD_SOURCE =
  "(?<![\\p{L}\\p{N}_])(?:gender|sex|race|racial|ethnicity|ethnic|hispanic|latin[oax]|sexual\\s+orientation|transgender|religion|eeoc?|disabilit\\w*|disabled|behinderung|schwerbehinder\\w*|handicap\\w*|discapacidad|disabilità|deficiência|beperking|funktionsnedsättning|veteran\\w*|criminal|felon\\w*|convict\\w*|vorstrafe\\w*|führungszeugnis|casier\\s+judiciaire|antecedentes|precedenti\\s+penali|strafregister\\w*|strafblad|brottsregister|background\\s+check|consumer\\s+report|certify|attest|declare|affirm|signature|e-?signature|unterschrift|signatur|handtekening|underskrift|assinatura|medical|medications?|symptoms?|anamnese|anamnesi|e-?mail|phone|telephone|mobile)(?![\\p{L}\\p{N}_])";

const SEARCH_FIELD_WORD = new RegExp(SEARCH_FIELD_WORD_SOURCE, "iu");
const SEARCH_FIELD_EXACT = new RegExp(SEARCH_FIELD_EXACT_SOURCE, "iu");

/** Whether a field's naming parts identify it as a search-like field. */
export function isSearchFieldText(texts: readonly (string | null | undefined)[]): boolean {
  for (const raw of texts) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (SEARCH_FIELD_WORD.test(trimmed) || SEARCH_FIELD_EXACT.test(trimmed)) return true;
  }
  return false;
}

/** Facts about one field inside a form, used by `isSearchFormFacts`. */
export interface SearchFormFieldFacts {
  readonly tag: string;
  readonly type?: string | undefined;
  readonly role?: string | undefined;
  readonly visible: boolean;
  readonly secret?: boolean | undefined;
  readonly texts: readonly (string | null | undefined)[];
}

const DISQUALIFYING_INPUT_TYPES = new Set(["password", "email", "tel", "file"]);
const NON_TEXT_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "range", "color", "file"]);

/**
 * Strict search-form test: the form has `role="search"`, or every visible text
 * field in it is search-like, and no field in the form is a password, email,
 * tel, file, textarea, protected class or secret field.
 */
export function isSearchFormFacts(fields: readonly SearchFormFieldFacts[], formRole?: string | null): boolean {
  let visibleTextCount = 0;
  let allVisibleTextSearchLike = true;
  for (const field of fields) {
    const tag = field.tag.toUpperCase();
    const type = (field.type ?? "").toLowerCase();
    const role = (field.role ?? "").toLowerCase();
    if (tag === "TEXTAREA") return false;
    if (tag === "INPUT" && DISQUALIFYING_INPUT_TYPES.has(type)) return false;
    if (field.secret === true) return false;
    if (protectedFieldClass(field.texts) !== undefined) return false;
    if (!field.visible) continue;
    const isTextField =
      (tag === "INPUT" && !NON_TEXT_INPUT_TYPES.has(type)) ||
      role === "textbox" ||
      role === "searchbox" ||
      role === "combobox" ||
      tag === "SELECT";
    if (!isTextField) continue;
    visibleTextCount += 1;
    const searchLike =
      type === "search" || role === "searchbox" || role === "combobox" || tag === "SELECT" || isSearchFieldText(field.texts);
    if (!searchLike) allVisibleTextSearchLike = false;
  }
  const hasSearchRole = (formRole ?? "").trim().toLowerCase() === "search";
  return hasSearchRole || (visibleTextCount > 0 && allVisibleTextSearchLike);
}

/** The commit category of a control's `label`, or `undefined` when the label does not name a commit. */
export function commitCategory(label: string, submitsForm = false): CommitCategory | undefined {
  for (const [category, pattern] of COMMIT_CATEGORY_PATTERNS) {
    if (pattern.test(label)) return category;
  }
  if (submitsForm && APPLY_LABEL.test(label)) return "send";
  return undefined;
}

/** A stage profile's final step (`stage.finalStep`). */
export interface FinalStepRule {
  readonly labels: readonly string[];
  readonly urlPatterns: readonly string[];
  readonly selectors?: readonly string[] | undefined;
  readonly stepHeadings?: readonly string[] | undefined;
}

/** What the browser re-checks before a press: the profile's final step, and whether this call was approved as a commit. */
export interface BrowserActGuard {
  readonly finalStep?: FinalStepRule;
  /** The call's card said it commits and the person approved it: a committing press is theirs. */
  readonly commitApproved: boolean;
  /**
   * The person approved this call on its own card, which sends a form when it
   * presses (a download from an export form's button): a press that sends its
   * form passes, though one whose label commits still needs `commitApproved`.
   */
  readonly formSendApproved?: boolean;
  /**
   * The hosts the call was decided on (`GateVerdict.scopeHosts`): read again
   * just before the action lands, so a page that moved to another site since
   * is not acted on. Absent: not held to a host.
   */
  readonly hosts?: readonly string[];
}

/** Whether pressing a control with `label` commits. */
export function pressCommits(label: string, submitsForm: boolean): boolean {
  return commitCategory(label, submitsForm) !== undefined;
}

const squeezed = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Whether a label is one of the final step's, whole (case and spacing aside). */
export function labelIsFinalStep(label: string, rule: FinalStepRule): boolean {
  const own = squeezed(label);
  return own !== "" && rule.labels.some((candidate) => squeezed(candidate) === own);
}

/** Whether a page's address is the final step's: a pattern is the address's part, with `*` for any run. */
export function urlIsFinalStep(url: string, rule: FinalStepRule): boolean {
  return rule.urlPatterns.some((pattern) => {
    if (pattern === "") return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(escaped, "i").test(url);
  });
}

/** Whether a heading shown is one of the final step's (Workday's "Review"). */
export function headingIsFinalStep(headings: readonly string[], rule: FinalStepRule): boolean {
  const steps = (rule.stepHeadings ?? []).map(squeezed);
  return headings.some((heading) => steps.includes(squeezed(heading)));
}

/**
 * Headings of an application's review step, in the languages the protected
 * fields are read in: a form's buttons under one submit it. Source for
 * the page-side readers too, which cannot import it.
 */
export const REVIEW_STEP_HEADING_SOURCE = "\\b(review|überprüfen|vérifier|revisar|controleren|granska|rivedi|revisão)\\b";
export const REVIEW_STEP_HEADING = new RegExp(REVIEW_STEP_HEADING_SOURCE, "iu");

/** What the browser read of a control it is about to press. */
export interface PressFacts {
  /** A button, link, menu item or submit input: something whose press acts, not a field being clicked into. */
  readonly pressable: boolean;
  readonly label: string;
  readonly submitsForm: boolean;
  /** Whether the control or field belongs to a strict search form. */
  readonly searchForm?: boolean | undefined;
  /** The press is Enter in a field, standing in for the form's submit: only this is exempt in a search form. */
  readonly viaEnter?: boolean | undefined;
  /** The press sends its form: a submit control of it, or Enter in one of its fields. */
  readonly sendsForm?: boolean | undefined;
  /** Whether it matches one of the final step's selectors. */
  readonly selectorMatched: boolean;
  /** The page's headings. */
  readonly headings: readonly string[];
  readonly url: string;
}

/** A form's own button that filters or resets what it lists, and commits nothing. */
const NON_COMMITTING_SUBMIT_LABEL = /^\s*(?:apply\s+filters|check\s+all\s+that\s+apply|reset\s+filters|clear\s+filters)\s*$/i;

/**
 * Whether sending a form is a submit to ask about, whatever its control's
 * label: outside a strict search form, other than a filter form's own buttons.
 */
export function formSendCommits(sends: boolean, searchForm: boolean | undefined, label: string | undefined): boolean {
  return sends && searchForm !== true && !(label !== undefined && NON_COMMITTING_SUBMIT_LABEL.test(label));
}

/** A submit that names no action of its own: a search form's buttonless Enter reads as this. */
const BARE_SUBMIT_LABEL = /^\s*submit\s*$/iu;

/** Why a press is refused, or `undefined`: the final step, or a commit nobody approved. */
export function pressRefusal(
  facts: PressFacts,
  guard: BrowserActGuard,
): { readonly reason: string; readonly finalStep: boolean } | undefined {
  const rule = guard.finalStep;
  // Clicking into a field, or checking a box, presses nothing ("Confirm email", "I confirm…" are fields' labels).
  if (!facts.pressable) return undefined;
  if (rule !== undefined) {
    const selectorCounts = facts.selectorMatched && ((rule.stepHeadings ?? []).length === 0 || headingIsFinalStep(facts.headings, rule));
    if (labelIsFinalStep(facts.label, rule) || urlIsFinalStep(facts.url, rule) || selectorCounts) {
      return {
        reason:
          "this is the form's or booking's last step: Tavi stops before it, and the person reviews and submits it themselves in the live view (browser.request_handoff)",
        finalStep: true,
      };
    }
  }
  // Enter in a search form's field runs the search, unless its submit names a commit ("Pay"); a click is always re-checked.
  const searching =
    facts.viaEnter === true &&
    facts.searchForm === true &&
    (commitCategory(facts.label) === undefined || BARE_SUBMIT_LABEL.test(facts.label));
  if (!guard.commitApproved && !searching && pressCommits(facts.label, facts.submitsForm)) {
    return {
      // What happened, and the way to be asked: the call's card did not show this press as a commit (its element
      // was not in the observation the card read, or the page changed since), so nobody approved one.
      reason: `this press of ${JSON.stringify(facts.label.slice(0, 80))} commits (it pays, sends, signs up, accepts or cancels), and the call was not asked about as one: observe the page again and act on the element from that observation, so the person is asked about this press`,
      finalStep: false,
    };
  }
  // A form sent whatever its label ("Continue", "Weiter", an arrow) is a submit: outside a search form, or a filter
  // form's own buttons, it goes only as one approved as a submit.
  if (
    !guard.commitApproved &&
    guard.formSendApproved !== true &&
    !searching &&
    formSendCommits(facts.sendsForm === true, facts.searchForm, facts.label)
  ) {
    return {
      reason: `this press of ${JSON.stringify(facts.label.slice(0, 80))} sends its form, and it was not approved as a submit: observe the page again and act on it, so it is asked about as one`,
      finalStep: false,
    };
  }
  return undefined;
}
