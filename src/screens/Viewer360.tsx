import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { DEG, angleDiff } from '../lib/angles';
import { depthGrid, type PanoAssets } from '../lib/panoAssets';
import { PANO_VERT, PanoCylinder, makeTexture, releaseRenderer, setCameraPose } from '../lib/panoMesh';
import { orientation, requestOrientationPermission, startSensors } from '../lib/sensors';
import { metrics, settings, useStore } from '../lib/store';

const FOV = 70;

type Props = {
  assets: PanoAssets;
  headingStart: number;
  headingCorrection?: number | null;
  /** 見ている方位（北基準）。パノラマを切り替えても同じ方向を向いたままにするために共有する */
  view?: { current: { heading: number; pitch: number } };
};

export function Viewer360({ assets, headingStart, headingCorrection, view }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'drag' | 'gyro'>('drag');
  const [sway, setSway] = useState(false);
  const [permMsg, setPermMsg] = useState('');
  const modeRef = useRef(mode);
  const swayRef = useRef(sway);
  modeRef.current = mode;
  swayRef.current = sway;
  const o = useStore(orientation);

  useEffect(() => {
    const host = hostRef.current!;
    const stopSensors = startSensors();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 300);

    // 空と地面のグラデーション（円筒の上下の端を自然に消す）
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(120, 32, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          skyColor: { value: new THREE.Vector3(...assets.skyColor) },
          groundColor: { value: new THREE.Vector3(...assets.groundColor) },
        },
        vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `
          uniform vec3 skyColor; uniform vec3 groundColor; varying vec3 vPos;
          void main(){
            float t = normalize(vPos).y;
            vec3 zenith = mix(skyColor, vec3(0.32,0.5,0.78), 0.45);
            vec3 nadir = groundColor * 0.55;
            vec3 c = t > 0.0 ? mix(skyColor, zenith, smoothstep(0.55, 1.0, t)) : mix(groundColor, nadir, smoothstep(-0.55, -1.0, t));
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -1;
    scene.add(sky);

    const cyl = new PanoCylinder(assets.width, assets.height);
    const grid = assets.depth ? depthGrid(assets.depth, cyl.segX, cyl.segY + 1) : null;
    cyl.setDepth(grid, settings.get().depthStrength);
    const tex = makeTexture(assets.viewCanvas, renderer);
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { map: { value: tex }, fade: { value: 0.1 } },
      vertexShader: PANO_VERT,
      fragmentShader: `
        uniform sampler2D map; uniform float fade; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(map, vUv);
          float a = smoothstep(0.0, fade, vUv.y) * smoothstep(0.0, fade, 1.0 - vUv.y);
          gl_FragColor = vec4(c.rgb, a);
        }`,
    });
    scene.add(new THREE.Mesh(cyl.geometry, mat));
    const unsubSettings = settings.subscribe(() => cyl.setDepth(grid, settings.get().depthStrength));

    // 見上げ角の制限：円筒の上下の端が見えすぎないように
    const maxPitch = Math.max(5, cyl.maxElevationDeg() - FOV / 2 + 10);

    // 画像上の向き（yaw）= 北基準の方位 − heading_start + heading_correction
    const offset = headingStart - (headingCorrection ?? 0);
    const state = {
      yaw: view ? view.current.heading - offset : 0,
      pitch: view ? Math.max(-maxPitch, Math.min(maxPitch, view.current.pitch)) : 0,
      dragX: 0,
      dragging: false,
      lat: 0,
      vert: 0,
      base: null as null | { p: number; r: number },
    };
    let lastX = 0, lastY = 0;
    const el = renderer.domElement;
    const down = (e: PointerEvent) => {
      state.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!state.dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (modeRef.current === 'drag') {
        state.yaw -= dx * 0.15;
        state.pitch = Math.max(-maxPitch, Math.min(maxPitch, state.pitch + dy * 0.15));
      }
      state.dragX = Math.max(-150, Math.min(150, state.dragX + dx));
    };
    const up = () => (state.dragging = false);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    let frames = 0;
    let fpsT = performance.now();
    const t0 = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const P = settings.get().parallax;
      const ori = orientation.get();
      const hasSensor = ori.started && ori.updatedAt > 0;
      let roll = 0;
      let latTarget = 0, vertTarget = 0;
      if (modeRef.current === 'gyro' && hasSensor) {
        state.yaw = ori.heading - offset;
        state.pitch = Math.max(-maxPitch, Math.min(maxPitch, ori.pitch));
        roll = ori.roll;
        latTarget = Math.max(-1, Math.min(1, ori.roll / 25)) * P;
      } else if (hasSensor && ori.source !== 'mock') {
        // ドラッグ操作中でも、スマホを傾けた方向に少し平行移動する
        if (!state.base) state.base = { p: ori.pitch, r: ori.roll };
        latTarget = Math.max(-1, Math.min(1, angleDiff(ori.roll, state.base.r) / 20)) * P;
        vertTarget = Math.max(-1, Math.min(1, (ori.pitch - state.base.p) / 20)) * P * 0.5;
      }
      if (!state.dragging) state.dragX *= 0.9; // 指を離したらゆっくり戻る
      latTarget += (-state.dragX / 150) * P;
      if (swayRef.current) latTarget += Math.sin((now - t0) / 700) * P;
      state.lat += (latTarget - state.lat) * 0.15;
      state.vert += (vertTarget - state.vert) * 0.15;

      setCameraPose(camera, state.yaw, state.pitch, roll);
      if (view) view.current = { heading: state.yaw + offset, pitch: state.pitch };
      // 中心から少しだけ動かして視差を出す：前方（腕の長さ相当）+ 左右 + 上下
      const y = state.yaw * DEG, p = state.pitch * DEG;
      const fwd = new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
      const right = new THREE.Vector3(Math.cos(y), 0, Math.sin(y));
      camera.position.copy(fwd.multiplyScalar(P * 0.5)).addScaledVector(right, state.lat).add(new THREE.Vector3(0, state.vert, 0));

      renderer.render(scene, camera);
      frames++;
      if (now - fpsT > 1000) {
        metrics.set({ fps: Math.round((frames * 1000) / (now - fpsT)) });
        frames = 0;
        fpsT = now;
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubSettings();
      stopSensors();
      tex.dispose();
      mat.dispose();
      cyl.geometry.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      releaseRenderer(renderer);
    };
  }, [assets, headingStart, headingCorrection, view]);

  const toggleGyro = async () => {
    if (mode === 'gyro') return setMode('drag');
    const r = await requestOrientationPermission();
    if (r === 'denied') setPermMsg('方位センサーの使用が許可されませんでした');
    else setPermMsg('');
    setMode('gyro');
  };

  return (
    <div className="viewer-host" ref={hostRef}>
      <div className="viewer-controls">
        <div className="seg">
          <button className={mode === 'drag' ? 'on' : ''} onClick={() => setMode('drag')}>ドラッグ</button>
          <button className={mode === 'gyro' ? 'on' : ''} onClick={toggleGyro}>ジャイロ</button>
        </div>
        <label className="chk">
          <input type="checkbox" checked={sway} onChange={(e) => setSway(e.target.checked)} /> 自動で揺らす
        </label>
      </div>
      {!assets.depth && <div className="viewer-note">奥行きマップがないため平面で表示しています</div>}
      {mode === 'gyro' && o.updatedAt === 0 && <div className="viewer-note">方位センサーの値を待っています…</div>}
      {permMsg && <div className="viewer-note warn">{permMsg}</div>}
    </div>
  );
}
