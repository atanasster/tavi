/**
 * Distances and the coarsening a coordinate gets before it leaves the worker:
 * 2 decimals is
 * about 1.1 km, 3 about 110 m.
 */

const EARTH_RADIUS_KM = 6_371.0088;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** The great-circle distance between two points, in kilometres. */
export function distanceKm(a: { readonly lat: number; readonly lon: number }, b: { readonly lat: number; readonly lon: number }): number {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `value` rounded to `decimals` places, as a number. */
export function coarsen(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A point rounded to `decimals`: what a search may send. */
export function coarsenPoint(
  point: { readonly lat: number; readonly lon: number },
  decimals: number,
): { readonly lat: number; readonly lon: number } {
  return { lat: coarsen(point.lat, decimals), lon: coarsen(point.lon, decimals) };
}

export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** The box that holds a circle of `radiusKm` around a point, clamped to the poles. */
export function boxAround(point: { readonly lat: number; readonly lon: number }, radiusKm: number): BoundingBox {
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cosLat = Math.max(0.01, Math.cos(radians(point.lat)));
  const dLon = Math.min(180, dLat / cosLat);
  return { south: Math.max(-90, point.lat - dLat), west: point.lon - dLon, north: Math.min(90, point.lat + dLat), east: point.lon + dLon };
}
