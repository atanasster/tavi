import { adzuna } from "./adzuna.js";
import { breezy } from "./breezy.js";
import { dice } from "./dice.js";
import { forem } from "./forem.js";
import { jobtech } from "./jobtech.js";
import { nav } from "./nav.js";
import { reed } from "./reed.js";
import { snagajob } from "./snagajob.js";
import { usajobs } from "./usajobs.js";
import { workable } from "./workable.js";
import { workday } from "./workday.js";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { himalayas } from "./himalayas.js";
import { lever } from "./lever.js";
import { personio } from "./personio.js";
import { recruitee } from "./recruitee.js";
import { smartrecruiters } from "./smartrecruiters.js";
import type { JobSourceAdapter } from "./types.js";

/** The first sources: ATS boards the person names, then Adzuna and Himalayas. */
export const J1_SOURCES: readonly JobSourceAdapter[] = [greenhouse, lever, ashby, smartrecruiters, recruitee, personio, adzuna, himalayas];

/** The rest: more employer boards, the government and national APIs where they are permitted, and the boards' official MCP servers. */
export const J2_SOURCES: readonly JobSourceAdapter[] = [breezy, workable, workday, usajobs, jobtech, nav, forem, reed, dice, snagajob];

export { adzuna, ADZUNA_COUNTRIES, ADZUNA_MAX_PAGES, adzunaRecord } from "./adzuna.js";
export { breezy, breezyRecord } from "./breezy.js";
export { DICE_DISCLOSURE, dice, diceRecord } from "./dice.js";
export { FOREM_MAX_PAGES, forem, foremRecord } from "./forem.js";
export { JOBTECH_MAX_PAGES, jobtech, jobtechRecord } from "./jobtech.js";
export { nav, navRecord } from "./nav.js";
export { REED_MAX_PAGES, reed, reedRecord } from "./reed.js";
export { snagajob, snagajobRecord } from "./snagajob.js";
export { USAJOBS_MAX_PAGES, usajobs, usajobsRecord } from "./usajobs.js";
export { workable, workableRecord } from "./workable.js";
export { WORKDAY_PAGES_PER_SEARCH, workday, workdayRecord } from "./workday.js";
export { ashby, ashbyRecord } from "./ashby.js";
export { greenhouse, greenhouseRecord } from "./greenhouse.js";
export { himalayas, himalayasRecord } from "./himalayas.js";
export { lever, leverRecord } from "./lever.js";
export { personio, personioRecord } from "./personio.js";
export { recruitee, recruiteeRecord } from "./recruitee.js";
export { SMARTRECRUITERS_MAX_POSTINGS, smartrecruiters, smartrecruitersRecord } from "./smartrecruiters.js";
export { RETRY_AFTER_MAX_MS, retryAfterMs } from "@tavi/domain-kit";
export { mcpValue, statusOutcome } from "./common.js";
export type { JobSourceAdapter, SourceCall, SourceOutcome, SourceRequest, SourceResponse } from "./types.js";
