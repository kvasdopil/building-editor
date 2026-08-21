import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MaplibreMap,
} from "maplibre-gl";
import type { LidarCloud } from "./lidar";

const MAX_MERCATOR_LATITUDE = 85.051129;

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
  private matrixLocation: WebGLUniformLocation | null = null;
  private pointSizeLocation: WebGLUniformLocation | null = null;
  private positions = new Float32Array();
  private colours: Float32Array<ArrayBufferLike> = new Float32Array();
  private pointCount = 0;
  private visible = false;
  private originX = 0;
  private originY = 0;
  private localizedMatrix = new Float32Array(16);

  setCloud(cloud: LidarCloud | null): void {
    this.pointCount = cloud?.count ?? 0;
    this.positions = new Float32Array(this.pointCount * 2);
    this.colours = cloud?.colours ?? new Float32Array();

    if (cloud) {
      [this.originX, this.originY] = toMercator(cloud.lon[0], cloud.lat[0]);
      for (let index = 0; index < cloud.count; index++) {
        const [x, y] = toMercator(cloud.lon[index], cloud.lat[index]);
        this.positions[index * 2] = x - this.originX;
        this.positions[index * 2 + 1] = y - this.originY;
      }
    } else {
      this.originX = 0;
      this.originY = 0;
    }

    this.upload();
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
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
      in vec2 a_position;
      in vec3 a_colour;
      out vec3 v_colour;

      void main() {
        gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        gl_PointSize = u_point_size;
        v_colour = a_colour;
      }`,
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      in vec3 v_colour;
      out vec4 frag_colour;

      vec3 linear_to_srgb(vec3 value) {
        bvec3 cutoff = lessThanEqual(value, vec3(0.0031308));
        vec3 lower = value * 12.92;
        vec3 upper = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
        return mix(upper, lower, cutoff);
      }

      void main() {
        if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
        float alpha = 0.94;
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
    this.vertexArray = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer();
    this.colourBuffer = gl.createBuffer();

    gl.bindVertexArray(this.vertexArray);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    const colourLocation = gl.getAttribLocation(program, "a_colour");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colourBuffer);
    gl.enableVertexAttribArray(colourLocation);
    gl.vertexAttribPointer(colourLocation, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.upload();
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
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
    gl.bindVertexArray(null);
  }

  onRemove(_map: MaplibreMap, gl: WebGL2RenderingContext): void {
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.colourBuffer) gl.deleteBuffer(this.colourBuffer);
    if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
    if (this.program) gl.deleteProgram(this.program);
    this.map = null;
    this.gl = null;
    this.program = null;
    this.vertexArray = null;
    this.positionBuffer = null;
    this.colourBuffer = null;
  }

  private upload(): void {
    const gl = this.gl;
    if (!gl || !this.positionBuffer || !this.colourBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colourBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colours, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
}
