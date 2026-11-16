import { PayerSchema, type Payer } from "@tavi/places-kit";

import payers from "../data/payers.json" with { type: "json" };

/**
 * The payers `in_network` knows, kept as data. A payer with a
 * `fhirBase` has a Plan-Net directory that answered a practitioner by NPI
 * when it was added; the others send the person to their own directory.
 */
export const PAYERS: readonly Payer[] = payers.map((payer) => PayerSchema.parse(payer));
