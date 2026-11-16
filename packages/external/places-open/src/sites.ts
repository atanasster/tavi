import { SiteProfileSchema, type SiteProfile } from "@tavi/contracts";

import site_2gis from "../sites/2gis.json" with { type: "json" };
import site_doctolib_de from "../sites/doctolib-de.json" with { type: "json" };
import site_doctolib_fr from "../sites/doctolib-fr.json" with { type: "json" };
import site_doctolib_it from "../sites/doctolib-it.json" with { type: "json" };
import site_doctoralia_br from "../sites/doctoralia-br.json" with { type: "json" };
import site_doctoralia_es from "../sites/doctoralia-es.json" with { type: "json" };
import site_doctoralia_mx from "../sites/doctoralia-mx.json" with { type: "json" };
import site_fresha from "../sites/fresha.json" with { type: "json" };
import site_gasbuddy from "../sites/gasbuddy.json" with { type: "json" };
import site_jameda from "../sites/jameda.json" with { type: "json" };
import site_kakao_place from "../sites/kakao-place.json" with { type: "json" };
import site_naver_place from "../sites/naver-place.json" with { type: "json" };
import site_nhs_gp from "../sites/nhs-gp.json" with { type: "json" };
import site_opentable from "../sites/opentable.json" with { type: "json" };
import site_planity from "../sites/planity.json" with { type: "json" };
import site_resy from "../sites/resy.json" with { type: "json" };
import site_tabelog from "../sites/tabelog.json" with { type: "json" };
import site_thefork from "../sites/thefork.json" with { type: "json" };
import site_treatwell from "../sites/treatwell.json" with { type: "json" };
import site_yandex_maps from "../sites/yandex-maps.json" with { type: "json" };
import site_znanylekarz from "../sites/znanylekarz.json" with { type: "json" };
import site_zocdoc from "../sites/zocdoc.json" with { type: "json" };

/** The site profiles this plugin ships (its manifest's `sites` block), bundled so `availability` can say what each platform allows. */
export const SITE_PROFILES: readonly SiteProfile[] = [
  site_2gis,
  site_doctolib_de,
  site_doctolib_fr,
  site_doctolib_it,
  site_doctoralia_br,
  site_doctoralia_es,
  site_doctoralia_mx,
  site_fresha,
  site_gasbuddy,
  site_jameda,
  site_kakao_place,
  site_naver_place,
  site_nhs_gp,
  site_opentable,
  site_planity,
  site_resy,
  site_tabelog,
  site_thefork,
  site_treatwell,
  site_yandex_maps,
  site_znanylekarz,
  site_zocdoc,
].map((profile) => SiteProfileSchema.parse(profile));
