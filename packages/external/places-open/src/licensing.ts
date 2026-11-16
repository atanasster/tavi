import { LicensingFileSchema, licensingProblems, type LicensingFile } from "@tavi/places-kit";

import de from "../data/licensing/de.json" with { type: "json" };
import fr from "../data/licensing/fr.json" with { type: "json" };
import gb from "../data/licensing/gb.json" with { type: "json" };
import us from "../data/licensing/us.json" with { type: "json" };

/** The licensing matrix, bundled with the plugin and checked when it loads. */
export const LICENSING: readonly LicensingFile[] = [us, gb, de, fr].map((file) => LicensingFileSchema.parse(file));
const problems = licensingProblems(LICENSING);
if (problems.length > 0) throw new Error(`the licensing matrix: ${problems.join("; ")}`);
