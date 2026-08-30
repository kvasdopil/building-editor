import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MaplibreMap,
} from "maplibre-gl";
import type { Footprint } from "./buildings";
import type { LidarCloud } from "./lidar";
import { recommendSeparationLines } from "./separation-lines";
import { buildSurfaceGrid, gridToLonLat, surfaceGridImage } from "./surface-grid";

/**
 * What the LiDAR view shows. `colour` shows each point in the survey's own
 * orthophoto sample, `height` replaces that with a rainbow ramp over the
 * heights currently in view, which reads relief and roof shape that the flat
 * top-down view otherwise hides, and `diff` colours each point by how far it
 * sits above or below the roof this app models from the OSM tags. `surface`
 * sets the points aside and rasterises the outline into half-metre cells
 * instead, each filled with all three surface readings at once: hue for the
 * facing direction, saturation for the steepness, brightness for the height —
 * overlaid with the recommended part-separation lines, bright where the
 * detector would accept them and faint where they are only worth a review.
 */
export type LidarColourMode = "colour" | "height" | "surface" | "diff";

/** How each mode reaches the shader's `u_mode`; `surface` never does. */
const COLOUR_MODE_UNIFORM: Record<LidarColourMode, number> = {
  colour: 0,
  height: 1,
  diff: 2,
  surface: 0,
};

const MAX_MERCATOR_LATITUDE = 85.051129;

const METERS_PER_DEG_LAT = 111320;

/**
 * How far apart two neighbouring points may be and still be joined by a line.
 * Points are stored in the order the scanner recorded them, so a link between
 * consecutive points traces the sweep of the beam; the threshold cuts the links
 * that would otherwise jump between two unrelated stretches of a flight.
 */
const MAX_LINK_M = 20;

/**
 * The disagreement, in metres, at which the difference colouring reaches full
 * strength.
 *
 * Fixed rather than fitted to what is on screen. Fitting it to the largest
 * disagreement in view sounds adaptive and is actually useless here: a single
 * tree is twenty metres above the terrain nobody modelled it on, so it sets the
 * scale and squashes a building that is five metres wrong down to almost
 * nothing. A fixed scale also means the colour is worth the same everywhere —
 * one storey looks like one storey whichever building is selected and however
 * far the map is zoomed — instead of shifting meaning under a pan.
 */
const DIFFERENCE_FULL_SCALE_M = 10;

function toMercator(longitude: number, latitude: number): [number, number] {
  const clampedLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude),
  );
  const radians = (clampedLatitude * Math.PI) / 180;
  return [
    (longitude + 180) / 360,
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  ];
}

/**
 * The metric step from each point to the one before it, as east/north/up metres,
 * or `NaN` where the two are not linked at all.
 *
 * A laser tile keeps its points in the order the scanner produced them — along
 * the sweep of the beam, sweep after sweep, flight line after flight line — so
 * the step from one stored point to the next is a step along the beam's own
 * path, not a step to an arbitrary neighbour. Both the drawn links and their
 * angles are read off it, so the rule for what counts as a step lives here
 * once: same survey, and no further apart than `MAX_LINK_M`.
 */
function metricSteps(cloud: LidarCloud): Float32Array {
  const steps = new Float32Array(cloud.count * 3).fill(Number.NaN);
  const cosLat = Math.cos(((cloud.lat[0] ?? 0) * Math.PI) / 180);
  const maxSquared = MAX_LINK_M * MAX_LINK_M;

  for (let index = 1; index < cloud.count; index++) {
    if (cloud.surveys[index] !== cloud.surveys[index - 1]) continue;
    const east = (cloud.lon[index] - cloud.lon[index - 1]) * METERS_PER_DEG_LAT * cosLat;
    const north = (cloud.lat[index] - cloud.lat[index - 1]) * METERS_PER_DEG_LAT;
    if (east * east + north * north > maxSquared) continue;
    steps[index * 3] = east;
    steps[index * 3 + 1] = north;
    steps[index * 3 + 2] = cloud.z[index] - cloud.z[index - 1];
  }

  return steps;
}

/**
 * Index pairs joining each stored point to the next one, for `gl.LINES`. Where
 * the survey is intact these read as the scanner's own raster; where the cloud
 * has been merged, thinned or clipped they fan out instead, which is exactly
 * the difference worth seeing.
 */
function linkNeighbours(count: number, steps: Float32Array): Uint32Array {
  const links = new Uint32Array(Math.max(0, count - 1) * 2);
  let at = 0;
  for (let index = 1; index < count; index++) {
    if (Number.isNaN(steps[index * 3])) continue;
    links[at++] = index - 1;
    links[at++] = index;
  }
  return links.subarray(0, at);
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: typeof gl.VERTEX_SHADER | typeof gl.FRAGMENT_SHADER,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create LiDAR map shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader) ?? "Unknown shader compilation error";
  gl.deleteShader(shader);
  throw new Error(`Could not compile LiDAR map shader: ${message}`);
}

/**
 * GPU-backed top-down LiDAR overlay. Positions contain only Web Mercator X/Y;
 * survey height never enters the map transform, so the layer cannot acquire
 * the perspective or vertical displacement of the Three.js point cloud.
 */
export class LidarMapLayer implements CustomLayerInterface {
  readonly id = "lidar-points";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexArray: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private colourBuffer: WebGLBuffer | null = null;
  private linkBuffer: WebGLBuffer | null = null;
  private matrixLocation: WebGLUniformLocation | null = null;
  private pointSizeLocation: WebGLUniformLocation | null = null;
  private isPointLocation: WebGLUniformLocation | null = null;
  private heightBuffer: WebGLBuffer | null = null;
  private differenceBuffer: WebGLBuffer | null = null;
  private modeLocation: WebGLUniformLocation | null = null;
  private rampRangeLocation: WebGLUniformLocation | null = null;
  private positions = new Float32Array();
  private colours: Float32Array<ArrayBufferLike> = new Float32Array();
  private heights: Float32Array<ArrayBufferLike> = new Float32Array();
  private differences: Float32Array<ArrayBufferLike> = new Float32Array();
  private links: Uint32Array<ArrayBufferLike> = new Uint32Array();
  private pointCount = 0;
  private linkCount = 0;
  private visible = false;
  private linksVisible = false;
  private mode: LidarColourMode = "colour";
  /** The ends of the ramp for the current mode, over the points in view. */
  private rampRange: [number, number] = [0, 1];
  private lonLat: { lon: Float64Array; lat: Float64Array } | null = null;
  private cloud: LidarCloud | null = null;
  private footprint: Footprint[] = [];
  private gridProgram: WebGLProgram | null = null;
  private gridMatrixLocation: WebGLUniformLocation | null = null;
  private gridVertexArray: WebGLVertexArrayObject | null = null;
  private gridQuadBuffer: WebGLBuffer | null = null;
  private edgeProgram: WebGLProgram | null = null;
  private edgeMatrixLocation: WebGLUniformLocation | null = null;
  private gridTexture: WebGLTexture | null = null;
  private gridQuadReady = false;
  private edgeVertexArray: WebGLVertexArrayObject | null = null;
  private edgeBuffer: WebGLBuffer | null = null;
  private edgeVertexCount = 0;
  private onMoveEnd = () => this.refitRamp();
  private originX = 0;
  private originY = 0;
  private localizedMatrix = new Float32Array(16);

  setCloud(cloud: LidarCloud | null, footprint: Footprint[] = []): void {
    this.cloud = cloud;
    this.footprint = footprint;
    this.gridQuadReady = false;
    this.pointCount = cloud?.count ?? 0;
    this.positions = new Float32Array(this.pointCount * 2);
    this.colours = cloud?.colours ?? new Float32Array();
    this.heights = cloud?.z ?? new Float32Array();
    // Differences are measured against a particular cloud, so a new one leaves
    // them behind rather than colouring these points with the last building's
    // numbers until fresh ones arrive.
    this.differences = new Float32Array();
    this.lonLat = cloud ? { lon: cloud.lon, lat: cloud.lat } : null;

    if (cloud) {
      [this.originX, this.originY] = toMercator(cloud.lon[0], cloud.lat[0]);
      for (let index = 0; index < cloud.count; index++) {
        const [x, y] = toMercator(cloud.lon[index], cloud.lat[index]);
        this.positions[index * 2] = x - this.originX;
        this.positions[index * 2 + 1] = y - this.originY;
      }
      this.links = linkNeighbours(cloud.count, metricSteps(cloud));
    } else {
      this.originX = 0;
      this.originY = 0;
      this.links = new Uint32Array();
      this.differences = new Float32Array();
    }
    this.linkCount = this.links.length / 2;

    this.upload();
    if (this.mode === "surface") this.ensureGrid();
    this.refitRamp();
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.refitRamp();
    this.map?.triggerRepaint();
  }

  /**
   * How far each point sits above the roof modelled from OSM, as
   * `(difference, known)` pairs from `roofDifferences`. It arrives separately
   * from the cloud because it depends on terrain alignment and on which part
   * is selected, both of which settle after the points do.
   */
  setDifferences(differences: Float32Array | null): void {
    this.differences = differences ?? new Float32Array();
    // Only this buffer changed: positions, colours, heights and links are the
    // same points, and re-sending all of them on every sibling selection would
    // push tens of megabytes for nothing.
    this.uploadDifferences();
    this.refitRamp();
    this.map?.triggerRepaint();
  }

  /** Hide the links to read the bare dots; the colours are unaffected. */
  setLinksVisible(linksVisible: boolean): void {
    this.linksVisible = linksVisible;
    this.map?.triggerRepaint();
  }

  setColourMode(mode: LidarColourMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // The raster costs a pass over the cloud, so it is built when it is first
    // looked at rather than on every selection.
    if (mode === "surface") this.ensureGrid();
    this.refitRamp();
    this.map?.triggerRepaint();
  }

  /** Build the outline's cell raster and hand it to the GPU, once per cloud. */
  private ensureGrid(): void {
    const gl = this.gl;
    if (this.gridQuadReady || !gl || !this.cloud || this.footprint.length === 0) return;
    const grid = buildSurfaceGrid(this.cloud, this.footprint);
    if (!grid) return;

    if (!this.gridTexture) this.gridTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gridTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      grid.columns,
      grid.rows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(surfaceGridImage(grid).buffer),
    );
    // Nearest keeps the half-metre cells as crisp squares at any zoom.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Two triangles over the raster's corners, in the same origin-relative
    // Mercator frame as the points; x, y, u, v interleaved.
    const quad = new Float32Array(24);
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const [slot, corner] of [0, 1, 2, 0, 2, 3].entries()) {
      const [x, y] = toMercator(grid.corners[corner][0], grid.corners[corner][1]);
      quad[slot * 4] = x - this.originX;
      quad[slot * 4 + 1] = y - this.originY;
      quad[slot * 4 + 2] = uv[corner][0];
      quad[slot * 4 + 3] = uv[corner][1];
    }
    if (!this.gridQuadBuffer) this.gridQuadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Recommended separation lines, as thin world-space quads over the cells:
    // bright where the detector would accept, faint where it asks for review.
    const HALF_WIDTH_M = 0.22;
    const STYLE = {
      accept: [1.0, 0.0, 0.88, 0.92],
      review: [1.0, 0.62, 0.98, 0.5],
    } as const;
    const vertices: number[] = [];
    for (const line of recommendSeparationLines(grid)) {
      if (line.recommendation === "ignore") continue;
      const colour = STYLE[line.recommendation];
      const rad = (line.phiDeg * Math.PI) / 180;
      const dir = [Math.cos(rad), Math.sin(rad)];
      const normal = [-Math.sin(rad), Math.cos(rad)];
      const segments = line.spans.length > 0 ? line.spans : [line.extent];
      for (const [s0, s1] of segments) {
        if (s1 - s0 < 0.5) continue;
        const corner = (s: number, side: number) => {
          const u = s * dir[0] + (line.t + side * HALF_WIDTH_M) * normal[0];
          const v = s * dir[1] + (line.t + side * HALF_WIDTH_M) * normal[1];
          const [lon, lat] = gridToLonLat(grid.frame, u, v);
          const [x, y] = toMercator(lon, lat);
          return [x - this.originX, y - this.originY];
        };
        const a = corner(s0, -1);
        const b = corner(s1, -1);
        const c = corner(s1, 1);
        const d = corner(s0, 1);
        for (const [x, y] of [a, b, c, a, c, d]) vertices.push(x, y, ...colour);
      }
    }
    this.edgeVertexCount = vertices.length / 6;
    if (!this.edgeBuffer) this.edgeBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.gridQuadReady = true;
  }

  /** Refit the ramp, but only while it is the thing being looked at. */
  private refitRamp(): void {
    if (!this.visible) return;
    if (this.mode === "height") this.refreshHeightRange();
    if (this.mode === "diff") this.refreshDifferenceRange();
  }

  /**
   * Fit the ramp to the heights inside the current viewport, so the colours
   * spread over whatever is actually being looked at rather than over the
   * whole padded cloud — a flat courtyard next to a tower would otherwise be
   * a single shade. Recomputed once a movement settles, never per frame.
   */
  private refreshHeightRange(): void {
    if (!this.lonLat || this.pointCount === 0) {
      this.rampRange = [0, 1];
      return;
    }
    let low = Infinity;
    let high = -Infinity;
    this.eachPointInView((index) => {
      const height = this.heights[index];
      if (height < low) low = height;
      if (height > high) high = height;
    });
    // Nothing in view keeps the previous ramp rather than collapsing it, and a
    // perfectly flat selection still needs a non-zero span to divide by.
    if (low === Infinity) return;
    this.rampRange = [low, high - low > 0.01 ? high : low + 0.01];
    this.map?.triggerRepaint();
  }

  /**
   * The difference ramp is symmetric about zero on a fixed metre scale, so a
   * colour always means the same disagreement and zero always means agreement.
   */
  private refreshDifferenceRange(): void {
    this.rampRange = [-DIFFERENCE_FULL_SCALE_M, DIFFERENCE_FULL_SCALE_M];
  }

  /** Visit the points inside the current viewport, in index order. */
  private eachPointInView(visit: (index: number) => void): void {
    const cloud = this.lonLat;
    if (!cloud) return;
    const view = this.map?.getBounds();
    const west = view?.getWest() ?? -Infinity;
    const east = view?.getEast() ?? Infinity;
    const south = view?.getSouth() ?? -Infinity;
    const north = view?.getNorth() ?? Infinity;
    for (let index = 0; index < this.pointCount; index++) {
      const lon = cloud.lon[index];
      if (lon < west || lon > east) continue;
      const lat = cloud.lat[index];
      if (lat < south || lat > north) continue;
      visit(index);
    }
  }

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;

    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
      uniform mat4 u_matrix;
      uniform float u_point_size;
      // 0 = survey colour, 1 = height ramp, 2 = OSM difference. The surface
      // mode draws a textured quad through its own program instead.
      uniform int u_mode;
      uniform vec2 u_ramp_range;
      in vec2 a_position;
      in vec3 a_colour;
      in float a_height;
      in vec2 a_difference;
      out vec3 v_colour;

      /** Pure hue, with the angle given in sixths of a turn from red. */
      vec3 hue_to_rgb(float sixths) {
        vec3 channels = abs(mod(sixths + vec3(0.0, 4.0, 2.0), 6.0) - 3.0);
        return clamp(channels - 1.0, 0.0, 1.0);
      }

      // Violet at 0 through blue, green and yellow to red at 1: a full hue
      // sweep gives the eye more steps to read a value with than any two-colour
      // ramp.
      vec3 violet_to_red(float t) {
        return hue_to_rgb((1.0 - clamp(t, 0.0, 1.0)) * 270.0 / 60.0);
      }

      /** A hue at a given saturation and brightness. Hue in sixths, as above. */
      vec3 hsv(float sixths, float saturation, float value) {
        return ((hue_to_rgb(sixths) - 1.0) * saturation + 1.0) * value;
      }

      /**
       * Agreement with the model, on its own palette rather than the height
       * ramp, because the reading that matters here is a sign and not a
       * magnitude.
       *
       * Colour is spent in proportion to how much there is to say. Around zero
       * everything is nearly grey, so the centimetre-scale disagreement that
       * covers most of a scene stops competing for attention, and the strength
       * only builds as the gap does.
       *
       * The two signs get opposite halves of the wheel, so which way a point
       * disagrees is legible before any magnitude is read: warm above the model
       * — grey-green through yellow to red — and cold below it, grey-blue
       * through blue to violet. The cold side keeps a floor of saturation that
       * the warm side does not, so the boundary where points pass under a roof
       * reads as a clean edge instead of fading out through the same grey.
       */
      vec3 difference_ramp(float metres, float extent) {
        float t = clamp(abs(metres) / max(extent, 0.01), 0.0, 1.0);
        if (metres < 0.0) {
          return hsv(mix(3.6, 4.8, t), 0.26 + 0.52 * t, 0.84 - 0.18 * t);
        }
        return hsv(mix(2.0, 0.0, t), 0.10 + 0.85 * t, 0.74 + 0.26 * t);
      }

      // The ramps are written in sRGB, but v_colour carries linear values all
      // the way to the fragment shader, which converts once at the end.
      vec3 srgb_to_linear(vec3 value) {
        bvec3 cutoff = lessThanEqual(value, vec3(0.04045));
        vec3 lower = value / 12.92;
        vec3 upper = pow((value + 0.055) / 1.055, vec3(2.4));
        return mix(upper, lower, cutoff);
      }

      void main() {
        gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        gl_PointSize = u_point_size;
        float span = max(u_ramp_range.y - u_ramp_range.x, 0.01);
        if (u_mode == 1) {
          v_colour = srgb_to_linear(violet_to_red((a_height - u_ramp_range.x) / span));
        } else if (u_mode == 2) {
          // Nothing modelled under this point, so there is nothing for it to
          // agree or disagree with. Grey says that, where any ramp colour would
          // claim a measurement that was never made.
          if (a_difference.y < 0.5) {
            v_colour = srgb_to_linear(vec3(0.30));
          } else {
            v_colour = srgb_to_linear(difference_ramp(a_difference.x, u_ramp_range.y));
          }
        } else {
          v_colour = a_colour;
        }
      }`,
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform float u_is_point;
      in vec3 v_colour;
      out vec4 frag_colour;

      vec3 linear_to_srgb(vec3 value) {
        bvec3 cutoff = lessThanEqual(value, vec3(0.0031308));
        vec3 lower = value * 12.92;
        vec3 upper = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
        return mix(upper, lower, cutoff);
      }

      void main() {
        // gl_PointCoord is only defined while drawing points; the round mask
        // has to be skipped when the same program draws the links.
        if (u_is_point > 0.5 && distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
        float alpha = u_is_point > 0.5 ? 0.94 : 0.35;
        frag_colour = vec4(linear_to_srgb(v_colour) * alpha, alpha);
      }`,
    );

    const program = gl.createProgram();
    if (!program) throw new Error("Could not create LiDAR map program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? "Unknown shader link error";
      gl.deleteProgram(program);
      throw new Error(`Could not link LiDAR map program: ${message}`);
    }

    this.program = program;
    this.matrixLocation = gl.getUniformLocation(program, "u_matrix");
    this.pointSizeLocation = gl.getUniformLocation(program, "u_point_size");
    this.isPointLocation = gl.getUniformLocation(program, "u_is_point");
    this.modeLocation = gl.getUniformLocation(program, "u_mode");
    this.rampRangeLocation = gl.getUniformLocation(program, "u_ramp_range");
    this.vertexArray = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer();
    this.colourBuffer = gl.createBuffer();
    this.heightBuffer = gl.createBuffer();
    this.differenceBuffer = gl.createBuffer();
    this.linkBuffer = gl.createBuffer();

    gl.bindVertexArray(this.vertexArray);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    const colourLocation = gl.getAttribLocation(program, "a_colour");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colourBuffer);
    gl.enableVertexAttribArray(colourLocation);
    gl.vertexAttribPointer(colourLocation, 3, gl.FLOAT, false, 0, 0);
    const heightLocation = gl.getAttribLocation(program, "a_height");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heightBuffer);
    gl.enableVertexAttribArray(heightLocation);
    gl.vertexAttribPointer(heightLocation, 1, gl.FLOAT, false, 0, 0);
    const differenceLocation = gl.getAttribLocation(program, "a_difference");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.differenceBuffer);
    gl.enableVertexAttribArray(differenceLocation);
    gl.vertexAttribPointer(differenceLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.linkBuffer);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // A second, tiny program for the grid mode's textured quad.
    const gridVertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
      uniform mat4 u_matrix;
      in vec2 a_position;
      in vec2 a_uv;
      out vec2 v_uv;
      void main() {
        gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        v_uv = a_uv;
      }`,
    );
    const gridFragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform sampler2D u_cells;
      in vec2 v_uv;
      out vec4 frag_colour;
      void main() {
        vec4 cell = texture(u_cells, v_uv);
        if (cell.a < 0.01) discard;
        frag_colour = vec4(cell.rgb * cell.a, cell.a);
      }`,
    );
    const gridProgram = gl.createProgram();
    if (!gridProgram) throw new Error("Could not create LiDAR grid program");
    gl.attachShader(gridProgram, gridVertex);
    gl.attachShader(gridProgram, gridFragment);
    gl.linkProgram(gridProgram);
    gl.deleteShader(gridVertex);
    gl.deleteShader(gridFragment);
    if (!gl.getProgramParameter(gridProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(gridProgram) ?? "Unknown shader link error";
      gl.deleteProgram(gridProgram);
      throw new Error(`Could not link LiDAR grid program: ${message}`);
    }
    this.gridProgram = gridProgram;
    this.gridMatrixLocation = gl.getUniformLocation(gridProgram, "u_matrix");
    this.gridQuadBuffer = gl.createBuffer();
    this.edgeBuffer = gl.createBuffer();
    this.gridVertexArray = gl.createVertexArray();
    gl.bindVertexArray(this.gridVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridQuadBuffer);
    const gridPosition = gl.getAttribLocation(gridProgram, "a_position");
    gl.enableVertexAttribArray(gridPosition);
    gl.vertexAttribPointer(gridPosition, 2, gl.FLOAT, false, 16, 0);
    const gridUv = gl.getAttribLocation(gridProgram, "a_uv");
    gl.enableVertexAttribArray(gridUv);
    gl.vertexAttribPointer(gridUv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // A third micro-program for the separation lines' flat-coloured quads.
    const edgeVertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
      uniform mat4 u_matrix;
      in vec2 a_position;
      in vec4 a_colour;
      out vec4 v_colour;
      void main() {
        gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        v_colour = a_colour;
      }`,
    );
    const edgeFragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      in vec4 v_colour;
      out vec4 frag_colour;
      void main() {
        frag_colour = vec4(v_colour.rgb * v_colour.a, v_colour.a);
      }`,
    );
    const edgeProgram = gl.createProgram();
    if (!edgeProgram) throw new Error("Could not create LiDAR edge program");
    gl.attachShader(edgeProgram, edgeVertex);
    gl.attachShader(edgeProgram, edgeFragment);
    gl.linkProgram(edgeProgram);
    gl.deleteShader(edgeVertex);
    gl.deleteShader(edgeFragment);
    if (!gl.getProgramParameter(edgeProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(edgeProgram) ?? "Unknown shader link error";
      gl.deleteProgram(edgeProgram);
      throw new Error(`Could not link LiDAR edge program: ${message}`);
    }
    this.edgeProgram = edgeProgram;
    this.edgeMatrixLocation = gl.getUniformLocation(edgeProgram, "u_matrix");
    this.edgeVertexArray = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    const edgePosition = gl.getAttribLocation(edgeProgram, "a_position");
    gl.enableVertexAttribArray(edgePosition);
    gl.vertexAttribPointer(edgePosition, 2, gl.FLOAT, false, 24, 0);
    const edgeColour = gl.getAttribLocation(edgeProgram, "a_colour");
    gl.enableVertexAttribArray(edgeColour);
    gl.vertexAttribPointer(edgeColour, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.upload();
    if (this.mode === "surface") this.ensureGrid();
    // The ramp follows the viewport, so it is refitted when a movement settles
    // rather than on every frame of a pan.
    map.on("moveend", this.onMoveEnd);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || this.pointCount === 0 || !this.program || !this.vertexArray) return;
    if (this.mode === "surface") {
      this.renderGrid(gl, options);
      return;
    }
    // A full-world Mercator coordinate in a Float32 vertex buffer has only a
    // few meters of precision. Keep vertices local to the cloud and fold its
    // origin into MapLibre's matrix in JavaScript's double precision instead.
    const matrix = options.defaultProjectionData.mainMatrix;
    this.localizedMatrix.set(matrix);
    this.localizedMatrix[12] = matrix[0] * this.originX + matrix[4] * this.originY + matrix[12];
    this.localizedMatrix[13] = matrix[1] * this.originX + matrix[5] * this.originY + matrix[13];
    this.localizedMatrix[14] = matrix[2] * this.originX + matrix[6] * this.originY + matrix[14];
    this.localizedMatrix[15] = matrix[3] * this.originX + matrix[7] * this.originY + matrix[15];
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniformMatrix4fv(this.matrixLocation, false, this.localizedMatrix);
    gl.uniform1f(this.pointSizeLocation, Math.min(3, 1.5 * (globalThis.devicePixelRatio || 1)));
    gl.uniform1i(this.modeLocation, COLOUR_MODE_UNIFORM[this.mode]);
    gl.uniform2f(this.rampRangeLocation, this.rampRange[0], this.rampRange[1]);
    // The links go down first, so the points they connect stay readable on top.
    if (this.linksVisible && this.linkCount > 0) {
      gl.uniform1f(this.isPointLocation, 0);
      gl.drawElements(gl.LINES, this.linkCount * 2, gl.UNSIGNED_INT, 0);
    }
    gl.uniform1f(this.isPointLocation, 1);
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
    gl.bindVertexArray(null);
  }

  /** The grid mode draws one textured quad where the points would be. */
  private renderGrid(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.gridQuadReady || !this.gridProgram || !this.gridVertexArray) return;
    const matrix = options.defaultProjectionData.mainMatrix;
    this.localizedMatrix.set(matrix);
    this.localizedMatrix[12] = matrix[0] * this.originX + matrix[4] * this.originY + matrix[12];
    this.localizedMatrix[13] = matrix[1] * this.originX + matrix[5] * this.originY + matrix[13];
    this.localizedMatrix[14] = matrix[2] * this.originX + matrix[6] * this.originY + matrix[14];
    this.localizedMatrix[15] = matrix[3] * this.originX + matrix[7] * this.originY + matrix[15];
    gl.useProgram(this.gridProgram);
    gl.bindVertexArray(this.gridVertexArray);
    gl.uniformMatrix4fv(this.gridMatrixLocation, false, this.localizedMatrix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    if (this.edgeVertexCount > 0 && this.edgeProgram && this.edgeVertexArray) {
      gl.useProgram(this.edgeProgram);
      gl.bindVertexArray(this.edgeVertexArray);
      gl.uniformMatrix4fv(this.edgeMatrixLocation, false, this.localizedMatrix);
      gl.drawArrays(gl.TRIANGLES, 0, this.edgeVertexCount);
      gl.bindVertexArray(null);
    }
  }

  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    map.off("moveend", this.onMoveEnd);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.colourBuffer) gl.deleteBuffer(this.colourBuffer);
    if (this.heightBuffer) gl.deleteBuffer(this.heightBuffer);
    if (this.differenceBuffer) gl.deleteBuffer(this.differenceBuffer);
    if (this.linkBuffer) gl.deleteBuffer(this.linkBuffer);
    if (this.gridQuadBuffer) gl.deleteBuffer(this.gridQuadBuffer);
    if (this.edgeBuffer) gl.deleteBuffer(this.edgeBuffer);
    if (this.gridTexture) gl.deleteTexture(this.gridTexture);
    if (this.gridVertexArray) gl.deleteVertexArray(this.gridVertexArray);
    if (this.edgeVertexArray) gl.deleteVertexArray(this.edgeVertexArray);
    if (this.gridProgram) gl.deleteProgram(this.gridProgram);
    if (this.edgeProgram) gl.deleteProgram(this.edgeProgram);
    if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
    if (this.program) gl.deleteProgram(this.program);
    this.map = null;
    this.gl = null;
    this.program = null;
    this.vertexArray = null;
    this.positionBuffer = null;
    this.colourBuffer = null;
    this.heightBuffer = null;
    this.differenceBuffer = null;
    this.linkBuffer = null;
    this.gridProgram = null;
    this.gridVertexArray = null;
    this.gridQuadBuffer = null;
    this.gridTexture = null;
    this.edgeProgram = null;
    this.edgeVertexArray = null;
    this.edgeBuffer = null;
    this.edgeVertexCount = 0;
    this.gridQuadReady = false;
  }

  /**
   * A cloud can be on screen before its differences are computed, so a short
   * array is padded to a zero-filled one of the right size: every point's
   * `known` flag stays clear until the real values arrive, rather than the
   * shader reading past the end of the buffer.
   */
  private uploadDifferences(): void {
    const gl = this.gl;
    if (!gl || !this.differenceBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.differenceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.differences.length >= this.pointCount * 2
        ? this.differences
        : new Float32Array(this.pointCount * 2),
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private upload(): void {
    const gl = this.gl;
    if (!gl || !this.positionBuffer || !this.colourBuffer || !this.linkBuffer) return;
    if (!this.heightBuffer || !this.differenceBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colourBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colours, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heightBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.heights, gl.STATIC_DRAW);
    this.uploadDifferences();
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.linkBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.links, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
}
