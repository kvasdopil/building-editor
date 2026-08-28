import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MaplibreMap,
} from "maplibre-gl";
import type { LidarCloud } from "./lidar";

/**
 * What a dot's colour means. `colour` shows the survey's own orthophoto sample,
 * `height` replaces it with a rainbow ramp over the heights currently in view,
 * which reads relief and roof shape that the flat top-down view otherwise hides,
 * `normal` colours by how steeply each link rises — violet lying flat through
 * to red standing vertical — and `diff` by how far each point sits above or
 * below the roof this app models from the OSM tags.
 */
export type LidarColourMode = "colour" | "height" | "normal" | "diff";

/** How each mode reaches the shader's `u_mode`. */
const COLOUR_MODE_UNIFORM: Record<LidarColourMode, number> = {
  colour: 0,
  height: 1,
  normal: 2,
  diff: 3,
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

/**
 * The angle each link makes with the horizontal, in radians from 0 to PI/2.
 *
 * This is the plain inclination of the step from the previous stored point to
 * this one: level along the ground is 0, straight up a wall is PI/2. It is
 * carried per point rather than per link because points and links share one
 * vertex buffer, so a point takes the angle of the link arriving at it and a
 * drawn link is exact at its far end and blends toward the previous link's
 * angle at its near end. Points with no link before them are left at 0.
 */
function linkInclinations(count: number, steps: Float32Array): Float32Array {
  const inclinations = new Float32Array(count);
  for (let index = 1; index < count; index++) {
    const east = steps[index * 3];
    if (Number.isNaN(east)) continue;
    const north = steps[index * 3 + 1];
    const up = steps[index * 3 + 2];
    inclinations[index] = Math.atan2(Math.abs(up), Math.hypot(east, north));
  }
  return inclinations;
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
  private inclineBuffer: WebGLBuffer | null = null;
  private differenceBuffer: WebGLBuffer | null = null;
  private modeLocation: WebGLUniformLocation | null = null;
  private rampRangeLocation: WebGLUniformLocation | null = null;
  private positions = new Float32Array();
  private colours: Float32Array<ArrayBufferLike> = new Float32Array();
  private heights: Float32Array<ArrayBufferLike> = new Float32Array();
  private inclinations: Float32Array<ArrayBufferLike> = new Float32Array();
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
  private onMoveEnd = () => this.refitRamp();
  private originX = 0;
  private originY = 0;
  private localizedMatrix = new Float32Array(16);

  setCloud(cloud: LidarCloud | null): void {
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
      const steps = metricSteps(cloud);
      this.links = linkNeighbours(cloud.count, steps);
      this.inclinations = linkInclinations(cloud.count, steps);
    } else {
      this.originX = 0;
      this.originY = 0;
      this.links = new Uint32Array();
      this.inclinations = new Float32Array();
      this.differences = new Float32Array();
    }
    this.linkCount = this.links.length / 2;

    this.upload();
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
    this.refitRamp();
    this.map?.triggerRepaint();
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
      // 0 = survey colour, 1 = height ramp, 2 = link angle, 3 = OSM difference.
      uniform int u_mode;
      uniform vec2 u_ramp_range;
      in vec2 a_position;
      in vec3 a_colour;
      in float a_height;
      in float a_incline;
      in vec2 a_difference;
      out vec3 v_colour;

      /** Pure hue, with the angle given in sixths of a turn from red. */
      vec3 hue_to_rgb(float sixths) {
        vec3 channels = abs(mod(sixths + vec3(0.0, 4.0, 2.0), 6.0) - 3.0);
        return clamp(channels - 1.0, 0.0, 1.0);
      }

      // Violet at 0 through blue, green and yellow to red at 1: a full hue
      // sweep gives the eye more steps to read a value with than any two-colour
      // ramp. Height and link angle both run through it.
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
        } else if (u_mode == 3) {
          // Nothing modelled under this point, so there is nothing for it to
          // agree or disagree with. Grey says that, where any ramp colour would
          // claim a measurement that was never made.
          if (a_difference.y < 0.5) {
            v_colour = srgb_to_linear(vec3(0.30));
          } else {
            v_colour = srgb_to_linear(difference_ramp(a_difference.x, u_ramp_range.y));
          }
        } else if (u_mode == 2) {
          v_colour = srgb_to_linear(violet_to_red(a_incline / ${(Math.PI / 2).toFixed(8)}));
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
    this.inclineBuffer = gl.createBuffer();
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
    const inclineLocation = gl.getAttribLocation(program, "a_incline");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inclineBuffer);
    gl.enableVertexAttribArray(inclineLocation);
    gl.vertexAttribPointer(inclineLocation, 1, gl.FLOAT, false, 0, 0);
    const differenceLocation = gl.getAttribLocation(program, "a_difference");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.differenceBuffer);
    gl.enableVertexAttribArray(differenceLocation);
    gl.vertexAttribPointer(differenceLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.linkBuffer);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.upload();
    // The ramp follows the viewport, so it is refitted when a movement settles
    // rather than on every frame of a pan.
    map.on("moveend", this.onMoveEnd);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || this.pointCount === 0 || !this.program || !this.vertexArray) return;
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

  onRemove(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    map.off("moveend", this.onMoveEnd);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.colourBuffer) gl.deleteBuffer(this.colourBuffer);
    if (this.heightBuffer) gl.deleteBuffer(this.heightBuffer);
    if (this.inclineBuffer) gl.deleteBuffer(this.inclineBuffer);
    if (this.differenceBuffer) gl.deleteBuffer(this.differenceBuffer);
    if (this.linkBuffer) gl.deleteBuffer(this.linkBuffer);
    if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
    if (this.program) gl.deleteProgram(this.program);
    this.map = null;
    this.gl = null;
    this.program = null;
    this.vertexArray = null;
    this.positionBuffer = null;
    this.colourBuffer = null;
    this.heightBuffer = null;
    this.inclineBuffer = null;
    this.differenceBuffer = null;
    this.linkBuffer = null;
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
    if (!this.heightBuffer || !this.inclineBuffer || !this.differenceBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colourBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colours, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heightBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.heights, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inclineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.inclinations, gl.STATIC_DRAW);
    this.uploadDifferences();
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.linkBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.links, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
}
