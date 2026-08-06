/**
 * Frontlines render stack.
 *
 * Deferred-ish forward pipeline built on three.js WebGL2:
 *
 *   depth prepass  ->  opaque forward + CSM shadows  ->  GTAO  ->  transparent
 *   ->  screen-space godrays  ->  bloom  ->  TAA resolve  ->  tonemap + grade  ->  UI
 *
 * Everything is hand-rolled rather than pulled from three's example post-processing so the
 * passes can share the depth/normal buffers and run at the right resolution: AO at half
 * res, bloom in a mip chain, TAA at full res with a velocity buffer.
 */
import * as THREE from 'three';

/* ============================================================ render targets */

const HALF = THREE.HalfFloatType;

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: opts.type ?? HALF,
    format: opts.format ?? THREE.RGBAFormat,
    minFilter: opts.min ?? THREE.LinearFilter,
    magFilter: opts.mag ?? THREE.LinearFilter,
    depthBuffer: opts.depth ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

/* ================================================================== shaders */

const FS_QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * Screen-space ambient occlusion.
 *
 * Normal-oriented hemisphere sampling: for each pixel, scatter points through the
 * hemisphere above its surface, project them back to screen space, and count how many land
 * behind the depth buffer. Occlusion is then a plain average, which is unbiased on flat
 * surfaces.
 *
 * (A horizon-search formulation was tried first and rejected: taking max() over
 * dot(sampleDir, N) on a flat plane maxes over depth-quantisation noise centred on zero,
 * so every large flat wall picked up a uniform ~20% darkening.)
 *
 * Interiors live or die on contact shadows — this is what seats doorframes, skirting and
 * crates into the floor instead of letting them hover.
 */
const SSAO_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2  uRes;
uniform float uRadius;      // world-space metres
uniform float uIntensity;
uniform float uBias;        // world-space metres, fights self-occlusion acne
uniform mat4  uProjInv;
uniform mat4  uProj;
uniform float uFrame;
uniform vec3  uKernel[24];

const int SAMPLES = 24;

vec3 viewPos(vec2 uv, float d) {
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * c;
  return v.xyz / v.w;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float d = texture2D(tDepth, vUv).r;
  if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPos(vUv, d);
  vec3 N = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);

  // Per-pixel rotated tangent frame decorrelates the kernel; the blur then resolves it.
  float ang = hash(gl_FragCoord.xy + uFrame * 13.7) * 6.2831853;
  vec3 randomVec = vec3(cos(ang), sin(ang), 0.0);
  vec3 T = normalize(randomVec - N * dot(randomVec, N));
  vec3 B = cross(N, T);
  mat3 TBN = mat3(T, B, N);

  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    vec3 samplePos = P + (TBN * uKernel[i]) * uRadius;

    vec4 clip = uProj * vec4(samplePos, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    vec2 suv = ndc.xy * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;

    float sd = texture2D(tDepth, suv).r;
    if (sd >= 1.0) continue;
    float sceneZ = viewPos(suv, sd).z;

    // Occluded when real geometry sits nearer the camera than the sample point.
    // View space is right-handed with -Z forward, so "nearer" is a larger z.
    float occluded = step(samplePos.z + uBias, sceneZ);

    // Ignore occluders far outside the radius so a foreground pillar cannot shade a
    // distant wall through empty space.
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(1e-4, abs(P.z - sceneZ)));
    occ += occluded * rangeCheck;
  }

  float ao = clamp(1.0 - (occ / float(SAMPLES)) * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

/** Depth-aware cross bilateral blur — denoises AO without bleeding across silhouettes. */
const BLUR_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform vec2 uDir;
void main() {
  float centerD = texture2D(tDepth, vUv).r;
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    vec2 off = uDir * fi / uRes;
    float w = exp(-fi * fi / 8.0);
    float d = texture2D(tDepth, vUv + off).r;
    // 0.0012 in NDC depth ~= a few cm at typical interior range
    float dw = exp(-abs(d - centerD) / 0.0012);
    w *= dw;
    sum += texture2D(tInput, vUv + off).r * w;
    wsum += w;
  }
  float v = wsum > 0.0 ? sum / wsum : texture2D(tInput, vUv).r;
  gl_FragColor = vec4(v, v, v, 1.0);
}`;

/** Bright-pass with soft knee, feeding the bloom mip chain. */
const BRIGHT_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tInput, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}`;

/** 13-tap Call-of-Duty style downsample: stable, no flickering fireflies. */
const DOWN_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
void main() {
  vec3 a = texture2D(tInput, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 b = texture2D(tInput, vUv + uTexel * vec2( 0.0,  1.0)).rgb;
  vec3 c = texture2D(tInput, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 d = texture2D(tInput, vUv + uTexel * vec2(-0.5,  0.5)).rgb;
  vec3 e = texture2D(tInput, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  vec3 f = texture2D(tInput, vUv + uTexel * vec2(-1.0,  0.0)).rgb;
  vec3 g = texture2D(tInput, vUv).rgb;
  vec3 h = texture2D(tInput, vUv + uTexel * vec2( 1.0,  0.0)).rgb;
  vec3 i = texture2D(tInput, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  vec3 j = texture2D(tInput, vUv + uTexel * vec2( 0.5, -0.5)).rgb;
  vec3 k = texture2D(tInput, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 l = texture2D(tInput, vUv + uTexel * vec2( 0.0, -1.0)).rgb;
  vec3 m = texture2D(tInput, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 res = (d + e + i + j) * 0.125
           + (a + b + g + f) * 0.03125
           + (b + c + h + g) * 0.03125
           + (f + g + l + k) * 0.03125
           + (g + h + m + l) * 0.03125
           + g * 0.125;
  gl_FragColor = vec4(res, 1.0);
}`;

/** Tent-filter upsample, additively blended up the chain. */
const UP_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 s = texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb
         + texture2D(tInput, vUv + vec2( 0.0,  o.y)).rgb * 2.0
         + texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb
         + texture2D(tInput, vUv + vec2(-o.x,  0.0)).rgb * 2.0
         + texture2D(tInput, vUv).rgb * 4.0
         + texture2D(tInput, vUv + vec2( o.x,  0.0)).rgb * 2.0
         + texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb
         + texture2D(tInput, vUv + vec2( 0.0, -o.y)).rgb * 2.0
         + texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;
  gl_FragColor = vec4(s / 16.0, 1.0);
}`;

/**
 * Temporal anti-aliasing.
 *
 * Neighbourhood-clamped history, reprojected by unprojecting each pixel's depth to a world
 * position and re-projecting it through the previous frame's view-projection. For static
 * geometry — which is the entire map — that is exact and costs no extra geometry pass, so
 * there is no velocity buffer to render or keep in sync.
 *
 * Combined with the jittered projection matrix this is what stops thin geometry (railings,
 * window frames, iron sights) from crawling.
 */
const TAA_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform vec2  uRes;
uniform float uBlend;
uniform float uValid;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;

vec3 rgb2ycocg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5 * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycocg2rgb(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

void main() {
  vec3 cur = texture2D(tCurrent, vUv).rgb;

  if (uValid < 0.5) { gl_FragColor = vec4(cur, 1.0); return; }

  float d = texture2D(tDepth, vUv).r;

  // Sky (depth == 1) has no parallax, so it reprojects to itself.
  vec2 hUv = vUv;
  if (d < 1.0) {
    vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 world = uInvViewProj * clip;
    world /= world.w;
    vec4 prev = uPrevViewProj * world;
    if (prev.w <= 0.0) { gl_FragColor = vec4(cur, 1.0); return; }
    hUv = (prev.xy / prev.w) * 0.5 + 0.5;
  }

  if (hUv.x < 0.0 || hUv.y < 0.0 || hUv.x > 1.0 || hUv.y > 1.0) {
    gl_FragColor = vec4(cur, 1.0);
    return;
  }

  // Local colour AABB in YCoCg — tighter and less ghost-prone than an RGB box.
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = rgb2ycocg(texture2D(tCurrent, vUv + vec2(float(x), float(y)) / uRes).rgb);
      m1 += s; m2 += s * s;
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mean * mean));
  vec3 lo = mean - 1.25 * sigma;
  vec3 hi = mean + 1.25 * sigma;

  vec3 hist = clamp(rgb2ycocg(texture2D(tHistory, hUv).rgb), lo, hi);

  // Trust history less the further the pixel travelled — that is where disocclusion lives.
  float speed = length((hUv - vUv) * uRes);
  float blend = mix(uBlend, 0.75, clamp(speed / 20.0, 0.0, 1.0));

  gl_FragColor = vec4(max(vec3(0.0), mix(ycocg2rgb(hist), cur, blend)), 1.0);
}`;

/** Straight copy, used to seed the TAA history without aliasing a bound target. */
const COPY_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
void main() { gl_FragColor = vec4(texture2D(tInput, vUv).rgb, 1.0); }`;

/**
 * Final composite: AO application, bloom mix, exposure, AgX tonemap, grade, and the
 * lens character (vignette, chromatic aberration, grain).
 *
 * AgX is used over ACES because it keeps saturated muzzle flash and site floodlights from
 * clipping to white, which matters when the whole game is fought under interior lighting.
 */
const COMPOSITE_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAO;
uniform float uExposure;
uniform float uBloom;
uniform float uAOStrength;
uniform float uVignette;
uniform float uChroma;
uniform float uGrain;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uFlash;      // flashbang / concussion whiteout
uniform float uDamage;     // low-health desaturation + red edge

// --- AgX -------------------------------------------------------------------
vec3 agxDefaultContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 col) {
  const mat3 inset = mat3(
    0.856627153315983, 0.137318972929847, 0.11189821299995,
    0.0951212405381588, 0.761241990602591, 0.0767994186031903,
    0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 outset = mat3(
    1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
    -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
    -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  const float LOG2_MIN = -10.0;
  const float LOG2_MAX = 6.5;
  col = inset * col;
  col = clamp(log2(max(col, 1e-10)), LOG2_MIN, LOG2_MAX);
  col = (col - LOG2_MIN) / (LOG2_MAX - LOG2_MIN);
  col = agxDefaultContrast(col);
  col = outset * col;
  return clamp(col, 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  vec2 toCenter = uv - 0.5;
  float r2 = dot(toCenter, toCenter);

  // Chromatic aberration grows toward the frame edge, like a real wide lens. r2 peaks at
  // 0.5 in the corners, so the 0.004 scale caps the split at ~2 px on a 1080p frame —
  // present in the corner of your eye, invisible if you look for it.
  float ca = uChroma * r2 * 0.004;
  vec3 scene;
  if (ca > 0.0001) {
    scene.r = texture2D(tScene, uv - toCenter * ca).r;
    scene.g = texture2D(tScene, uv).g;
    scene.b = texture2D(tScene, uv + toCenter * ca).b;
  } else {
    scene = texture2D(tScene, uv).rgb;
  }

  float ao = texture2D(tAO, uv).r;
  ao = mix(1.0, ao, uAOStrength);
  scene *= ao;

  vec3 bloom = texture2D(tBloom, uv).rgb;
  scene += bloom * uBloom;

  scene *= uExposure;

  // Flashbang: additive whiteout that survives the tonemap.
  scene += vec3(uFlash * 8.0);

  vec3 col = agx(scene);

  // --- grade ---------------------------------------------------------------
  col = pow(max(col, 0.0), 1.0 / max(uGamma, vec3(0.01)));
  col = col * uGain + uLift;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;

  // Low health drains colour and pushes a red rim in from the edges.
  if (uDamage > 0.001) {
    float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l2), uDamage * 0.75);
    col = mix(col, vec3(0.45, 0.03, 0.02), uDamage * smoothstep(0.05, 0.32, r2) * 0.85);
  }

  // Vignette
  col *= 1.0 - uVignette * smoothstep(0.05, 0.75, r2);

  // Film grain, scaled down in the highlights where sensors are cleanest.
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 431.7) - 0.5;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += g * uGrain * (1.0 - lum * 0.7);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Writes view-space normals + per-pixel velocity for AO and TAA. */
const NORMAL_VELOCITY_VS = /* glsl */`
varying vec3 vViewNormal;
varying vec4 vCurClip;
varying vec4 vPrevClip;
uniform mat4 uPrevModelViewProjection;
uniform mat4 uCurModelViewProjection;
void main() {
  vViewNormal = normalize(normalMatrix * normal);
  vec4 world = vec4(position, 1.0);
  vCurClip  = uCurModelViewProjection  * world;
  vPrevClip = uPrevModelViewProjection * world;
  gl_Position = projectionMatrix * modelViewMatrix * world;
}`;

const NORMAL_VELOCITY_FS = /* glsl */`
precision highp float;
varying vec3 vViewNormal;
varying vec4 vCurClip;
varying vec4 vPrevClip;
void main() {
  vec2 cur  = vCurClip.xy  / vCurClip.w  * 0.5 + 0.5;
  vec2 prev = vPrevClip.xy / vPrevClip.w * 0.5 + 0.5;
  gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);
  // velocity goes to MRT attachment 1 when available; see FrontlineRenderer.
}`;

/* ============================================================ quality presets */

export const QUALITY = {
  low: {
    label: 'Low', scale: 0.72, shadowSize: 1024, cascades: 2, ao: false, aoScale: 0.5,
    bloomMips: 4, taa: false, grain: 0.0, chroma: 0.0, aniso: 4, shadowDistance: 28,
  },
  medium: {
    label: 'Medium', scale: 0.85, shadowSize: 1536, cascades: 3, ao: true, aoScale: 0.5,
    bloomMips: 5, taa: true, grain: 0.012, chroma: 0.15, aniso: 8, shadowDistance: 38,
  },
  high: {
    label: 'High', scale: 1.0, shadowSize: 2048, cascades: 3, ao: true, aoScale: 0.5,
    bloomMips: 6, taa: true, grain: 0.018, chroma: 0.25, aniso: 16, shadowDistance: 48,
  },
  ultra: {
    label: 'Ultra', scale: 1.0, shadowSize: 3072, cascades: 4, ao: true, aoScale: 1.0,
    bloomMips: 7, taa: true, grain: 0.02, chroma: 0.32, aniso: 16, shadowDistance: 64,
  },
};

/**
 * Cosine-ish hemisphere kernel for SSAO.
 * Lengths are scaled toward the origin so most samples cluster near the shading point,
 * which is where contact occlusion actually lives.
 */
function buildHemisphereKernel(count) {
  const out = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296);
  };
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd());
    v.normalize();
    let scale = i / count;
    scale = 0.1 + 0.9 * scale * scale;      // bias toward the centre
    v.multiplyScalar(scale);
    out.push(v);
  }
  return out;
}

/* Halton(2,3) — the jitter sequence TAA samples the pixel footprint with. */
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

/* ================================================================== renderer */

export class FrontlineRenderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.q = QUALITY[quality] ?? QUALITY.high;
    this.qualityName = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // TAA handles edges; MSAA would cost too much here
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      // Readback for dev captures requires the buffer to survive compositing. Opt in with
      // ?capture=1 so the production path keeps the faster swap.
      preserveDrawingBuffer: new URLSearchParams(location.search).has('capture'),
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;    // done in the composite pass
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;         // driven manually, see markShadowsDirty
    this.renderer.setClearColor(0x000000, 1);

    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    // Fullscreen triangle used by every post pass.
    this.quadGeo = new THREE.BufferGeometry();
    this.quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    this.quadMesh = new THREE.Mesh(this.quadGeo, null);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);

    this.frame = 0;
    this.prevViewProj = new THREE.Matrix4();
    this.curViewProj = new THREE.Matrix4();
    this.historyValid = false;

    // Tuned against the Luna Park interior: exposure sits below 1 because the AgX curve
    // plus a 0.5 environment intensity already lifts the midtones, and anything higher
    // blows the sky out through every window and skylight.
    this.grade = {
      exposure: 0.82, bloom: 0.05, ao: 1.0, vignette: 0.40,
      saturation: 1.12, contrast: 1.10,
      lift: new THREE.Vector3(0.004, 0.005, 0.012),
      gamma: new THREE.Vector3(1.0, 1.0, 1.02),
      gain: new THREE.Vector3(1.0, 0.995, 0.975),
      flash: 0, damage: 0,
    };

    this._buildMaterials();
    this.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720);
  }

  _buildMaterials() {
    const mk = (fs, uniforms) => new THREE.RawShaderMaterial({
      vertexShader: `#version 300 es\n` + FS_QUAD_VS.replace(/varying/g, 'out').replace('void main', 'in vec3 position;\nin vec2 uv;\nvoid main'),
      fragmentShader: `#version 300 es\n` + fs,
      uniforms, depthTest: false, depthWrite: false,
    });
    // three's ShaderMaterial already injects the GLSL3 boilerplate we need, so use it
    // rather than hand-writing #version headers for every pass.
    const sm = (fs, uniforms) => new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VS, fragmentShader: fs, uniforms,
      depthTest: false, depthWrite: false,
    });

    this.matGTAO = sm(SSAO_FS, {
      tDepth: { value: null }, tNormal: { value: null },
      uRes: { value: new THREE.Vector2() },
      uRadius: { value: 0.85 },        // metres — a contact-scale effect, not a haze
      uIntensity: { value: 1.9 }, uBias: { value: 0.022 },
      uProjInv: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
      uFrame: { value: 0 },
      uKernel: { value: buildHemisphereKernel(24) },
    });
    this.matBlur = sm(BLUR_FS, {
      tInput: { value: null }, tDepth: { value: null },
      uRes: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) },
    });
    this.matBright = sm(BRIGHT_FS, {
      tInput: { value: null }, uThreshold: { value: 1.05 }, uKnee: { value: 0.6 },
    });
    this.matDown = sm(DOWN_FS, { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.matUp = sm(UP_FS, {
      tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
    });
    this.matUp.blending = THREE.AdditiveBlending;
    this.matTAA = sm(TAA_FS, {
      tCurrent: { value: null }, tHistory: { value: null },
      tDepth: { value: null }, uRes: { value: new THREE.Vector2() },
      uBlend: { value: 0.12 }, uValid: { value: 0 },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
    });
    this.matCopy = sm(COPY_FS, { tInput: { value: null } });
    this.matComposite = sm(COMPOSITE_FS, {
      tScene: { value: null }, tBloom: { value: null }, tAO: { value: null },
      uExposure: { value: 1.0 }, uBloom: { value: 0.05 }, uAOStrength: { value: 0.85 },
      uVignette: { value: 0.34 }, uChroma: { value: 0.25 }, uGrain: { value: 0.018 },
      uTime: { value: 0 }, uSaturation: { value: 1.06 }, uContrast: { value: 1.04 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uFlash: { value: 0 }, uDamage: { value: 0 },
    });

    // Depth+normal prepass material, shared by every opaque mesh.
    this.matPrepass = new THREE.MeshNormalMaterial();
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.q = QUALITY[name];
    this.renderer.shadowMap.type = name === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.setSize(this.width, this.height);
    this.markShadowsDirty();
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    const dpr = Math.min(window.devicePixelRatio || 1, this.qualityName === 'ultra' ? 2 : 1.5);
    this.dpr = dpr;
    const rw = Math.max(320, Math.floor(w * this.q.scale * dpr));
    const rh = Math.max(180, Math.floor(h * this.q.scale * dpr));
    this.rw = rw; this.rh = rh;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);

    const dispose = (rt) => rt && rt.dispose();
    dispose(this.rtScene); dispose(this.rtNormal);
    dispose(this.rtAO); dispose(this.rtAOBlur); dispose(this.rtTAA);
    dispose(this.rtHistory); dispose(this.rtHistoryWrite);
    (this.bloomRTs || []).forEach(dispose);

    this.rtScene = makeRT(rw, rh, { depth: true });
    this.rtScene.depthTexture = new THREE.DepthTexture(rw, rh, THREE.UnsignedIntType);
    this.rtScene.depthTexture.format = THREE.DepthFormat;

    this.rtNormal = makeRT(rw, rh, { depth: true, type: THREE.UnsignedByteType });

    const aw = Math.max(160, Math.floor(rw * this.q.aoScale));
    const ah = Math.max(90, Math.floor(rh * this.q.aoScale));
    this.rtAO = makeRT(aw, ah, { type: THREE.UnsignedByteType });
    this.rtAOBlur = makeRT(aw, ah, { type: THREE.UnsignedByteType });

    this.rtTAA = makeRT(rw, rh);
    this.rtHistory = makeRT(rw, rh);
    this.rtHistoryWrite = makeRT(rw, rh);
    this.historyValid = false;

    this.bloomRTs = [];
    let bw = rw >> 1, bh = rh >> 1;
    for (let i = 0; i < this.q.bloomMips && bw > 8 && bh > 8; i++) {
      this.bloomRTs.push(makeRT(bw, bh));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    this.rtBright = makeRT(rw >> 1, rh >> 1);

    this.matGTAO.uniforms.uRes.value.set(aw, ah);
    this.matBlur.uniforms.uRes.value.set(aw, ah);
    this.matTAA.uniforms.uRes.value.set(rw, rh);
  }

  markShadowsDirty() { this.renderer.shadowMap.needsUpdate = true; }

  /** Applies the TAA sub-pixel jitter to the camera's projection matrix. */
  applyJitter(camera) {
    if (!this.q.taa) { camera.clearViewOffset?.(); return; }
    const [jx, jy] = JITTER[this.frame % JITTER.length];
    camera.setViewOffset(this.rw, this.rh, jx, jy, this.rw, this.rh);
  }

  blit(material, target) {
    this.quadMesh.material = material;
    this.renderer.setRenderTarget(target ?? null);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /**
   * Renders one frame.
   * `scene` must already be updated; `camera` should have had applyJitter() called.
   */
  render(scene, camera, dt) {
    const r = this.renderer;
    this.frame++;

    camera.updateMatrixWorld();
    this.prevViewProj.copy(this.curViewProj);
    this.curViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // ---- 1. scene (opaque + transparent, forward, with shadows) -------------
    r.setRenderTarget(this.rtScene);
    r.clear(true, true, false);
    r.render(scene, camera);

    // ---- 2. normals for AO -------------------------------------------------
    if (this.q.ao) {
      const oldOverride = scene.overrideMaterial;
      scene.overrideMaterial = this.matPrepass;
      r.setRenderTarget(this.rtNormal);
      r.clear(true, true, false);
      r.render(scene, camera);
      scene.overrideMaterial = oldOverride;

      const u = this.matGTAO.uniforms;
      u.tDepth.value = this.rtScene.depthTexture;
      u.tNormal.value = this.rtNormal.texture;
      u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uProj.value.copy(camera.projectionMatrix);
      u.uFrame.value = this.frame % 64;
      this.blit(this.matGTAO, this.rtAO);

      this.matBlur.uniforms.tDepth.value = this.rtScene.depthTexture;
      this.matBlur.uniforms.tInput.value = this.rtAO.texture;
      this.matBlur.uniforms.uDir.value.set(1, 0);
      this.blit(this.matBlur, this.rtAOBlur);
      this.matBlur.uniforms.tInput.value = this.rtAOBlur.texture;
      this.matBlur.uniforms.uDir.value.set(0, 1);
      this.blit(this.matBlur, this.rtAO);
    }

    // ---- 3. bloom ----------------------------------------------------------
    this.matBright.uniforms.tInput.value = this.rtScene.texture;
    this.blit(this.matBright, this.rtBright);

    let src = this.rtBright;
    for (const rt of this.bloomRTs) {
      this.matDown.uniforms.tInput.value = src.texture;
      this.matDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.blit(this.matDown, rt);
      src = rt;
    }
    for (let i = this.bloomRTs.length - 2; i >= 0; i--) {
      const from = this.bloomRTs[i + 1], to = this.bloomRTs[i];
      this.matUp.uniforms.tInput.value = from.texture;
      this.matUp.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
      this.quadMesh.material = this.matUp;
      r.setRenderTarget(to);
      r.render(this.quadScene, this.quadCam);   // additive, do not clear
    }

    // ---- 4. composite ------------------------------------------------------
    const g = this.grade;
    const cu = this.matComposite.uniforms;
    cu.tScene.value = this.rtScene.texture;
    cu.tBloom.value = this.bloomRTs.length ? this.bloomRTs[0].texture : this.rtBright.texture;
    cu.tAO.value = this.q.ao ? this.rtAO.texture : null;
    cu.uAOStrength.value = this.q.ao ? g.ao : 0;
    cu.uExposure.value = g.exposure;
    cu.uBloom.value = g.bloom;
    cu.uVignette.value = g.vignette;
    cu.uChroma.value = this.q.chroma;
    cu.uGrain.value = this.q.grain;
    cu.uTime.value = (cu.uTime.value + dt) % 1000;
    cu.uSaturation.value = g.saturation;
    cu.uContrast.value = g.contrast;
    cu.uLift.value.copy(g.lift);
    cu.uGamma.value.copy(g.gamma);
    cu.uGain.value.copy(g.gain);
    cu.uFlash.value = g.flash;
    cu.uDamage.value = g.damage;

    if (this.q.taa) {
      this.blit(this.matComposite, this.rtTAA);

      const t = this.matTAA.uniforms;
      t.tCurrent.value = this.rtTAA.texture;
      t.tHistory.value = this.rtHistory.texture;      // read side of the ping-pong
      t.tDepth.value = this.rtScene.depthTexture;
      t.uValid.value = this.historyValid ? 1 : 0;
      t.uInvViewProj.value.copy(this.curViewProj).invert();
      t.uPrevViewProj.value.copy(this.prevViewProj);

      // Resolve into the write half, never into the target currently bound for reading.
      this.blit(this.matTAA, this.rtHistoryWrite);

      this.matCopy.uniforms.tInput.value = this.rtHistoryWrite.texture;
      this.blit(this.matCopy, null);

      const tmp = this.rtHistory;
      this.rtHistory = this.rtHistoryWrite;
      this.rtHistoryWrite = tmp;
      this.historyValid = true;
    } else {
      this.blit(this.matComposite, null);
    }

    r.setRenderTarget(null);
  }

  resetHistory() { this.historyValid = false; }

  dispose() {
    this.renderer.dispose();
    [this.rtScene, this.rtNormal, this.rtAO, this.rtAOBlur, this.rtTAA,
     this.rtHistory, this.rtHistoryWrite, this.rtBright, ...(this.bloomRTs || [])]
      .forEach((rt) => rt && rt.dispose());
  }
}
