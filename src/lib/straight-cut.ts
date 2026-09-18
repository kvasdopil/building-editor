import Flatten from "@flatten-js/core";
import intersect from "@turf/intersect";
import union from "@turf/union";
import { featureCollection, multiPolygon, polygon } from "@turf/helpers";
import type { Feature, Polygon, MultiPolygon, Position } from "geojson";

/**
 * Clip on both sides of the supporting line, then reconnect regions wherever
 * that line was NOT drawn. This preserves finite endpoints, including endpoints
 * inside a part, and avoids Flatten's ambiguous intersections at touching rings.
 * All coordinates here are local meters, not longitude/latitude.
 */
export function cutStraight(shape: Flatten.Polygon, cut: Flatten.Segment): Flatten.Polygon {
  const origin = cut.start;
  const direction = Flatten.vector(cut.start, cut.end).normalize();
  const normal = Flatten.vector(-direction.y, direction.x);
  const inFrame = ({ x, y }: Flatten.Point): Position => {
    const along = (x - origin.x) * direction.x + (y - origin.y) * direction.y;
    const across = (x - origin.x) * normal.x + (y - origin.y) * normal.y;
    // Make boundary nodes on the cut exactly collinear before polygon clipping.
    return [along, Math.abs(across) < 1e-6 ? 0 : across];
  };
  const rings = [...shape.faces].map((face) => {
    const ring = face.vertices.map(inFrame);
    return [...ring, ring[0]];
  });
  const source = multiPolygon(
    shape.splitToIslands().map((island) =>
      [...island.faces]
        .sort((a, b) => b.area() - a.area())
        .map((face) => {
          const ring = face.vertices.map(inFrame);
          return [...ring, ring[0]];
        }),
    ),
  );
  const reach = 1 + Math.max(...rings.flat().map(([x, y]) => Math.hypot(x, y)));
  const position = (along: number, across: number): Position => [along, across];
  const pieces: Feature<Polygon>[] = [];
  for (const side of [-1, 1]) {
    const mask = polygon([
      [
        position(-reach, 0),
        position(reach, 0),
        position(reach, side * reach),
        position(-reach, side * reach),
        position(-reach, 0),
      ],
    ]);
    const clipped = intersect(featureCollection<Polygon | MultiPolygon>([source, mask]));
    if (!clipped) continue;
    const coordinates =
      clipped.geometry.type === "Polygon"
        ? [clipped.geometry.coordinates]
        : clipped.geometry.coordinates;
    pieces.push(...coordinates.map((rings) => polygon(rings)));
  }
  const along = ([x]: Position) => x;
  const onLine = ([, y]: Position) => y === 0;
  const seams = pieces.map((piece) =>
    piece.geometry.coordinates.flatMap((ring) =>
      ring.slice(1).flatMap((end, i) => {
        const start = ring[i];
        return onLine(start) && onLine(end)
          ? [[Math.min(along(start), along(end)), Math.max(along(start), along(end))]]
          : [];
      }),
    ),
  );
  const groups = pieces.map((_, i) => i);
  const root = (i: number): number => (groups[i] === i ? i : (groups[i] = root(groups[i])));
  for (let i = 0; i < pieces.length; i++) {
    for (let j = 0; j < i; j++) {
      const reconnect = seams[i].some(([a, b]) =>
        seams[j].some(([c, d]) => {
          const start = Math.max(a, c),
            end = Math.min(b, d);
          return end - start > 1e-6 && (start < -1e-6 || end > cut.length + 1e-6);
        }),
      );
      if (reconnect) groups[root(i)] = root(j);
    }
  }
  const result = new Flatten.Polygon();
  for (const group of new Set(groups.map((_, i) => root(i)))) {
    const members = pieces.filter((_, i) => root(i) === group);
    const merged = members.length === 1 ? members[0] : union(featureCollection(members));
    if (!merged) continue;
    const polygons =
      merged.geometry.type === "Polygon"
        ? [merged.geometry.coordinates]
        : merged.geometry.coordinates;
    for (const rings of polygons) {
      for (const [i, ring] of rings.entries()) {
        const face = result.addFace(
          ring
            .slice(0, -1)
            .map(([x, y]) =>
              Flatten.point(
                origin.x + direction.x * x + normal.x * y,
                origin.y + direction.y * x + normal.y * y,
              ),
            ),
        );
        const expected = i === 0 ? Flatten.ORIENTATION.CCW : Flatten.ORIENTATION.CW;
        if (face.orientation() !== expected) face.reverse();
      }
    }
  }
  return result;
}
