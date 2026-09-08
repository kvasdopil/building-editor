# IGN LiDAR integration insights

- The former `diffusion-lidarhd.ign.fr` browser interface can be unavailable while the maintained
  `data.geopf.fr` WFS tile index and download host continue serving data. Runtime discovery should
  use the WFS layer rather than scrape or hard-code the browser interface.
- The Eiffel Tower app tile intersects two IGN kilometre sheets. At the chosen COPC level it yielded
  1,068,048 points from 46 nodes and about 21 MB of compressed range reads, with elevations from
  7.87 m to 354.88 m IGN69 before the browser-tile cap is applied. A per-building integration must
  handle sheet boundaries.
- IGN's files use Lambert-93 and IGN69. XY needs an explicit EPSG:2154 conversion; Z should retain
  its published differences and use the app's existing per-survey ground alignment to Mapterhorn.

Processed into [ADR 0009](memory/adr/0009-ign-lidar-hd-read-on-demand.md) and the
[Building Explorer spec](memory/spec/domain/building-explorer.md), which own the access and display
contracts.
