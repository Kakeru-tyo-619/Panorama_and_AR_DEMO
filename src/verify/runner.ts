/**
 * 検証の本体（three.js、命令的に書く）。段階 0：パノラマの 3D 表示 / 段階 1：カメラ映像＋仮マスク / 段階 2：人物の切り抜き。
 * 画面の端に半透明のデバッグパネルを出し、落ちたときの記録（RunLogger）も付ける。
 */
import * as THREE from 'three';
import { releaseCanvas } from '../lib/canvasUtil';
import { depthGrid, loadPanoAssets, preparePanoCanvas, type PanoAssets } from '../lib/panoAssets';
import { PANO_VERT, PanoCylinder, releaseRenderer, setCameraPose } from '../lib/panoMesh';
import { orientation, requestOrientationPermission, startSensors } from '../lib/sensors';
import { describeParams, type VerifyParams } from './params';
import { RunLogger } from './runLog';
import { PersonSegmenter } from './segmenter';
import type { VerifyData } from './verifyDb';

const FOV = 70;
const SEG_LONG_SIDE = 256;

const OVERLAY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 画面いっぱいに映す（cover）ための UV 計算はここで行う。仮マスク（uMode=0）は画面中央の楕円
const OVERLAY_FRAG = /* glsl */ `
uniform sampler2D tVideo;
uniform sampler2D tMask;
uniform vec2 uScale;
uniform float uMirror;
uniform float uMode;
varying vec2 vUv;
void main() {
  vec2 uv = (vUv - 0.5) * uScale + 0.5;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec3 c = texture2D(tVideo, uv).rgb;
  float a;
  if (uMode < 0.5) {
    vec2 p = (vUv - 0.5) / vec2(0.24, 0.36);
    a = 1.0 - smoothstep(0.92, 1.0, length(p));
  } else {
    a = smoothstep(0.3, 0.7, texture2D(tMask, uv).r);
  }
  gl_FragColor = vec4(c, a);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 skyColor; uniform vec3 groundColor; varying vec3 vPos;
void main() {
  float t = normalize(vPos).y;
  vec3 zenith = mix(skyColor, vec3(0.32, 0.5, 0.78), 0.45);
  vec3 nadir = groundColor * 0.55;
  vec3 c = t > 0.0 ? mix(skyColor, zenith, smoothstep(0.55, 1.0, t)) : mix(groundColor, nadir, smoothstep(-0.55, -1.0, t));
  gl_FragColor = vec4(c, 1.0);
}`;

type Hooks = { onExit: () => void; onError: (msg: string) => void };

export type Runner = { stop: () => void };

export async function startRun(
  host: HTMLElement,
  data: VerifyData,
  p: VerifyParams,
  initialMode: 'gyro' | 'drag',
  hooks: Hooks,
): Promise<Runner> {
  const assets = await loadPanoAssets({ panorama: data.pano, depthMap: data.depth, coverageMask: data.meta.coverage_mask });
  const stopSensors = startSensors();
  const t0 = performance.now();
  const config = describeParams(p);

  // ---- 計測値 ----
  const m = {
    renderFps: 0,
    camFps: 0,
    segFps: 0,
    segMs: 0, // 直近 30 回の平均
    segMsLast: 0,
    segRuns: 0,
    segDelegate: '-',
    segModel: '-',
    maskCount: 0,
    maskSize: '-',
    video: '-',
    textureMax: 0,
    panoTexture: `${assets.width}x${assets.height}`,
    gpuEstimateMB: 0,
    canvas: '-',
    error: '',
  };
  const segTimes: number[] = [];

  const snapshot = () => ({
    stage: p.stage,
    config,
    elapsedSec: Math.round((performance.now() - t0) / 1000),
    ...m,
    memory: { ...renderer.info.memory },
    dpr: p.dpr,
    devicePixelRatio: window.devicePixelRatio,
    ua: navigator.userAgent,
  });

  // ---- three.js ----
  const renderer = new THREE.WebGLRenderer({ antialias: p.msaa, powerPreference: 'high-performance' });
  renderer.setPixelRatio(p.dpr);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear = false;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  host.appendChild(renderer.domElement);
  m.textureMax = renderer.capabilities.maxTextureSize;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 300);
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
      fragmentShader: SKY_FRAG,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  const cyl = new PanoCylinder(assets.width, assets.height, p.meshX, p.meshY);
  const grid = p.depth && assets.depth ? depthGrid(assets.depth, cyl.segX, cyl.segY + 1) : null;
  cyl.setDepth(grid, p.ds);
  const panoMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    uniforms: { map: { value: null as THREE.Texture | null }, fade: { value: 0.1 } },
    vertexShader: PANO_VERT,
    fragmentShader: `
      uniform sampler2D map; uniform float fade; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(map, vUv);
        float a = smoothstep(0.0, fade, vUv.y) * smoothstep(0.0, fade, 1.0 - vUv.y);
        gl_FragColor = vec4(c.rgb, a);
      }`,
  });
  scene.add(new THREE.Mesh(cyl.geometry, panoMat));

  // パノラマのテクスチャ（本番の AR と同じ高解像度。ミップマップは既定で作らない）
  let panoTex: THREE.CanvasTexture | null = null;
  {
    const canvas = await preparePanoCanvas(assets as PanoAssets, 'view');
    panoTex = new THREE.CanvasTexture(canvas);
    panoTex.colorSpace = THREE.NoColorSpace;
    panoTex.wrapS = THREE.RepeatWrapping;
    panoTex.generateMipmaps = p.mipmap;
    panoTex.minFilter = p.mipmap ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    panoTex.anisotropy = p.mipmap ? Math.min(4, renderer.capabilities.getMaxAnisotropy()) : 1;
    panoTex.onUpdate = () => {
      panoTex!.onUpdate = null;
      releaseCanvas(canvas); // GPU へ送り終えたら CPU 側の Canvas は捨てる
    };
    panoMat.uniforms.map.value = panoTex;
  }
  const pixels = (w: number, h: number, mip: boolean) => w * h * 4 * (mip ? 1.33 : 1);
  const estimate = () => {
    let b = pixels(assets.width, assets.height, p.mipmap);
    if (video && video.videoWidth) b += pixels(video.videoWidth, video.videoHeight, false);
    if (maskState.out) b += maskState.out.length;
    m.gpuEstimateMB = Math.round((b / 1048576) * 10) / 10;
  };

  // ---- カメラ（段階 1 以上） ----
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let videoTex: THREE.VideoTexture | null = null;
  let facing = p.cam;
  let overlay: THREE.Mesh | null = null;
  let overlayMat: THREE.ShaderMaterial | null = null;
  const overlayScene = new THREE.Scene();
  const overlayCam = new THREE.Camera();
  let camFrames = 0;
  let rvfcId = 0;

  const openStream = async (f: 'back' | 'front') => {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: f === 'front' ? 'user' : 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    return s;
  };

  const setStream = async (f: 'back' | 'front') => {
    const old = stream;
    stream = await openStream(f);
    old?.getTracks().forEach((t) => t.stop());
    facing = f;
    video!.srcObject = stream;
    await video!.play();
    m.video = `${video!.videoWidth}x${video!.videoHeight} (${facing})`;
  };

  const maskState: { prev: Float32Array | null; out: Uint8Array | null } = { prev: null, out: null };
  let maskTex: THREE.DataTexture | null = null;
  const dummyMask = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  dummyMask.needsUpdate = true;

  if (p.stage >= 1) {
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    // 画面には出さない（iOS で再生状態を保つため DOM には置く）
    video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    await setStream(p.cam);
    // VideoTexture は requestVideoFrameCallback があればカメラのコマが更新されたときだけテクスチャを更新する
    videoTex = new THREE.VideoTexture(video);
    videoTex.colorSpace = THREE.NoColorSpace;
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.generateMipmaps = false;
    overlayMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tVideo: { value: videoTex },
        tMask: { value: dummyMask },
        uScale: { value: new THREE.Vector2(1, 1) },
        uMirror: { value: facing === 'front' ? 1 : 0 },
        uMode: { value: 0 },
      },
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
    });
    overlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMat);
    overlay.frustumCulled = false;
    overlayScene.add(overlay);

    if ('requestVideoFrameCallback' in video) {
      const v = video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number };
      const loop = () => {
        camFrames++;
        rvfcId = v.requestVideoFrameCallback(loop);
      };
      rvfcId = v.requestVideoFrameCallback(loop);
    }
  }

  // ---- 人物の切り抜き（段階 2） ----
  let segmenter: PersonSegmenter | null = null;
  let segTimer = 0;
  let segFrames = 0;
  let segLastTime = -1;
  let alive = true;
  if (p.stage >= 2) {
    segmenter = await PersonSegmenter.create(p.model, p.delegate, p.inv);
    m.segModel = p.model;
    m.segDelegate = segmenter.delegate;
    overlayMat!.uniforms.uMode.value = 1;
    const segCanvas = document.createElement('canvas');
    const sctx = segCanvas.getContext('2d', { willReadFrequently: false })!;
    let lastTs = 0;
    const tick = () => {
      if (!alive) return;
      const start = performance.now();
      try {
        if (video!.readyState >= 2 && video!.currentTime !== segLastTime && video!.videoWidth) {
          segLastTime = video!.currentTime;
          const vw = video!.videoWidth, vh = video!.videoHeight;
          const k = SEG_LONG_SIDE / Math.max(vw, vh);
          const w = Math.max(1, Math.round(vw * k)), h = Math.max(1, Math.round(vh * k));
          if (segCanvas.width !== w || segCanvas.height !== h) {
            segCanvas.width = w;
            segCanvas.height = h;
          }
          sctx.drawImage(video!, 0, 0, w, h);
          const ts = Math.max(start, lastTs + 1); // VIDEO モードでは時刻が増え続ける必要がある
          lastTs = ts;
          const r = segmenter!.segment(segCanvas, ts, p.mix, maskState);
          if (r) {
            if (!maskTex || maskTex.image.width !== r.width || maskTex.image.height !== r.height) {
              maskTex?.dispose();
              maskTex = new THREE.DataTexture(maskState.out!, r.width, r.height, THREE.RedFormat, THREE.UnsignedByteType);
              maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter;
              maskTex.generateMipmaps = false;
              maskTex.flipY = false;
              overlayMat!.uniforms.tMask.value = maskTex;
            }
            maskTex.needsUpdate = true;
            m.maskCount = r.maskCount;
            m.maskSize = `${r.width}x${r.height}`;
            const cost = performance.now() - start;
            m.segMsLast = Math.round(cost * 10) / 10;
            segTimes.push(cost);
            if (segTimes.length > 30) segTimes.shift();
            m.segMs = Math.round((segTimes.reduce((a, b) => a + b, 0) / segTimes.length) * 10) / 10;
            m.segRuns++;
            segFrames++;
          }
        }
      } catch (e) {
        console.error(e);
        m.error = `切り抜きエラー: ${(e as Error).message ?? e}`;
      }
      const cost = performance.now() - start;
      segTimer = window.setTimeout(tick, Math.max(0, 1000 / p.segHz - cost));
    };
    segTimer = window.setTimeout(tick, 0);
  }

  // ---- 操作（ドラッグ / ジャイロ） ----
  let mode: 'gyro' | 'drag' = initialMode;
  const offset = data.meta.heading_start;
  const maxPitch = Math.max(5, cyl.maxElevationDeg() - FOV / 2 + 10);
  const view = { yaw: 0, pitch: 0 };
  let dragging = false, lx = 0, ly = 0;
  const el = renderer.domElement;
  const down = (e: PointerEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent) => {
    if (!dragging || mode !== 'drag') return;
    view.yaw -= (e.clientX - lx) * 0.15;
    view.pitch = Math.max(-maxPitch, Math.min(maxPitch, view.pitch + (e.clientY - ly) * 0.15));
    lx = e.clientX; ly = e.clientY;
  };
  const up = () => (dragging = false);
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false); // 見た目の大きさは CSS（100%）に任せる
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    m.canvas = `${renderer.domElement.width}x${renderer.domElement.height}`;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const updateCover = () => {
    if (!video || !video.videoWidth || !overlayMat) return;
    const sa = host.clientWidth / host.clientHeight, va = video.videoWidth / video.videoHeight;
    overlayMat.uniforms.uScale.value.set(va > sa ? sa / va : 1, va > sa ? 1 : va / sa);
    overlayMat.uniforms.uMirror.value = facing === 'front' ? 1 : 0;
  };

  // ---- デバッグパネル ----
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:11px/1.45 ui-monospace,monospace;color:#fff';
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:absolute;left:6px;top:calc(env(safe-area-inset-top,0px) + 6px);margin:0;max-width:calc(100% - 12px);padding:6px 8px;background:rgba(0,0,0,.55);border-radius:6px;white-space:pre-wrap;word-break:break-all;pointer-events:none';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;left:6px;right:6px;bottom:calc(env(safe-area-inset-bottom,0px) + 8px);display:flex;flex-wrap:wrap;gap:6px;pointer-events:auto';
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:8px 10px;border-radius:8px;border:0;background:rgba(0,0,0,.6);color:#fff;font:12px sans-serif';
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };
  let hudShown = true;
  const hideBtn = mk('HUD隠す', () => {
    hudShown = !hudShown;
    pre.style.display = hudShown ? 'block' : 'none';
    hideBtn.textContent = hudShown ? 'HUD隠す' : 'HUD表示';
  });
  const copyBtn = mk('JSONコピー', () => {
    const text = JSON.stringify(snapshot(), null, 2);
    const done = () => (copyBtn.textContent = 'コピーしました');
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { copyBtn.textContent = 'コピー失敗'; }
      ta.remove();
    };
    (navigator.clipboard?.writeText(text).then(done, fallback)) ?? fallback();
    setTimeout(() => (copyBtn.textContent = 'JSONコピー'), 2000);
  });
  const modeBtn = mk(mode === 'gyro' ? 'ドラッグに切替' : 'ジャイロに切替', async () => {
    if (mode === 'gyro') mode = 'drag';
    else {
      const r = await requestOrientationPermission();
      if (r === 'denied') { m.error = '方位センサーの使用が許可されませんでした'; return; }
      mode = 'gyro';
    }
    modeBtn.textContent = mode === 'gyro' ? 'ドラッグに切替' : 'ジャイロに切替';
  });
  if (p.stage >= 1) {
    mk('前面/背面', () => {
      setStream(facing === 'front' ? 'back' : 'front').then(updateCover, (e) => (m.error = `カメラ切替: ${(e as Error).message ?? e}`));
    });
  }
  mk('終了', () => hooks.onExit());
  hud.append(pre, bar);
  host.appendChild(hud);

  const logger = new RunLogger(p.stage, config, snapshot);

  const fmt = () => {
    const s = snapshot();
    const el = s.elapsedSec;
    const lines = [
      `段階 ${p.stage}  ${config}`,
      `経過 ${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}   描画 ${m.renderFps}/s${p.stage >= 1 ? `   カメラ ${m.camFps}/s` : ''}`,
    ];
    if (p.stage >= 2)
      lines.push(`切り抜き ${m.segFps}/s  ${m.segMsLast}ms (平均 ${m.segMs}ms)  ${m.segModel}/${m.segDelegate}  mask ${m.maskSize} x${m.maskCount}枚`);
    lines.push(
      `memory: geometries ${s.memory.geometries}, textures ${s.memory.textures}`,
      `パノラマ ${m.panoTexture} (最大 ${m.textureMax})  GPU概算 ${m.gpuEstimateMB}MB`,
      `画面 ${m.canvas}  dpr ${p.dpr}${p.stage >= 1 ? `  映像 ${m.video}` : ''}${assets.depth ? '' : '  奥行きなし'}`,
    );
    if (m.error) lines.push(`⚠ ${m.error}`);
    return lines.join('\n');
  };

  // ---- 描画ループ ----
  let raf = 0;
  let frames = 0;
  let statT = performance.now();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const ori = orientation.get();
    if (mode === 'gyro' && ori.started && ori.updatedAt > 0) {
      view.yaw = ori.heading - offset;
      view.pitch = Math.max(-maxPitch, Math.min(maxPitch, ori.pitch));
      setCameraPose(camera, view.yaw, view.pitch, ori.roll);
    } else {
      setCameraPose(camera, view.yaw, view.pitch, 0);
    }
    renderer.clear();
    renderer.render(scene, camera);
    if (overlay && video && video.videoWidth) {
      updateCover();
      renderer.clearDepth();
      renderer.render(overlayScene, overlayCam);
    }
    frames++;
    if (now - statT >= 1000) {
      const dt = (now - statT) / 1000;
      m.renderFps = Math.round(frames / dt);
      m.camFps = Math.round(camFrames / dt);
      m.segFps = Math.round(segFrames / dt);
      frames = camFrames = segFrames = 0;
      statT = now;
      estimate();
      pre.textContent = fmt();
    }
  };
  loop();

  return {
    stop: () => {
      alive = false;
      logger.finish();
      cancelAnimationFrame(raf);
      clearTimeout(segTimer);
      ro.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      try { segmenter?.close(); } catch { /* ignore */ }
      if (video && rvfcId && 'cancelVideoFrameCallback' in video) (video as HTMLVideoElement & { cancelVideoFrameCallback: (n: number) => void }).cancelVideoFrameCallback(rvfcId);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) { video.pause(); video.srcObject = null; video.remove(); }
      videoTex?.dispose();
      maskTex?.dispose();
      dummyMask.dispose();
      overlayMat?.dispose();
      overlay?.geometry.dispose();
      panoTex?.dispose();
      panoMat.dispose();
      cyl.geometry.dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      stopSensors();
      hud.remove();
      releaseRenderer(renderer);
    },
  };
}
