# Local datasets and measurement tools

Status: Active (2026-08-30)

Source of truth for where the imported datasets live on a developer machine and how the laser
readings are exercised without the app.

Related documents:

- [Operations specs index](index.md): Parent catalog for operational rules.
- [The laser measures roof tags](../../adr/0007-laser-roof-advice.md): What the readings are and which of them the fit error may choose. Read it before changing a threshold this tool measures.
- [National laser data is read on demand](../../adr/0005-national-laser-data-read-on-demand.md): The upstream the tool reads through, and the cache it shares with the server.
- [Building Explorer domain spec](../domain/building-explorer.md): Normative behavior of the advice this tool measures.

## Where the imported data lives

- `scripts/import-lod1.mjs` and `scripts/import-lidar.mjs` write z16 tiles under `data/lod1` and `data/lidar`. Both are gitignored and regenerated rather than committed. The LiDAR importer defaults to Stockholm; `--dataset icgc --bbox west,south,east,north` resolves and imports the public ICGC kilometre sheets intersecting a bounded Catalonia area.
- ICGC publishes ordinary LAZ rather than COPC. Its source sheets are therefore downloaded under `data/lidar/source/icgc` and decoded offline, never fetched from a route handler. The bbox receives 100 m of context by default and a 16-sheet guard prevents an accidental multi-gigabyte import; both values have explicit CLI overrides.
- The LDR1 header's uint32 at byte 12 identifies the imported survey: zero remains the original Stockholm id for backward compatibility, one identifies Laserdata Skog tiles, and two identifies ICGC LiDAR Territorial. `/api/lidar` serves either imported source without a separate dataset route.
- `BUILDING_DATA_DIR` overrides that root. `localTilePath()` in `src/lib/local-data.ts` resolves it for both tile routes and for the measurement tool, defaulting to `data/` under the working directory.
- A git worktree needs it: the import is tens of megabytes and belongs to the checkout rather than to the branch. Set it in the worktree's `.env`, which Next loads server-side.
- **Never symlink the directory into the project tree instead.** Tailwind's source scan for `globals.css` follows the link, resolves a path above the project root, and Turbopack fails every build with `FileSystemPath("").join("../../../data") leaves the filesystem root`. The error names the stylesheet, not the link; an absolute target does not help, because the offending path is computed relative to the project either way; and it persists in the `.next` cache, so clear that before concluding a fix failed.

## Measuring without the app

`yarn advice` (`scripts/roof-advice.mjs`) prints what the laser reads for one element's `height`,
`roof:height` and `roof:shape` beside the OSM tags and the LOD1 block, and does the same for each
`building:part`. It runs the app's own modules — Node strips the types and `scripts/lib/ts-hooks.mjs`
resolves the extensionless and `@/` imports — through the same limiter and cache as the server, so it
needs no dev server and warms the cache for one.

- `yarn advice way/123456 …` measures named elements.
- `--bbox w,s,e,n` measures every tagged building in a box and ends with the mean absolute error against those tags, plus a `roof:shape` confusion matrix. This is how a threshold change is judged.
- `--png <dir>` writes each building's surface grid as a picture. Looking at the misread ones is what diagnosed the wall reading; `scripts/lib/png.mjs` is a dependency-free writer for it.
- `--no-parts` restricts it to outlines, `--all` includes untagged buildings, `--json` emits the results.

## The calibration set

Hammarby Sjöstad, where roof tags are well maintained:

```bash
yarn advice --bbox 18.0842,59.2978,18.1119,59.3083 --no-parts
```

260 buildings with a tagged height, 112 with a tagged shape. Any change to `src/lib/surface-grid.ts`
or `src/lib/roof-advice.ts` is judged against it. A flat neighbourhood will not catch a ground-datum
regression, so check a steep one too — Kastellholmen and the old town, where LOD1 still reads height
better than the laser does.
