/**
 * Form fields only a person fills: equal-opportunity
 * and demographic questions, disability and veteran status, criminal history,
 * attestations (that an application is the person's own work, its use of AI,
 * "I certify"), a signature, consent to a background check, and a clinic's
 * medical intake (medical history, symptoms and conditions,
 * health questionnaires, current medication, consent to treatment), the last in
 * English, German, French, Spanish, Portuguese, Italian, Polish and Dutch. Tavi never
 * types into, selects or checks one, on any host: the person fills it in the
 * live view. Read from what a field says of itself (its label, legend, name,
 * id, aria-label, placeholder) and from a value about to be typed.
 *
 * English, German, French, Spanish, Dutch, Swedish, Italian and Portuguese,
 * with the field names observed per ATS. A word that means
 * something else in another language is matched only in its phrase ("firma"
 * is German for company, so a signature is "firma digital", "sua firma"…).
 */

export const PROTECTED_FIELD_CLASSES = [
  "demographic",
  "disability",
  "veteran",
  "criminal-history",
  "attestation",
  "signature",
  "background-check",
  "medical-intake",
] as const;
export type ProtectedFieldClass = (typeof PROTECTED_FIELD_CLASSES)[number];

/** A pattern of whole words, read as Unicode: `\b` treats "à" as a boundary, so "disabilità" would never end a word. */
const words = (alternation: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "iu");

const PATTERNS: readonly (readonly [ProtectedFieldClass, RegExp])[] = [
  [
    "demographic",
    words(
      "gender|sex|race|racial|ethnicity|ethnic (?:origin|background|group)|hispanic|latin[oax]|sexual orientation|transgender|religion|religious|eeoc?|eeo[_ -]?\\w*|self[- ]?identif\\w*|voluntary (?:self|disclosure)",
    ),
  ],
  [
    "demographic",
    words(
      "geschlecht|ethnische herkunft|religionszugehörigkeit|sexuelle orientierung|sexe|origine ethnique|orientation sexuelle|g[eéê]nero|genere|sexo|raza|razza|etnia|origen étnico|origine etnica|origem [eé]tnica|etnische (?:afkomst|achtergrond)|etnisk (?:bakgrund|tillhörighet|ursprung)|orientaci[oó]n sexual|religi[oó]n|geslacht|etniciteit|seksuele (?:geaardheid|oriëntatie)|kön|etnicitet|sexuell läggning|sesso|orientamento sessuale|religione|ra[cç]a|orienta[cç][aã]o sexual|religi[aã]o",
    ),
  ],
  [
    "disability",
    words(
      "disabilit(?:y|ies)|disabled|behinderung|schwerbehinder\\w*|situation de handicap|travailleur handicapé|avez-vous un handicap|rqth|discapacidad|disabilità|deficiência|beperking|funktionsnedsättning|funktionshinder",
    ),
  ],
  ["veteran", words("veteran\\w*|protected veteran|military service|veterano|ancien combattant|veteraan")],
  [
    "criminal-history",
    words(
      "criminal (?:history|record|background|conviction\\w*|offen[cs]e\\w*)|felony|felonies|convicted|conviction\\w*|vorstrafe\\w*|führungszeugnis|casier judiciaire|antecedentes (?:penales|criminais)|precedenti penali|casellario(?: giudiziale)?|strafregister\\w*|strafblad|brottsregister|belastningsregister",
    ),
  ],
  [
    "background-check",
    words(
      "background (?:check|screening|investigation)|consumer report|hintergrundprüfung|vérification des antécédents|verificaci[oó]n de antecedentes|achtergrond(?:controle|onderzoek)|antecedentenonderzoek|bakgrundskontroll|(?:controllo|verifica) dei precedenti|verifica[cç][aã]o de antecedentes",
    ),
  ],
  [
    "attestation",
    words(
      "i (?:hereby )?(?:certify|attest|declare|affirm|confirm that)|personally completed|completed (?:this application )?(?:myself|by me)|ai(?:-| )?(?:use|policy)|use of (?:ai|artificial intelligence|generative)|accept (?:the )?terms|acceptterms\\w*|terms and (?:conditions|agreements)|ich (?:akzeptiere|stimme) (?:die |den )?(?:agb|nutzungsbedingungen|bedingungen)|agb|allgemeinen geschäftsbedingungen|j['’]accepte (?:les )?(?:conditions|cgu|termes)|conditions générales|acepto (?:los |las )?(?:términos|condiciones)|términos y condiciones|accetto (?:i |le )?(?:termini|condizioni)|termini e condizioni|aceito (?:os |as )?(?:termos|condi[cç][oõ]es)|termos e condi[cç][oõ]es|ik (?:ga akkoord met|accepteer) de (?:algemene )?voorwaarden|algemene voorwaarden|jag (?:godkänner|accepterar) (?:villkoren|användarvillkoren)|ich (?:versichere|bestätige|erkläre)|je (?:certifie|déclare|atteste)|certifico|declaro|dichiaro|ik verklaar|jag intygar|attesto",
    ),
  ],
  // A clinic's intake, in the booking profiles' languages. Not "allergies" (a restaurant's dietary notes) nor a bare "conditions" (terms and conditions).
  [
    "medical-intake",
    words(
      "medical (?:history|conditions?|questionnaire)|medications? list|patient(?:'s)? history|health (?:history|declaration|questionnaire|conditions?)|pre-?existing (?:medical )?conditions?|chronic (?:conditions?|illness\\w*)|symptoms?|current (?:medications?|medicines?)|medications? (?:you take|taken)|consent to (?:medical )?treatment|treatment consent|anamnese|vorerkrankung\\w*|krankengeschichte|symptome?|(?:aktuelle|akute|ihre|welche) beschwerden|gesundheitsfragebogen|medikamente|einwilligung (?:zur|in die) behandlung|antécédents médicaux|historique médical|sympt[oô]mes?|questionnaire (?:de santé|médical)|déclaration de santé|traitements? en cours|consentement aux soins|historia(?:l)? cl[ií]nic[oa]|antecedentes m[eé]dicos|s[ií]ntomas?|cuestionario de salud|declaraci[oó]n de salud|medicaci[oó]n actual|consentimiento informado (?:para|del?) (?:el )?(?:tratamiento|procedimiento)|hist[oó]rico (?:m[eé]dico|cl[ií]nico)|question[aá]rio de sa[uú]de|declara[cç][aã]o de sa[uú]de|medica[cç][aã]o (?:atual|em uso)|consentimento informado (?:para|do) (?:o )?(?:tratamento|procedimento)|anamnesi|storia clinica|sintomi|questionario (?:sanitario|di salute)|consenso informato (?:al|per il) (?:trattamento|intervento)|wywiad medyczny|historia choroby|objawy|choroby przewlekłe|kwestionariusz (?:zdrowia|medyczny)|zgoda na leczenie|medische (?:voor)?geschiedenis|symptomen|huidige klachten|gezondheidsverklaring|toestemming voor (?:de )?behandeling",
    ),
  ],
  [
    "signature",
    /(?<!e-?mail[ -])(?<![\p{L}\p{N}_])(?:signature|e-?signature|sign here|signed by|electronically sign\w*|unterschrift|signatur|handtekening|underskrift|firma (?:digital|electr[oó]nica|elettronica)|(?:su|sua|la tua|tu) firma|assinatura)(?![\p{L}\p{N}_])/iu,
  ],
];

/**
 * What a value about to be typed may itself be: a first-person attestation
 * ("I hereby certify…"). Narrower than a field's own words, since a value is
 * also every search a person types ("criminal defense lawyer", "race
 * tickets", "AI engineer").
 */
const VALUE_ATTESTATION = words(
  "i (?:hereby )?(?:certify|attest|declare|swear)|personally completed|ich (?:versichere|erkläre)|je (?:certifie|déclare|atteste)|(?:yo )?certifico|declaro (?:que|bajo)|dichiaro (?:che|di)|ik verklaar|jag intygar|attesto che",
);

/** Field names observed per ATS, each a whole name or a name with a part after it (`eeo[race]`, `formField-gender`). */
const ATS_NAMES =
  /^(gender|race|hispanic_ethnicity|veteran_status|disability_status|eeo|_systemfield_eeoc_\w*|formfield-(gender|hispanicorlatino|ethnicity|veteranstatus|disabilitystatus|accepttermsandagreements)|selfidentifieddisabilitydata|accepttermsandagreements)($|[[\]_.-])/i;

/** A label that is the one word "Handicap" (French): in a phrase ("golf handicap") it is something else. */
const HANDICAP_ALONE = /^\s*handicap\s*[?:*]?\s*$/i;
/** A label that is only "Medications" (or the word in another language): in a phrase it may be a pharmacy's or a job's. */
const MEDICATION_ALONE = /^\s*(?:medications?|medicines|medikamente|médicaments|medicamentos|farmaci|leki|medicijnen)\s*[?:*]?\s*$/i;

/** The class of a protected field, from what it says of itself; `undefined` for any other field. */
export function protectedFieldClass(texts: readonly (string | null | undefined)[]): ProtectedFieldClass | undefined {
  for (const raw of texts) {
    if (raw === undefined || raw === null) continue;
    const text = raw.slice(0, 2_000);
    if (HANDICAP_ALONE.test(text)) return "disability";
    if (MEDICATION_ALONE.test(text)) return "medical-intake";
    if (ATS_NAMES.test(text.trim()))
      return /accept|terms/i.test(text)
        ? "attestation"
        : /disab/i.test(text)
          ? "disability"
          : /veteran/i.test(text)
            ? "veteran"
            : "demographic";
    // A name or id's parts (`veteranStatus`, `eeo[race]`) read as words.
    const parts = text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_[\]./-]+/g, " ");
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text) || pattern.test(parts)) return kind;
  }
  return undefined;
}

/** Whether a value about to be typed is itself an attestation, whatever field it goes in. */
export function protectedValueClass(value: string | null | undefined): ProtectedFieldClass | undefined {
  return value !== undefined && value !== null && VALUE_ATTESTATION.test(value.slice(0, 2_000)) ? "attestation" : undefined;
}

/** Why a field is refused, as a refusal says it. */
export function protectedFieldRefusal(kind: ProtectedFieldClass): string {
  const what: Readonly<Record<ProtectedFieldClass, string>> = {
    demographic: "an equal-opportunity or demographic question",
    disability: "a disability question",
    veteran: "a veteran-status question",
    "criminal-history": "a criminal-history question",
    attestation: "an attestation or terms the person accepts themselves",
    signature: "a signature",
    "background-check": "consent to a background check",
    "medical-intake": "a medical-history, symptom or treatment-consent question",
  };
  return `this is ${what[kind]}: only the person fills it, in the live view (browser.request_handoff)`;
}
