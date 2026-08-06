/**
 * Free-look camera.
 *
 * Used for engine bring-up, the map fly-through behind the main menu, and — with
 * `collide` disabled — the spectator client's free cam.
 */
import * as THREE from 'three';

export function attachFreeCam(camera, canvas, renderer, opts = {}) {
  const state = {
    yaw: camera.rotation.y, pitch: 0,
    vel: new THREE.Vector3(),
    speed: opts.speed ?? 6,
    boost: 3.2,
    keys: new Set(),
    locked: false,
    sensitivity: opts.sensitivity ?? 0.0022,
    smoothing: opts.smoothing ?? 0.16,
  };

  const onKeyDown = (e) => {
    state.keys.add(e.code);
    if (e.code === 'Escape' && document.pointerLockElement) document.exitPointerLock();
  };
  const onKeyUp = (e) => state.keys.delete(e.code);
  const onWheel = (e) => {
    state.speed = THREE.MathUtils.clamp(state.speed * (e.deltaY < 0 ? 1.14 : 0.88), 0.4, 60);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!state.locked) return;
    state.yaw -= e.movementX * state.sensitivity;
    state.pitch -= e.movementY * state.sensitivity;
    state.pitch = THREE.MathUtils.clamp(state.pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    renderer?.resetHistory();
  };
  const onClick = () => { if (!state.locked) canvas.requestPointerLock(); };
  const onLockChange = () => { state.locked = document.pointerLockElement === canvas; };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);
  document.addEventListener('pointerlockchange', onLockChange);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const want = new THREE.Vector3();

  return {
    state,
    update(dt) {
      camera.rotation.set(0, 0, 0, 'YXZ');
      camera.rotateY(state.yaw);
      camera.rotateX(state.pitch);

      forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);

      want.set(0, 0, 0);
      const k = state.keys;
      if (k.has('KeyW')) want.add(forward);
      if (k.has('KeyS')) want.sub(forward);
      if (k.has('KeyD')) want.add(right);
      if (k.has('KeyA')) want.sub(right);
      if (k.has('Space')) want.add(up);
      if (k.has('KeyC') || k.has('ControlLeft')) want.sub(up);
      if (want.lengthSq() > 0) want.normalize();

      const speed = state.speed * (k.has('ShiftLeft') ? state.boost : 1);
      want.multiplyScalar(speed);

      // Critically-damped-ish approach so the camera never snaps.
      const a = 1 - Math.pow(1 - state.smoothing, dt * 60);
      state.vel.lerp(want, a);
      camera.position.addScaledVector(state.vel, dt);
      if (state.vel.lengthSq() > 1e-6) renderer?.resetHistory();
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };
}
