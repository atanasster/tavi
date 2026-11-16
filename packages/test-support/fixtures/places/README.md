# Places fixtures

Recorded responses of the public sources the places kit reads, and hand-written
ones where a source needs a key or has no stable public sample (file names
ending in `-synthetic`). Each source's attribution and licence are the ones its
adapter declares in `src/sources/`; a recorded file keeps that licence.

| Folder | Source | Licence and attribution |
| --- | --- | --- |
| `overpass/`, `nominatim/`, `photon/` | OpenStreetMap, through the Overpass API, Nominatim and Photon | © OpenStreetMap contributors, ODbL 1.0 |
| `overture/` | Overture Maps places release (STAC catalogue and a GeoParquet row group) | Overture Maps Foundation; places from Meta, Microsoft, Foursquare and others (CDLA-Permissive-2.0, Apache-2.0, CC0 by dataset) |
| `routing/` | openrouteservice and OSRM response shapes | synthetic |
| `ev/afdc-austin-public.json` | Alternative Fuels Data Center | Alternative Fuels Data Center, U.S. Department of Energy (public) |
| `ev/bnetza-*` | Bundesnetzagentur charging-point register | Bundesnetzagentur.de, CC BY 4.0 |
| `ev/ocm-berlin-synthetic.json` | Open Charge Map's response shape | synthetic |
| `fuel/at-wien-die.json` | E-Control Spritpreisrechner | E-Control; licence not confirmed |
| `fuel/es-madrid-province-28.json` | Geoportal Gasolineras | Ministerio para la Transición Ecológica (datos.gob.es terms, not confirmed) |
| `fuel/fr-lyon-gazole.json` | prix-carburants.gouv.fr | Licence Ouverte 2.0 |
| `fuel/tankerkoenig-berlin-demo.json` | Tankerkönig (MTS-K) demo response | CC BY 4.0 |
| `fuel/wa-fuelwatch-diesel.xml` | FuelWatch, Government of Western Australia | the feed says "All Rights Reserved"; a short sample kept for the adapter's parser |
| `fuel/eu-oil-bulletin-*` | Weekly Oil Bulletin | European Commission, CC BY 4.0 |
| `fuel/*-synthetic.*` | EIA, Osservaprezzi and others' response shapes | synthetic |
| `civic/nyc-*` | NYC Open Data: 311 and DOB NOW | NYC Open Data terms of use |
| `civic/open311-sf.json` | San Francisco 311, via Open311 | public |
| `civic/police-uk-shoreditch.json` | data.police.uk | Open Government Licence v3.0 |
| `tdlr/electricians-synthetic.json` | Texas TDLR licence search's shape | synthetic |
| `care/npi-*`, `care/cms-dc-npis.json` | CMS NPPES NPI Registry and Provider Data Catalog | CMS (public) |
| `care/humana-*` | Humana's CMS-mandated provider directory API (FHIR) | public |
| `resolution-pairs.json` | hand-written pairs for place resolution | synthetic |

In `care/`, practitioners' names, phone and fax numbers and email addresses are
replaced with invented ones (`555` numbers, `example.com`); NPI numbers,
taxonomies, plan names and practice addresses are kept, since the matching
reads them.
