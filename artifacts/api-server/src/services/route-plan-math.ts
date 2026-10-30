/**
 * Pure SCHED route math. No database, no network. Distances are great-circle
 * miles; drive time is an explicitly labeled estimate (road factor and average
 * speed), never presented as navigation.
 */

export type Point = { latitude: number; longitude: number };

export const ROAD_FACTOR = 1.3;
export const AVERAGE_MPH = 30;

export function haversineMiles(a: Point, b: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Estimated road miles between two points. */
export function legMiles(a: Point, b: Point): number {
  return haversineMiles(a, b) * ROAD_FACTOR;
}

export function estimatedMinutes(miles: number): number {
  return Math.round((miles / AVERAGE_MPH) * 60);
}

export function routeMiles(points: Point[], order: number[], start?: Point | null): number {
  let total = 0;
  let previous: Point | null = start ?? null;
  for (const index of order) {
    const point = points[index]!;
    if (previous) total += legMiles(previous, point);
    previous = point;
  }
  return total;
}

/**
 * Shortest open path visiting every point once (start fixed when given):
 * nearest-neighbour construction refined with 2-opt. Deterministic for a
 * given input order; exact for the small daily stop counts contractors have.
 */
export function suggestOrder(points: Point[], start?: Point | null): number[] {
  const n = points.length;
  if (n <= 1) return points.map((_, index) => index);
  const remaining = new Set(points.map((_, index) => index));
  const order: number[] = [];
  let current: Point | null = start ?? null;
  if (!current) {
    order.push(0);
    remaining.delete(0);
    current = points[0]!;
  }
  while (remaining.size > 0) {
    let best = -1;
    let bestDistance = Infinity;
    for (const index of remaining) {
      const distance = legMiles(current!, points[index]!);
      if (distance < bestDistance - 1e-9) {
        best = index;
        bestDistance = distance;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = points[best]!;
  }
  // 2-opt on an open path; with no fixed start the first stop may move too.
  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard += 1;
    for (let i = 0; i < n - 1; i += 1) {
      for (let k = i + 1; k < n; k += 1) {
        const candidate = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (routeMiles(points, candidate, start) < routeMiles(points, order, start) - 1e-6) {
          order.splice(0, n, ...candidate);
          improved = true;
        }
      }
    }
  }
  return order;
}

/** Google Maps multi-stop directions URL (no API key; opens in the user's maps app). */
export function mapsDirectionsUrl(addresses: string[]): string | null {
  const stops = addresses.map((address) => address.trim()).filter(Boolean);
  if (stops.length === 0) return null;
  const encode = (value: string) => encodeURIComponent(value);
  if (stops.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encode(stops[0]!)}`;
  const destination = stops[stops.length - 1]!;
  const origin = stops[0]!;
  const waypoints = stops.slice(1, -1).slice(0, 9);
  return `https://www.google.com/maps/dir/?api=1&origin=${encode(origin)}&destination=${encode(destination)}${
    waypoints.length ? `&waypoints=${waypoints.map(encode).join("%7C")}` : ""
  }&travelmode=driving`;
}
