import { makeSweref99Forward } from "./sweref99.mjs";

export const ICGC_LIDAR_BASE =
  "https://datacloud.icgc.cat/datacloud/lidar-territorial/vigent/laz_unzip";

/** ICGC LiDAR Territorial source sheets intersecting a WGS84 bounding box. */
export function icgcSourceTiles([west, south, east, north]) {
  const project = makeSweref99Forward({ lon0: 3, k0: 0.9996, falseEasting: 500000 });
  const corners = [
    project(west, south),
    project(west, north),
    project(east, south),
    project(east, north),
  ];
  const minX = Math.floor(Math.min(...corners.map(([x]) => x)) / 1000);
  const maxX = Math.floor(Math.max(...corners.map(([x]) => x)) / 1000);
  const minY = Math.floor(Math.min(...corners.map(([, y]) => y)) / 1000);
  const maxY = Math.floor(Math.max(...corners.map(([, y]) => y)) / 1000);
  const sheets = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const shortY = y % 1000;
      const folder = `full10km${Math.floor(x / 10)}${String(Math.floor(shortY / 10)).padStart(2, "0")}`;
      const code = `${x}${String(shortY).padStart(3, "0")}`;
      const name = `lidar-territorial-full1km${code}.laz`;
      sheets.push({ code, name, url: `${ICGC_LIDAR_BASE}/${folder}/${name}` });
    }
  }
  return sheets;
}
