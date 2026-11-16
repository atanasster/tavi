import { distanceKm } from "./geo.js";

/**
 * A route as a line of points, and where a place sits on it.
 * Without a router,
 * the line is the great circle through the route's points, and its road
 * distance an estimate: the great-circle distance times `ROAD_FACTOR`.
 */

export type LinePoint = { readonly lat: number; readonly lon: number };

/** A road is about this much longer than the great circle between its ends. */
export const ROAD_FACTOR = 1.25;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (value: number): number => (value * 180) / Math.PI;

/** The point a fraction `f` of the way from `a` to `b` on the great circle. */
export function interpolate(a: LinePoint, b: LinePoint, f: number): LinePoint {
  const [lat1, lon1, lat2, lon2] = [radians(a.lat), radians(a.lon), radians(b.lat), radians(b.lon)];
  const d =
    2 *
    Math.asin(
      Math.min(1, Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2)),
    );
  if (d === 0) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return { lat: degrees(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: degrees(Math.atan2(y, x)) };
}

/** The great circle through `points`, a point at least every `spacingKm`. */
export function corridorLine(points: readonly LinePoint[], spacingKm: number): LinePoint[] {
  const line: LinePoint[] = points.slice(0, 1);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as LinePoint;
    const b = points[index] as LinePoint;
    const steps = Math.max(1, Math.ceil(distanceKm(a, b) / spacingKm));
    for (let step = 1; step <= steps; step += 1) line.push(interpolate(a, b, step / steps));
  }
  return line;
}

/** The length of a line, in kilometres. */
export function lineLengthKm(line: readonly LinePoint[]): number {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) total += distanceKm(line[index - 1] as LinePoint, line[index] as LinePoint);
  return total;
}

/** At most `max` of the line's points, evenly spread along it, its ends kept. */
export function thinLine(line: readonly LinePoint[], max: number): LinePoint[] {
  if (line.length <= max) return [...line];
  const total = lineLengthKm(line);
  const kept: LinePoint[] = [line[0] as LinePoint];
  let along = 0;
  let next = total / (max - 1);
  for (let index = 1; index < line.length - 1; index += 1) {
    along += distanceKm(line[index - 1] as LinePoint, line[index] as LinePoint);
    if (along >= next && kept.length < max - 1) {
      kept.push(line[index] as LinePoint);
      next += total / (max - 1);
    }
  }
  kept.push(line.at(-1) as LinePoint);
  return kept;
}

/** The line cut into `parts` pieces of about equal length, each sharing its end with the next. */
export function splitLine(line: readonly LinePoint[], parts: number): LinePoint[][] {
  const total = lineLengthKm(line);
  const pieces: LinePoint[][] = [];
  let piece: LinePoint[] = [line[0] as LinePoint];
  let along = 0;
  for (let index = 1; index < line.length; index += 1) {
    along += distanceKm(line[index - 1] as LinePoint, line[index] as LinePoint);
    piece.push(line[index] as LinePoint);
    if (along >= (total * (pieces.length + 1)) / parts && pieces.length < parts - 1 && index < line.length - 1) {
      pieces.push(piece);
      piece = [line[index] as LinePoint];
    }
  }
  pieces.push(piece);
  return pieces.filter((part) => part.length > 1);
}

/** How far along the line a point's nearest spot is, and how far the point is from it, both in kilometres. */
export function positionOnLine(point: LinePoint, line: readonly LinePoint[]): { readonly alongKm: number; readonly offKm: number } {
  let best = { alongKm: 0, offKm: line[0] === undefined ? Infinity : distanceKm(point, line[0]) };
  let along = 0;
  for (let index = 1; index < line.length; index += 1) {
    const a = line[index - 1] as LinePoint;
    const b = line[index] as LinePoint;
    const length = distanceKm(a, b);
    // A local flat frame around the point: good to metres over one segment.
    const scale = Math.cos(radians(point.lat));
    const [ax, ay, bx, by] = [(a.lon - point.lon) * scale, a.lat - point.lat, (b.lon - point.lon) * scale, b.lat - point.lat];
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / span));
    const nearest = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    const off = distanceKm(point, nearest);
    if (off < best.offKm) best = { alongKm: along + t * length, offKm: off };
    along += length;
  }
  return best;
}
