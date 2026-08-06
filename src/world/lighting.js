/**
 * Lighting rig.
 *
 * The map's diffuse atlases are flat albedo with no baked light, so every bit of shape in
 * the scene comes from here. The rig is built to read as late-afternoon overcast pushing
 * through an old amusement-hall envelope: cool sky fill, warm bounce off the floor, a
 * single strong key for shadow direction, and warm practical lamps inside where the sun
 * cannot reach.
 */
import * as THREE from 'three';

/* ---------------------------------------------------------- sky environment */

/**
 * Procedural physical-ish sky, rendered once into a cubemap and used as the IBL source.
 * Hosking-style analytic sky rather than a shipped HDR: no download, and the sun angle can
 * be driven per map/time-of-day preset.
 */
const SKY_FS = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3  uSunDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform vec3  uGroundColor;
uniform float uSunIntensity;
uniform float uExposure;

const float PI = 3.141592653589793;

// Preetham/Hosek atmospheric constants.
const float REFRACTIVE_INDEX = 1.0003;      // air
const float MOLECULAR_DENSITY = 2.545E25;   // molecules per cubic metre
const float DEPOLARISATION = 0.035;
const vec3  MIE_K = vec3(0.686, 0.678, 0.666);
const float MIE_V = 4.0;
const float RAYLEIGH_ZENITH = 8.4E3;
const float MIE_ZENITH = 1.25E3;

vec3 totalRayleigh(vec3 lambda) {
  float n2 = REFRACTIVE_INDEX * REFRACTIVE_INDEX;
  return (8.0 * pow(PI, 3.0) * pow(n2 - 1.0, 2.0) * (6.0 + 3.0 * DEPOLARISATION))
       / (3.0 * MOLECULAR_DENSITY * pow(lambda, vec3(4.0)) * (6.0 - 7.0 * DEPOLARISATION));
}

vec3 totalMie(vec3 lambda, float turbidity) {
  float c = 0.2 * turbidity * 10E-18;
  return 0.434 * c * PI * pow((2.0 * PI) / lambda, vec3(MIE_V - 2.0)) * MIE_K;
}

float rayleighPhase(float c) { return (3.0 / (16.0 * PI)) * (1.0 + c * c); }

float hgPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(max(1.0 - 2.0 * g * c + g2, 1e-4), 1.5));
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float up = dir.y;

  vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
  vec3 betaR = totalRayleigh(lambda) * uRayleigh;
  vec3 betaM = totalMie(lambda, uTurbidity);

  // Optical path length through each layer for this view direction.
  float zenith = acos(max(0.0, up));
  float denom = cos(zenith) + 0.15 * pow(max(0.0, 93.885 - (zenith * 180.0 / PI)), -1.253);
  float sR = RAYLEIGH_ZENITH / denom;
  float sM = MIE_ZENITH / denom;

  vec3 Fex = exp(-(betaR * sR + betaM * sM));

  float cosTheta = dot(dir, sun);
  vec3 betaRTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaMTheta = betaM * hgPhase(cosTheta, 0.80);

  // Sun sitting low weakens and warms the whole sky.
  float sunfade = 1.0 - clamp(1.0 - exp(sun.y * 4.0), 0.0, 1.0);
  vec3 sunE = vec3(uSunIntensity * max(0.0, 1.0 - exp(-((PI / 1.95 - acos(sun.y)) / 1.5))));

  vec3 scatter = (betaRTheta + betaMTheta) / (betaR + betaM);
  vec3 Lin = pow(sunE * scatter * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(sunE * scatter * Fex, vec3(0.5)),
             clamp(pow(1.0 - dot(vec3(0.0, 1.0, 0.0), sun), 5.0), 0.0, 1.0));

  // Sun disc, softened so it does not alias into the cubemap mips.
  float disc = smoothstep(0.9996, 0.99994, cosTheta);
  vec3 L0 = vec3(0.1) * Fex + sunE * 19000.0 * Fex * disc;

  vec3 col = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / (1.2 + 1.2 * sunfade)));

  // Below the horizon, fade to a matte ground so the IBL bake gets a plausible bounce
  // term instead of a black lower hemisphere.
  col = mix(uGroundColor * (0.30 + 0.70 * exp(up * 7.0)), col, smoothstep(-0.05, 0.05, up));

  gl_FragColor = vec4(col * uExposure, 1.0);
}`;

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // force to the far plane
}`;

export class Sky {
  constructor(sunDir = new THREE.Vector3(0.35, 0.42, -0.84).normalize()) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      // The vertex shader forces z = w so the sky sits exactly on the far plane, which a
      // LESS depth test rejects against a cleared buffer. Drawing it first with the test
      // off is both correct and cheaper than a LEQUAL func.
      depthTest: false,
      toneMapped: false,
      uniforms: {
        uSunDir: { value: sunDir.clone() },
        uTurbidity: { value: 3.4 },
        uRayleigh: { value: 1.8 },
        // The lower hemisphere is what lights every downward-facing surface through the
        // IBL. Left near-black, every ceiling and soffit in the building renders black —
        // this stands in for bounce off the pale gravel grounds.
        uGroundColor: { value: new THREE.Color(0x6b6153) },
        // Extraterrestrial irradiance, matching the Preetham reference scale.
        uSunIntensity: { value: 1000.0 },
        // The reference model's output lands roughly in display range; lift it into linear
        // HDR so the PMREM bake carries real energy into the interior — but only just.
        // Push this and the sky clips to white and the IBL flattens every surface.
        uExposure: { value: 1.25 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(4000);
  }

  get sunDir() { return this.material.uniforms.uSunDir.value; }

  /** Bakes the sky into a PMREM environment map for image-based lighting. */
  generateEnvironment(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    const scene = new THREE.Scene();
    scene.add(this.mesh.clone());
    const rt = pmrem.fromScene(scene, 0.04, 0.1, 2000);
    pmrem.dispose();
    return rt.texture;
  }
}

/* ------------------------------------------------------------ cascaded sun */

/**
 * Cascaded shadow maps.
 *
 * three.js ships no CSM, and a single directional shadow across a 56 m map either has
 * metre-wide texels or covers a tenth of the play space. This splits the view frustum
 * logarithmically and gives each cascade its own tightly-fitted orthographic light camera,
 * so a doorframe two metres away and a balcony forty metres away both get crisp contact.
 */
export class CascadedSun {
  constructor(scene, { cascades = 3, size = 2048, maxDistance = 48, lambda = 0.72 } = {}) {
    this.cascadeCount = cascades;
    this.maxDistance = maxDistance;
    this.lambda = lambda;
    this.lights = [];
    this.direction = new THREE.Vector3(0.35, 0.42, -0.84).normalize();

    for (let i = 0; i < cascades; i++) {
      const l = new THREE.DirectionalLight(0xfff2e0, i === 0 ? 2.6 : 0.0001);
      l.castShadow = true;
      l.shadow.mapSize.set(size, size);
      l.shadow.bias = -0.0006 - i * 0.0004;
      l.shadow.normalBias = 0.02 + i * 0.03;
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far = maxDistance * 3;
      l.matrixAutoUpdate = true;
      scene.add(l);
      scene.add(l.target);
      this.lights.push(l);
    }
    // Only the first light contributes colour; the rest exist purely for their shadow maps,
    // which are combined by three's shadow accumulation.
    this.lights.forEach((l, i) => { l.intensity = i === 0 ? 2.6 : 2.6 / cascades; });

    this._splits = [];
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  }

  setDirection(v) {
    this.direction.copy(v).normalize();
  }

  setIntensity(i) {
    this.lights.forEach((l) => { l.intensity = i; });
  }

  /** Practical split scheme: blend of uniform and logarithmic distribution. */
  _computeSplits(near, far) {
    const n = this.cascadeCount;
    const splits = [near];
    for (let i = 1; i < n; i++) {
      const p = i / n;
      const log = near * Math.pow(far / near, p);
      const uni = near + (far - near) * p;
      splits.push(this.lambda * log + (1 - this.lambda) * uni);
    }
    splits.push(far);
    return splits;
  }

  update(camera) {
    const near = camera.near;
    const far = Math.min(this.maxDistance, camera.far);
    const splits = this._computeSplits(Math.max(near, 0.3), far);

    const invView = camera.matrixWorld;
    const tanHalfV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanHalfH = tanHalfV * camera.aspect;

    for (let i = 0; i < this.cascadeCount; i++) {
      const n = splits[i], f = splits[i + 1];
      // Frustum slice corners in view space -> world space
      let k = 0;
      for (const d of [n, f]) {
        const h = tanHalfV * d, w = tanHalfH * d;
        for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
          this._corners[k++].set(sx * w, sy * h, -d).applyMatrix4(invView);
        }
      }
      // Bounding sphere of the slice keeps the ortho box rotation-invariant, which stops
      // shadow texels from swimming as the player turns.
      const centre = new THREE.Vector3();
      for (const c of this._corners) centre.add(c);
      centre.divideScalar(8);
      let radius = 0;
      for (const c of this._corners) radius = Math.max(radius, c.distanceTo(centre));
      radius = Math.ceil(radius * 16) / 16;

      const light = this.lights[i];
      const texelsPerUnit = light.shadow.mapSize.width / (radius * 2);

      // Snap the light position to whole shadow texels — the other half of stopping swim.
      const lightPos = centre.clone().addScaledVector(this.direction, radius * 2.2);
      const lookAt = new THREE.Matrix4().lookAt(lightPos, centre, new THREE.Vector3(0, 1, 0));
      const lightRot = new THREE.Matrix4().extractRotation(lookAt);
      const invRot = lightRot.clone().invert();
      const snapped = centre.clone().applyMatrix4(invRot);
      snapped.x = Math.floor(snapped.x * texelsPerUnit) / texelsPerUnit;
      snapped.y = Math.floor(snapped.y * texelsPerUnit) / texelsPerUnit;
      snapped.applyMatrix4(lightRot);

      light.position.copy(snapped).addScaledVector(this.direction, radius * 2.2);
      light.target.position.copy(snapped);
      light.target.updateMatrixWorld();

      const cam = light.shadow.camera;
      cam.left = -radius; cam.right = radius;
      cam.top = radius; cam.bottom = -radius;
      cam.near = 0.1;
      cam.far = radius * 4.6;
      cam.updateProjectionMatrix();
    }
  }
}

/* ------------------------------------------------------------- interior rig */

/**
 * Interior practical lights.
 *
 * Placed from the nav analysis: one warm source per sizeable room, hung at ceiling height
 * over the room's most open point. Only the N nearest to the camera are kept live, because
 * WebGL forward rendering pays for every light on every fragment.
 */
export class InteriorLights {
  constructor(scene, { budget = 8 } = {}) {
    this.scene = scene;
    this.budget = budget;
    this.sources = [];
    this.pool = [];
    for (let i = 0; i < budget; i++) {
      const l = new THREE.PointLight(0xffb877, 0, 14, 2);
      l.castShadow = false;
      l.visible = false;
      scene.add(l);
      this.pool.push(l);
    }
    this.fixtures = new THREE.Group();
    scene.add(this.fixtures);
  }

  /**
   * Builds the source list from explicit fixture positions emitted by the map builder
   * (paper lanterns overhead, stone lanterns in the courtyard).
   */
  buildFromPoints(points = []) {
    for (const p of points) {
      this.sources.push({
        pos: new THREE.Vector3(p.x, p.y, p.z),
        color: new THREE.Color(p.color ?? 0xffb877),
        intensity: p.intensity ?? 3.0,
        distance: p.distance ?? 9,
      });
    }
    return this.sources.length;
  }

  /** Activates the closest `budget` sources to the camera each frame. */
  update(cameraPos) {
    if (!this.sources.length) return;
    // Partial selection: cheaper than a full sort when there are hundreds of sources.
    const scored = this.sources;
    for (const s of scored) s._d = s.pos.distanceToSquared(cameraPos);
    const chosen = [];
    for (const s of scored) {
      if (chosen.length < this.budget) { chosen.push(s); continue; }
      let worst = 0;
      for (let i = 1; i < chosen.length; i++) if (chosen[i]._d > chosen[worst]._d) worst = i;
      if (s._d < chosen[worst]._d) chosen[worst] = s;
    }
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i], s = chosen[i];
      if (!s) { l.visible = false; l.intensity = 0; continue; }
      l.visible = true;
      l.position.copy(s.pos);
      l.color.copy(s.color);
      l.distance = s.distance;
      // Fade in with distance so swapping which source a slot holds is not a visible pop.
      const d = Math.sqrt(s._d);
      l.intensity = s.intensity * THREE.MathUtils.clamp(1 - (d - s.distance * 1.4) / 6, 0, 1);
    }
  }
}

/* ------------------------------------------------------------------ presets */

export const TIME_PRESETS = {
  afternoon: {
    // Sun sits high on purpose. A low afternoon angle looks better in isolation but the
    // hipped roof then shades the entire courtyard, and the courtyard is the map's
    // centrepiece — it has to read as an outdoor space from inside the ring.
    sun: new THREE.Vector3(0.25, 0.92, -0.30),
    sunColor: 0xfff0d8, sunIntensity: 3.4,
    hemiSky: 0x93b6dd, hemiGround: 0x776c5c, hemiIntensity: 1.1,
    turbidity: 3.2, rayleigh: 1.7, fog: 0x9fb2c4, fogDensity: 0.0030,
    exposure: 1.0,
  },
  dusk: {
    sun: new THREE.Vector3(0.86, 0.13, -0.49),
    sunColor: 0xffb070, sunIntensity: 2.2,
    hemiSky: 0x5b6d94, hemiGround: 0x2b2620, hemiIntensity: 0.42,
    turbidity: 5.6, rayleigh: 2.6, fog: 0x76708a, fogDensity: 0.0065,
    exposure: 1.12,
  },
  night: {
    sun: new THREE.Vector3(0.2, 0.32, -0.92),
    sunColor: 0x7d92c8, sunIntensity: 0.32,
    hemiSky: 0x1b2438, hemiGround: 0x0d0f14, hemiIntensity: 0.22,
    turbidity: 2.0, rayleigh: 0.6, fog: 0x121722, fogDensity: 0.011,
    exposure: 1.35,
  },
};

/** Assembles the full rig for a scene and returns handles for per-frame updates. */
export function buildLighting(scene, renderer, preset = 'afternoon', quality) {
  const p = TIME_PRESETS[preset] ?? TIME_PRESETS.afternoon;

  const sky = new Sky(p.sun.clone().normalize());
  sky.material.uniforms.uTurbidity.value = p.turbidity;
  sky.material.uniforms.uRayleigh.value = p.rayleigh;
  sky.material.uniforms.uSunIntensity.value = preset === 'night' ? 120.0 : 1000.0;
  scene.add(sky.mesh);

  scene.environment = sky.generateEnvironment(renderer);
  // Ambient has to stay well under the sun or every surface reads as flat cardboard —
  // the shape in this scene comes from the key light and the AO, not the IBL.
  // Most of Teahouse is roofed, so ambient does more work here than it would outdoors:
  // it is the only thing lighting the rooms the sun never reaches.
  scene.environmentIntensity = preset === 'night' ? 0.3 : 1.15;

  scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);

  // The map is a floating slab; without a ground plane every exterior angle and every
  // rappel shows black void under the building.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshStandardMaterial({
      color: preset === 'night' ? 0x14161c : 0x3c3a36,
      roughness: 0.98,
      metalness: 0.0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
  scene.add(hemi);

  const sun = new CascadedSun(scene, {
    cascades: quality.cascades,
    size: quality.shadowSize,
    maxDistance: quality.shadowDistance,
  });
  sun.setDirection(p.sun);
  sun.lights.forEach((l) => l.color.setHex(p.sunColor));
  sun.setIntensity(p.sunIntensity / sun.cascadeCount * 1.6);

  const interior = new InteriorLights(scene, { budget: quality.cascades >= 3 ? 12 : 6 });

  return { sky, sun, hemi, interior, preset: p };
}
