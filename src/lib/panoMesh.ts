import * as THREE from 'three';
import { DEG } from './angles';
import { releaseCanvas } from './canvasUtil';
import { preparePanoCanvas, type PanoAssets } from './panoAssets';

export const BASE_RADIUS = 10; // 「メートル」相当

/**
 * パノラマを内側に貼る円筒（縦横に細かく分割）。
 * three.js の座標：北 = -z、東 = +x、上 = +y。方位 a の方向は (sin a, h, -cos a)。
 * 各頂点は中心からの方向ベクトル×半径で置くので、中心から見ると奥行きに関係なく同じ見え方になる。
 */
export class PanoCylinder {
  readonly geometry = new THREE.BufferGeometry();
  readonly hmax: number;
  private dirs: Float32Array;
  private positions: Float32Array;

  constructor(
    panoWidth: number,
    panoHeight: number,
    readonly segX = 512,
    readonly segY = 128,
  ) {
    const s = panoWidth / (2 * Math.PI);
    this.hmax = panoHeight / 2 / s; // 上端の円筒の高さ（= tan(仰角)）
    const nv = (segX + 1) * (segY + 1);
    this.dirs = new Float32Array(nv * 3);
    this.positions = new Float32Array(nv * 3);
    const uvs = new Float32Array(nv * 2);
    for (let i = 0; i <= segY; i++) {
      const h = this.hmax * (1 - (2 * i) / segY);
      for (let j = 0; j <= segX; j++) {
        const a = (j / segX) * Math.PI * 2;
        const k = i * (segX + 1) + j;
        this.dirs[k * 3] = Math.sin(a);
        this.dirs[k * 3 + 1] = h;
        this.dirs[k * 3 + 2] = -Math.cos(a);
        uvs[k * 2] = j / segX;
        uvs[k * 2 + 1] = 1 - i / segY;
      }
    }
    const idx = new Uint32Array(segX * segY * 6);
    let t = 0;
    for (let i = 0; i < segY; i++) {
      for (let j = 0; j < segX; j++) {
        const a = i * (segX + 1) + j, b = a + 1, c = a + segX + 1, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.setDepth(null, 0);
  }

  /** 半径 = 基準半径 ×（1 − 奥行きの強さ × 奥行き値） */
  setDepth(grid: Float32Array | null, strength: number) {
    const { segX, segY } = this;
    for (let i = 0; i <= segY; i++) {
      for (let j = 0; j <= segX; j++) {
        const k = i * (segX + 1) + j;
        const d = grid ? grid[i * segX + (j % segX)] : 0;
        const r = BASE_RADIUS * (1 - Math.min(0.95, strength * d));
        this.positions[k * 3] = this.dirs[k * 3] * r;
        this.positions[k * 3 + 1] = this.dirs[k * 3 + 1] * r;
        this.positions[k * 3 + 2] = this.dirs[k * 3 + 2] * r;
      }
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  maxElevationDeg() {
    return Math.atan(this.hmax) / DEG;
  }
}

export const PANO_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export function makeTexture(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // シェーダーで sRGB の値をそのまま出す
  tex.wrapS = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

/** カメラの向き（パノラマ座標での方位・仰角・ロール、度）を設定 */
export function setCameraPose(cam: THREE.Camera, yaw: number, pitch: number, roll = 0) {
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch * DEG, -yaw * DEG, -roll * DEG);
}

/**
 * 3D 表示を閉じるときの片付け。renderer.dispose() だけでは WebGL のコンテキスト（GPU のメモリ）が残り、
 * iOS Safari では画面を開き直すたびに積み重なってメモリ不足になるため、forceContextLoss() で確実に手放す。
 */
export function releaseRenderer(renderer: THREE.WebGLRenderer) {
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

/**
 * パノラマのテクスチャを用意する。表示用の画像は用途（360度ビュー / AR）の分だけ作り、
 * GPU に送り終わったら CPU 側の Canvas はすぐ捨てる。
 * iOS などで GPU 側の画像が失われた（コンテキストロスト）あとに戻ってきたら、画像を作り直して送り直す。
 * WebGL2 ではテクスチャの領域が最初の画像の大きさで固定されるため、画像ができるたびに新しいテクスチャを作って onTexture で渡す。
 */
export function loadPanoTexture(
  renderer: THREE.WebGLRenderer,
  assets: PanoAssets,
  purpose: 'view' | 'ar',
  onTexture: (tex: THREE.Texture) => void,
  onState: (s: 'loading' | 'ready' | 'error') => void,
) {
  let alive = true;
  let current: THREE.Texture | null = null;

  const load = () => {
    onState('loading');
    preparePanoCanvas(assets, purpose)
      .then((canvas) => {
        if (!alive) return releaseCanvas(canvas);
        const tex = makeTexture(canvas, renderer);
        // GPU への転送が終わったら呼ばれる
        tex.onUpdate = () => {
          tex.onUpdate = null;
          releaseCanvas(canvas);
          if (alive) onState('ready');
        };
        current?.dispose();
        current = tex;
        onTexture(tex);
      })
      .catch((e) => {
        console.error(e);
        if (alive) onState('error');
      });
  };
  const onRestored = () => alive && load();
  renderer.domElement.addEventListener('webglcontextrestored', onRestored);
  load();

  return () => {
    alive = false;
    renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
    current?.dispose();
  };
}
