/**
 * The Aeroplane artwork: an airliner made of light, drawn with WebGL into the
 * given canvas. The aircraft is modelled here in code, as lofted surfaces, and
 * its surface sampled into particles, so nothing has to be downloaded. It
 * cruises on black with its contrails running away behind it, through a thin
 * stream of air that carries each band's color to the edges of the screen.
 *
 * The screen is divided into its bands, side by side, and every particle takes
 * the color for the temperature of the band it's in at that moment, so one
 * blown back across a band's edge changes color as it crosses. Near an edge the
 * two bands' particles are scattered among each other, so the colors meet softly
 * while each particle stays pure. Each band's wind
 * picks its part of the aircraft apart: in still air it holds its shape, and
 * the windier the city the more of it streams away, and the further.
 *
 * `getBands` returns one { tempC, windKph } per band, or nothing for a band
 * whose weather hasn't arrived yet. Read from CSS on the canvas: --art-rows
 * (1 when the bands are stacked as rows, as on phones).
 */
import { tintFor } from "./particleArt.js";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MAX_BANDS = 5;
const WAITING_COLOR = [150, 156, 170];

// Wind speed (km/h) at which a band is fully blown apart.
const FULL_WIND_KPH = 40;
const SURFACE_PARTICLES = 240000;
const CONTRAIL_PARTICLES = 40000;
const AIR_PARTICLES = 170000;
const FLOATS = 9; // per particle: position 3, normal 3, randoms 2, kind 1
const KIND = { surface: 0, light: 1, contrail: 2, air: 3 };

const FOV = (22 * Math.PI) / 180;
const DISTANCE = 3.4; // from the aircraft, on a wide screen
// Narrower than this and the camera backs off so the wings still fit.
const FIT_ASPECT = 1.72;
const EYE_DIRECTION = [0.36, 0.13, 0.92]; // off the right wing, a little ahead and above
// How far down the screen the aircraft sits, in half-screens, to clear the top
// strip and the clock faces hanging out of it.
const SHIFT_DOWN = 0.07;
// When the bands are stacked as rows, the view rolls so that the aircraft climbs
// up through all of them, and the camera backs off to fit it down the screen.
const ROWS_ROLL = (66 * Math.PI) / 180;
const ROWS_DISTANCE = 5;

// The aircraft, nose along +x, up +y, right wing +z, about 2 units long.
const BODY_RADIUS = 0.1;
const NOSE_START = 0.72;
const TAIL_START = -0.3;
const ENGINE_Y = -0.125;
const ENGINE_Z = 0.34;

function bodyRadius(x) {
  if (x > NOSE_START) {
    const k = (x - NOSE_START) / (1 - NOSE_START);
    return BODY_RADIUS * Math.max(1 - k ** 2.3, 0) ** 0.55;
  }
  if (x < TAIL_START) return BODY_RADIUS * (1 - 0.9 * ((TAIL_START - x) / (TAIL_START + 1)) ** 1.5);
  return BODY_RADIUS;
}

// The body's centre line: the nose droops, and the tail sweeps up.
function bodyCenter(x) {
  if (x > NOSE_START) return -0.28 * BODY_RADIUS * ((x - NOSE_START) / (1 - NOSE_START)) ** 2;
  if (x < TAIL_START) return (BODY_RADIUS - bodyRadius(x)) * 0.92;
  return 0;
}

const bodyPoint = (x, angle) => {
  const r = bodyRadius(x);
  return [x, bodyCenter(x) + r * Math.sin(angle), r * Math.cos(angle)];
};

// Half a wing section's thickness, s of the way along its chord (NACA 4-digit).
const airfoil = (s, t) =>
  5 * t * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s ** 2 + 0.2843 * s ** 3 - 0.1015 * s ** 4);

// A wing, tail or pylon: a closed ring of airfoil section at each station,
// running back from the leading edge at { x, y, z } for `c`, thickened along
// `axis` (1 for a flat surface, 2 for an upright one).
function airfoilRings(stations, axis, thickness) {
  const samples = 16;
  return stations.map(({ x, y, z, c }) => {
    const ring = [];
    for (let side = 1; side >= -1; side -= 2) {
      for (let i = 0; i < samples; i++) {
        const k = i / (samples - 1);
        // Upper surface forward to back, then lower surface back to forward.
        const s = (1 - Math.cos(Math.PI * (side > 0 ? k : 1 - k))) / 2;
        const point = [x - c * s, y, z];
        point[axis] += side * c * airfoil(s, thickness);
        ring.push(point);
      }
    }
    return ring;
  });
}

const mirrored = (stations) => stations.map((s) => ({ ...s, z: -s.z }));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalized = (a) => {
  const l = Math.hypot(...a) || 1;
  return a.map((v) => v / l);
};

// Skins a run of closed rings in triangles, each with its area and a normal
// turned to face away from the middle of its ring.
function skin(rings) {
  const triangles = [];
  for (let r = 0; r + 1 < rings.length; r++) {
    const ring = rings[r];
    const next = rings[r + 1];
    const middle = ring.reduce((sum, p) => sum.map((v, i) => v + p[i] / ring.length), [0, 0, 0]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      for (const [a, b, c] of [[ring[i], ring[j], next[j]], [ring[i], next[j], next[i]]]) {
        const n = cross(sub(b, a), sub(c, a));
        const area = Math.hypot(...n) / 2;
        if (area < 1e-9) continue;
        const outward = dot(n, sub(a, middle)) < 0 ? -1 : 1;
        triangles.push({ a, b, c, area, normal: normalized(n).map((v) => v * outward) });
      }
    }
  }
  return triangles;
}

function aircraftSurfaces() {
  const stations = 72;
  const segments = 32;
  const body = Array.from({ length: stations + 1 }, (_, i) => {
    const x = -Math.cos((Math.PI * i) / stations);
    return Array.from({ length: segments }, (_, j) => bodyPoint(x, (2 * Math.PI * j) / segments));
  });

  const wing = [
    { x: 0.27, y: -0.07, z: 0, c: 0.62 },
    { x: 0.2, y: -0.062, z: 0.11, c: 0.52 },
    { x: 0.04, y: -0.03, z: 0.37, c: 0.27 },
    { x: -0.28, y: 0.045, z: 0.98, c: 0.085 },
  ];
  const winglet = [
    { x: -0.28, y: 0.045, z: 0.98, c: 0.085 },
    { x: -0.345, y: 0.17, z: 1.01, c: 0.036 },
  ];
  const stabilizer = [
    { x: -0.7, y: 0.07, z: 0, c: 0.2 },
    { x: -0.92, y: 0.115, z: 0.37, c: 0.075 },
  ];
  const fin = [
    { x: -0.5, y: 0.07, z: 0, c: 0.44 },
    { x: -0.6, y: 0.12, z: 0, c: 0.34 },
    { x: -0.9, y: 0.47, z: 0, c: 0.12 },
  ];
  const pylon = [
    { x: 0.12, y: -0.08, z: 0.34, c: 0.2 },
    { x: 0.12, y: -0.02, z: 0.34, c: 0.26 },
  ];

  const engine = (z) => {
    const profile = [[0.2, 0.002], [0.199, 0.03], [0.195, 0.05], [0.185, 0.059], [0.165, 0.063], [0.08, 0.066], [0, 0.058], [-0.07, 0.036], [-0.12, 0.012]];
    return profile.map(([x, r]) =>
      Array.from({ length: segments }, (_, j) => {
        const a = (2 * Math.PI * j) / segments;
        return [x, ENGINE_Y + r * Math.sin(a), z + r * Math.cos(a)];
      }),
    );
  };

  return [
    skin(body),
    skin(airfoilRings(wing, 1, 0.13)),
    skin(airfoilRings(mirrored(wing), 1, 0.13)),
    skin(airfoilRings(winglet, 2, 0.1)),
    skin(airfoilRings(mirrored(winglet), 2, 0.1)),
    skin(airfoilRings(stabilizer, 1, 0.1)),
    skin(airfoilRings(mirrored(stabilizer), 1, 0.1)),
    skin(airfoilRings(fin, 2, 0.1)),
    skin(airfoilRings(pylon, 2, 0.1)),
    skin(airfoilRings(mirrored(pylon), 2, 0.1)),
    skin(engine(ENGINE_Z)),
    skin(engine(-ENGINE_Z)),
  ].flat();
}

// Where the trails start: behind the engines, and at the winglets.
const EMITTERS = [
  { at: [-0.13, ENGINE_Y, ENGINE_Z], spread: 0.022, share: 0.42 },
  { at: [-0.13, ENGINE_Y, -ENGINE_Z], spread: 0.022, share: 0.42 },
  { at: [-0.36, 0.17, 1.01], spread: 0.016, share: 0.08 },
  { at: [-0.36, 0.17, -1.01], spread: 0.016, share: 0.08 },
];

// The cockpit's windscreen, left dark.
function inWindscreen([x, y, z]) {
  if (x < 0.84 || x > 0.9) return false;
  const up = (y - bodyCenter(x)) / bodyRadius(x);
  // Raked back, and split down the middle.
  return up > 0.3 && up < 0.72 - (0.9 - x) * 3 && Math.abs(z) > 0.006;
}

// Every particle, in one interleaved array. Built once and kept, as it never changes.
let cloud;
function buildCloud() {
  if (cloud) return cloud;

  const triangles = aircraftSurfaces();
  let total = 0;
  const running = triangles.map((t) => (total += t.area));
  const pick = (r) => {
    let low = 0;
    let high = running.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (running[mid] < r) low = mid + 1;
      else high = mid;
    }
    return triangles[low];
  };

  const lights = [];
  const windowCount = 54;
  for (const side of [1, -1]) {
    for (let i = 0; i < windowCount; i++) {
      const x = 0.68 - (i / (windowCount - 1)) * 1.12;
      lights.push({ point: bodyPoint(x, side > 0 ? 0.42 : Math.PI - 0.42), normal: [0, 0.42, side], size: 0.0035 });
    }
  }

  const perLight = 8;
  const particles = SURFACE_PARTICLES + lights.length * perLight + CONTRAIL_PARTICLES + AIR_PARTICLES;
  const data = new Float32Array(particles * FLOATS);
  let count = 0;
  const put = (position, normal, kind) => {
    data.set([...position, ...normal, Math.random(), Math.random(), kind], count * FLOATS);
    count++;
  };

  while (count < SURFACE_PARTICLES) {
    const { a, b, c, normal } = pick(Math.random() * total);
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    const point = a.map((p, i) => p + (b[i] - p) * u + (c[i] - p) * v);
    if (!inWindscreen(point)) put(point, normal, KIND.surface);
  }

  for (const { point, normal, size } of lights) {
    for (let i = 0; i < perLight; i++) {
      put(point.map((v) => v + (Math.random() - 0.5) * size), normalized(normal), KIND.light);
    }
  }

  // A contrail's "normal" is the way its particle drifts off the trail's line.
  for (const { at, spread, share } of EMITTERS) {
    for (let i = 0; i < CONTRAIL_PARTICLES * share; i++) {
      const drift = normalized([0, Math.random() - 0.5, Math.random() - 0.5]).map((v) => v * spread * Math.sqrt(Math.random()));
      put(at, drift, KIND.contrail);
    }
  }

  // The air, thickest at the aircraft's height and thinning above and below it.
  for (let i = 0; i < AIR_PARTICLES; i++) {
    const height = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    put([0, height * 0.33, 1.2 - Math.random() * 4.6], [0, 0, 0], KIND.air);
  }

  cloud = { data: data.subarray(0, count * FLOATS), count };
  return cloud;
}

const VERTEX = /* glsl */ `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec2 aRand;
  attribute float aKind;
  uniform mat4 uViewProjection;
  uniform mat3 uModel;
  uniform vec3 uEye;
  uniform float uTime;
  uniform float uCount; // how many bands there are
  uniform float uRows; // 1 when the bands are stacked as rows
  uniform float uPoint; // a particle's size, in the screen's own pixels
  uniform float uShift; // how far down the screen the aircraft sits
  uniform vec3 uColors[${MAX_BANDS}]; // each band's tint, 0–1
  uniform float uWinds[${MAX_BANDS}]; // each band's wind, 0–1
  varying vec3 vColor;
  varying float vAlpha;

  const vec3 LIGHT = vec3(0.32, 0.86, 0.4);
  const float CONTRAIL_LENGTH = 9.0;
  const float AIR_LENGTH = 6.0;
  const float SEAM = 0.055; // how far the bands' particles mix past an edge, in screens

  vec4 project(vec3 world) {
    vec4 clip = uViewProjection * vec4(world, 1.0);
    clip.y -= uShift * clip.w;
    return clip;
  }

  // Which band a point falls in on the screen. Each particle reads the edges
  // as a little to one side, its own way, more often slightly than far.
  int bandAt(vec4 clip) {
    vec2 screen = clip.xy / clip.w * 0.5 + 0.5;
    float along = uRows > 0.5 ? 1.0 - screen.y : screen.x;
    along += (fract(aRand.x * 91.7) + fract(aRand.y * 57.3) - 1.0) * SEAM;
    return int(clamp(floor(along * uCount), 0.0, uCount - 1.0));
  }

  void main() {
    bool contrail = aKind > 1.5 && aKind < 2.5;
    bool air = aKind > 2.5;
    float life = contrail
      ? fract(aRand.x + uTime * (0.05 + 0.012 * aRand.y))
      : air
        ? fract(aRand.x + uTime * (0.045 + 0.02 * aRand.y))
        : fract(aRand.x * 37.0 + uTime * (0.1 + 0.16 * aRand.y));

    // The wind that moves a particle is that of the band it sets out from.
    vec3 position = aPosition;
    if (contrail) position.x -= life * life * CONTRAIL_LENGTH + life * 0.4;
    if (air) position.x += AIR_LENGTH * (0.5 - life);
    float wind = uWinds[bandAt(project(uModel * position))];

    vec3 normal = uModel * aNormal;
    float alpha;
    float light;
    float size = 1.0 + 0.7 * aRand.y;

    if (air) {
      // Fuller ahead of the wings, where nothing is shed to fill the screen,
      // and gone before it wraps around.
      alpha = (0.5 + 0.3 * wind) * mix(0.32, 1.0, smoothstep(-1.1, 0.7, position.x))
        * smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.92, 1.0, life));
      light = 0.62 + 0.3 * aRand.y;
    } else if (contrail) {
      // The trail fans out as it ages, wider in a stronger wind.
      position += aNormal * (1.0 + (10.0 + 34.0 * wind) * sqrt(life));
      position.y -= life * life * 0.3;
      alpha = smoothstep(0.0, 0.015, life) * pow(1.0 - life, 2.2) * 0.62;
      light = 0.72;
      size *= 1.0 + 0.5 * life;
    } else {
      vec3 toEye = normalize(uEye - uModel * position);
      float facing = dot(normal, toEye);
      float sun = max(dot(normal, normalize(LIGHT)), 0.0);
      float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
      light = 0.14 + 0.62 * sun + 0.34 * max(facing, 0.0) + 0.4 * rim;
      alpha = smoothstep(-0.08, 0.22, facing) * (0.5 + 0.5 * smoothstep(0.0, 0.5, light));

      // A share of the surface comes away, more of it towards the tail, and
      // more and further the windier the band. The rest stays put.
      if (aKind < 0.5) {
        float taper = mix(0.85, 1.5, smoothstep(0.9, -1.0, aPosition.x));
        if (aRand.y < (0.07 + 0.62 * wind) * taper) {
          float flight = (0.8 + 3.3 * wind) * life * (0.4 + 0.6 * life);
          position.x -= flight;
          position.y += (sin(life * 7.0 + aRand.x * 40.0) * 0.06 + 0.02) * flight;
          position.z += sin(life * 5.0 + aRand.x * 90.0) * 0.07 * flight;
          alpha = mix(alpha, 0.6, smoothstep(0.0, 0.1, life)) * (1.0 - life);
        }
      } else {
        // Cabin windows, lit from within.
        light = 1.3;
        alpha = smoothstep(0.0, 0.3, facing);
        size *= 1.5;
      }
    }

    gl_Position = project(uModel * position);

    // The color of the band it's in now, wherever it came from, carried by the
    // light and washing out toward white at its brightest.
    vColor = uColors[bandAt(gl_Position)] * (0.3 + 0.95 * light);
    vColor = mix(vColor, vec3(1.0), smoothstep(0.85, 1.3, light) * 0.6);
    vAlpha = alpha;

    gl_PointSize = uPoint * size * (${DISTANCE.toFixed(1)} / gl_Position.w);
    // Trails running close past the camera mustn't swell into blobs.
    gl_PointSize = min(gl_PointSize, uPoint * 3.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float alpha = vAlpha * smoothstep(0.5, 0.2, d);
    gl_FragColor = vec4(vColor * alpha, alpha * 0.82); // premultiplied, and a little additive
  }
`;

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

// The view from `eye` toward the origin, y up.
function lookAtOrigin(eye) {
  const back = normalized(eye);
  const right = normalized(cross([0, 1, 0], back));
  const up = cross(back, right);
  return [
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ];
}

const rolled = (angle) => {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

// The aircraft's attitude: pitched about its wings, then banked about its body.
function attitude(pitch, bank) {
  const [cp, sp, cb, sb] = [Math.cos(pitch), Math.sin(pitch), Math.cos(bank), Math.sin(bank)];
  return new Float32Array([cp, sp, 0, -sp * cb, cp * cb, sb, sp * sb, -cp * sb, cb]);
}

export function startPlaneArt(canvas, getBands) {
  // The landing page's preview shares its canvas, and so this context, with
  // the fabric, so this asks for what the fabric needs and undoes what it left on.
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: true, premultipliedAlpha: true });
  if (!gl) return () => {};
  gl.disable(gl.DEPTH_TEST);
  for (let i = 0; i < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); i++) gl.disableVertexAttribArray(i);

  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  const u = (name) => gl.getUniformLocation(program, name);

  const { data, count } = buildCloud();
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const attributes = [["aPosition", 3, 0], ["aNormal", 3, 3], ["aRand", 2, 6], ["aKind", 1, 8]].map(([name, size, offset]) => {
    const at = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
    return at;
  });

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);

  let colors = [];
  let winds = [];
  const colorData = new Float32Array(MAX_BANDS * 3);
  const windData = new Float32Array(MAX_BANDS);
  let last = performance.now();
  let frame = 0;
  let drawnKey = "";

  function draw(ms) {
    frame = requestAnimationFrame(draw);

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    const aspect = w / h;
    const rows = parseFloat(getComputedStyle(canvas).getPropertyValue("--art-rows")) || 0;

    // Ease toward the latest colors and winds, at the same pace on slow frames.
    const bands = getBands().slice(0, MAX_BANDS);
    if (!bands.length) bands.push(null);
    const ease = reducedMotion ? 1 : 1 - Math.exp(-(ms - last) / 450);
    const windEase = reducedMotion ? 1 : 1 - Math.exp(-(ms - last) / 2500);
    last = ms;
    colors = bands.map((b, i) => {
      const target = b ? tintFor(b.tempC) : WAITING_COLOR;
      return (colors[i] ?? target).map((c, j) => c + (target[j] - c) * ease);
    });
    winds = bands.map((b, i) => {
      const target = Math.min((b?.windKph ?? 0) / FULL_WIND_KPH, 1);
      return (winds[i] ?? 0) + (target - (winds[i] ?? 0)) * windEase;
    });

    // With reduced motion the aircraft holds still, so it's only redrawn when
    // something it shows changes.
    const frameKey = `${colors.map((c) => c.map(Math.round))}|${winds.map((v) => v.toFixed(2))}|${w}x${h}|${rows}`;
    if (reducedMotion && frameKey === drawnKey) return;
    drawnKey = frameKey;

    const t = reducedMotion ? 0 : ms / 1000;
    // A slow lean into the air, with the camera drifting round a little.
    const swing = Math.sin(t * 0.09) * 0.07;
    const direction = normalized([
      EYE_DIRECTION[0] * Math.cos(swing) + EYE_DIRECTION[2] * Math.sin(swing),
      EYE_DIRECTION[1],
      EYE_DIRECTION[2] * Math.cos(swing) - EYE_DIRECTION[0] * Math.sin(swing),
    ]);
    const distance = rows ? ROWS_DISTANCE : DISTANCE * Math.max(1, FIT_ASPECT / aspect);
    const eye = direction.map((v) => v * distance);

    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix4fv(u("uViewProjection"), false, multiply(perspective(FOV, aspect, 0.1, 60), multiply(rolled(rows ? ROWS_ROLL : 0), lookAtOrigin(eye))));
    gl.uniformMatrix3fv(u("uModel"), false, attitude(0.12 + Math.sin(t * 0.17) * 0.018, 0.1 + Math.sin(t * 0.13) * 0.05));
    gl.uniform3f(u("uEye"), ...eye);
    gl.uniform1f(u("uTime"), t);
    gl.uniform1f(u("uCount"), bands.length);
    gl.uniform1f(u("uRows"), rows);
    gl.uniform1f(u("uShift"), rows ? 0 : SHIFT_DOWN);
    gl.uniform1f(u("uPoint"), 1.5 * Math.max(0.7 * dpr, Math.min(w, h * 1.78) / 1440));
    colors.forEach((c, i) => colorData.set(c.map((v) => v / 255), i * 3));
    gl.uniform3fv(u("uColors[0]"), colorData);
    windData.set(winds);
    gl.uniform1fv(u("uWinds[0]"), windData);
    gl.drawArrays(gl.POINTS, 0, count);
  }
  frame = requestAnimationFrame(draw);

  return function stop() {
    cancelAnimationFrame(frame);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);
    for (const at of attributes) gl.disableVertexAttribArray(at);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
}
