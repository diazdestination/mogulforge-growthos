import { describe, expect, it } from "vitest";

import { estimatedMinutes, haversineMiles, mapsDirectionsUrl, routeMiles, suggestOrder } from "../services/route-plan-math";

// Four stops on a line, visited zig-zag in time order: 0 -> 3 -> 1 -> 2.
const line = [
  { latitude: 34.0, longitude: -84.0 },
  { latitude: 34.0, longitude: -83.9 },
  { latitude: 34.0, longitude: -83.8 },
  { latitude: 34.0, longitude: -83.7 },
];

describe("route math", () => {
  it("measures great-circle miles", () => {
    expect(haversineMiles({ latitude: 34, longitude: -84 }, { latitude: 34, longitude: -84 })).toBe(0);
    const oneDegreeLat = haversineMiles({ latitude: 34, longitude: -84 }, { latitude: 35, longitude: -84 });
    expect(oneDegreeLat).toBeGreaterThan(68);
    expect(oneDegreeLat).toBeLessThan(70);
    expect(estimatedMinutes(15)).toBe(30);
  });

  it("finds the straight-line order and never lengthens the route", () => {
    const zigzag = [line[0]!, line[3]!, line[1]!, line[2]!];
    const order = suggestOrder(zigzag);
    expect(routeMiles(zigzag, order)).toBeLessThan(routeMiles(zigzag, [0, 1, 2, 3]));
    const visited = order.map((index) => zigzag[index]!.longitude);
    const ascending = [...visited].sort((a, b) => a - b);
    const descending = [...ascending].reverse();
    expect([ascending, descending]).toContainEqual(visited);
    expect(new Set(order).size).toBe(4);
  });

  it("handles empty and single-stop days", () => {
    expect(suggestOrder([])).toEqual([]);
    expect(suggestOrder([line[0]!])).toEqual([0]);
    expect(routeMiles([line[0]!], [0])).toBe(0);
  });

  it("builds a maps link in the given order", () => {
    expect(mapsDirectionsUrl([])).toBeNull();
    expect(mapsDirectionsUrl(["1 Main St, Dawsonville, GA"])).toContain("search/?api=1&query=1%20Main%20St");
    const url = mapsDirectionsUrl(["A St", "B St", "C St"])!;
    expect(url).toContain("origin=A%20St");
    expect(url).toContain("destination=C%20St");
    expect(url).toContain("waypoints=B%20St");
  });
});
it("keeps first booked stop fixed even when moving it would shorten the path", () => {
  const points = [{latitude:34,longitude:-84}, {latitude:34,longitude:-84.1}, {latitude:34,longitude:-83.9}];
  expect(suggestOrder(points)[0]).toBe(0);
});
it("refuses itineraries that cannot fit instead of dropping stops", () => {
  expect(mapsDirectionsUrl(Array.from({length:12}, (_, i) => `${i} Main St`))).toBeNull();
  expect(mapsDirectionsUrl(['A'.repeat(2100)])).toBeNull();
  expect(mapsDirectionsUrl(['A', '', 'B'])).toBeNull();
});
