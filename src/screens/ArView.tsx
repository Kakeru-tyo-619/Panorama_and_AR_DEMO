import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { DEG, focalFromHfov } from '../lib/angles';
import { CAMERA_CONSTRAINTS, openMockCamera, openRealCamera, type CameraSource } from '../lib/camera';
import type { PanoAssets } from '../lib/panoAssets';
import { PANO_VERT, PanoCylinder, loadPanoTexture, releaseRenderer, setCameraPose } from '../lib/panoMesh';
import { orientation, requestOrientationPermission, startSensors } from '../lib/sensors';
import { isMock, metrics, settings, useStore } from '../lib/store';
import type { PanoramaRecord } from '../lib/types';

type Props = { assets: PanoAssets; panorama: Pick<PanoramaRecord, 'heading_start' | 'heading_correction'>; hfov: number };

export function ArView({ assets, panorama, hfov }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const camHostRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<CameraSource | null>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState(0);
  const [wipe, setWipe] = useState(false);
  const [wipeX, setWipeX] = useState(0.5);
  const [texState, setTexState] = useState<'loading' | 'ready' | 'error'>('loading');
  const s = useStore(settings);
  const live = useRef({ manual, wipe, wipeX });
  live.current = { manual, wipe, wipeX };

  const start = async () => {
    setError('');
    // iOS ではユーザー操作の中で両方を要求する
    const permP = requestOrientationPermission();
    try {
      const camP = isMock() ? null : navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      const perm = await permP;
      if (perm === 'denied') setError('方位センサーの使用が許可されませんでした');
      const source = camP ? await openRealCamera(await camP) : openMockCamera();
      setCam(source);
    } catch (e) {
      setError(`カメラを開始できません: ${(e as Error).message}`);
    }
  };

  // カメラ映像を背景に置く。画面を離れるときは必ず停止する
  useEffect(() => {
    if (!cam) return;
    const host = camHostRef.current!;
    cam.el.className = 'cam-bg';
    host.appendChild(cam.el);
    return () => {
      cam.stop();
      cam.el.remove();
    };
  }, [cam]);

  useEffect(() => {
    if (!cam) return;
    const host = hostRef.current!;
    const stopSensors = startSensors();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100);

    const cyl = new PanoCylinder(assets.width, assets.height, 256, 64);
    let depthTex: THREE.DataTexture | null = null;
    if (assets.depth) {
      // 画像の上端が v=1 になるよう行を反転して渡す
      const { data, width, height } = assets.depth;
      const flipped = new Uint8Array(data.length);
      for (let y = 0; y < height; y++) flipped.set(data.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
      depthTex = new THREE.DataTexture(flipped, width, height, THREE.RedFormat);
      depthTex.unpackAlignment = 1;
      depthTex.wrapS = THREE.RepeatWrapping;
      depthTex.magFilter = THREE.LinearFilter;
      depthTex.minFilter = THREE.LinearFilter;
      depthTex.needsUpdate = true;
    }
    const uniforms = {
      map: { value: null as THREE.Texture | null },
      depthMap: { value: depthTex },
      hasDepth: { value: depthTex ? 1 : 0 },
      threshold: { value: 0.35 },
      soft: { value: 0.06 },
      opacity: { value: 0.8 },
      wipeOn: { value: 0 },
      wipeX: { value: 0.5 },
      resolution: { value: new THREE.Vector2(1, 1) },
    };
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      uniforms,
      vertexShader: PANO_VERT,
      fragmentShader: `
        uniform sampler2D map; uniform sampler2D depthMap;
        uniform float hasDepth, threshold, soft, opacity, wipeOn, wipeX;
        uniform vec2 resolution;
        varying vec2 vUv;
        void main(){
          vec4 c = texture2D(map, vUv);
          float fade = smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
          if (wipeOn > 0.5) {
            // ワイプ：左＝カメラ映像、右＝パノラマ
            if (gl_FragCoord.x < wipeX * resolution.x) discard;
            gl_FragColor = vec4(c.rgb, c.a * fade);
            return;
          }
          float m = 1.0;
          if (hasDepth > 0.5) {
            // 近いほど白。しきい値より遠い（暗い）部分だけを表示し、境目はぼかす
            float d = texture2D(depthMap, vUv).r;
            m = 1.0 - smoothstep(threshold - soft, threshold + soft, d);
          }
          gl_FragColor = vec4(c.rgb, c.a * m * opacity * fade);
        }`,
    });
    scene.add(new THREE.Mesh(cyl.geometry, mat));
    const disposeTexture = loadPanoTexture(renderer, assets, 'ar', (t) => (uniforms.map.value = t), setTexState);

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h);
      const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
      uniforms.resolution.value.copy(buf);
      camera.aspect = w / h;
      // 背景のカメラ映像（object-fit: cover）と同じ画角にする
      const vw = cam.width() || 1, vh = cam.height() || 1;
      const scale = Math.max(w / vw, h / vh);
      const fDisp = focalFromHfov(vw, hfov) * scale;
      camera.fov = (2 * Math.atan(h / 2 / fDisp)) / DEG;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    const video = cam.el instanceof HTMLVideoElement ? cam.el : null;
    video?.addEventListener('resize', resize);

    let raf = 0, frames = 0, fpsT = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const o = orientation.get();
      const st = settings.get();
      const L = live.current;
      uniforms.threshold.value = st.arThreshold;
      uniforms.soft.value = st.arSoftness;
      uniforms.opacity.value = st.arOpacity;
      uniforms.wipeOn.value = L.wipe ? 1 : 0;
      uniforms.wipeX.value = L.wipeX;
      // 表示範囲の中心 = 現在の方位 − heading_start + heading_correction（+ 手動の微調整）
      const yaw = o.heading - panorama.heading_start + (panorama.heading_correction ?? 0) + L.manual;
      setCameraPose(camera, yaw, o.pitch, o.roll);
      renderer.render(scene, camera);
      frames++;
      const now = performance.now();
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
      video?.removeEventListener('resize', resize);
      stopSensors();
      disposeTexture();
      depthTex?.dispose();
      mat.dispose();
      cyl.geometry.dispose();
      releaseRenderer(renderer);
    };
  }, [cam, assets, panorama, hfov]);

  return (
    <div className="ar-root">
      {cam && texState === 'loading' && <div className="loading-chip">画像を準備中…</div>}
      {cam && texState === 'error' && <div className="loading-chip warn">画像を表示できませんでした。画面を開き直してください</div>}
      <div className="ar-cam" ref={camHostRef} />
      <div className="ar-gl" ref={hostRef} />
      {wipe && <div className="wipe-line" style={{ left: `${wipeX * 100}%` }} />}
      {!cam && (
        <div className="center-box">
          <p>カメラ映像に、今向いている方位のパノラマ（遠景）を重ねます。</p>
          <button className="primary" onClick={start}>AR を開始</button>
          {error && <p className="warn">{error}</p>}
        </div>
      )}
      {cam && (
        <div className="ar-panel">
          {error && <div className="warn">{error}</div>}
          <div className="seg">
            <button className={!wipe ? 'on' : ''} onClick={() => setWipe(false)}>重ねる</button>
            <button className={wipe ? 'on' : ''} onClick={() => setWipe(true)}>ワイプ比較</button>
          </div>
          {wipe ? (
            <Slider label="ワイプ位置" min={0} max={1} step={0.01} value={wipeX} onChange={setWipeX} fmt={(v) => `${Math.round(v * 100)}%`} />
          ) : (
            <>
              <Slider label="不透明度" min={0} max={1} step={0.01} value={s.arOpacity} onChange={(v) => settings.set({ arOpacity: v })} fmt={(v) => v.toFixed(2)} />
              <Slider
                label={assets.depth ? '奥行きしきい値' : '奥行きしきい値（奥行きなし）'}
                min={0} max={1} step={0.01} value={s.arThreshold}
                onChange={(v) => settings.set({ arThreshold: v })} fmt={(v) => v.toFixed(2)}
              />
            </>
          )}
          <Slider label="左右の微調整" min={-30} max={30} step={0.5} value={manual} onChange={setManual} fmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`} />
        </div>
      )}
    </div>
  );
}

export function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="val">{props.fmt ? props.fmt(props.value) : props.value}</span>
    </label>
  );
}
