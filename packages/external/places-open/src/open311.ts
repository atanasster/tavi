import { Open311CitySchema, type Open311City } from "@tavi/places-kit";

import cities from "../data/open311.json" with { type: "json" };

/** The Open311 cities `area_report` asks: a list kept as data, each endpoint checked when it was added. */
export const OPEN311_CITIES: readonly Open311City[] = cities.map((city) => Open311CitySchema.parse(city));
