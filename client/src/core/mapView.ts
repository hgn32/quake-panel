import {
  KMONI_CAPTION_BOX,
  KMONI_MAP,
  projectToPixel,
  type EewState,
  type TsunamiInfo,
} from '@quake-panel/shared';
import { Basemap, DARK_THEME } from './basemap.js';
import type { FrameImages } from './frameStream.js';

export type ViewMode = 'japan' | 'home';

export interface MapViewOptions {
  /** 観測点の発光表現。Pi4 で重い場合に切れるようにしておく。 */
  glow: boolean;
  /** 配信画像に焼き込まれた見出し帯を描かない (§KMONI_CAPTION_BOX の説明を参照) */
  hideCaption: boolean;
  mode: ViewMode;
  home: { name: string; lat: number; lon: number };
}

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 地図描画コア。
 *
 * UI フレームワークに依存しない (§5 推奨構成)。毎秒の描画パスはここに閉じており、
 * 画面部品の更新とは完全に分離してある。
 */
export class MapView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly basemap = new Basemap();
  private frame: FrameImages | null = null;
  private eew: EewState | null = null;
  private tsunami: TsunamiInfo | null = null;
  private transform: Transform = { scale: 1, offsetX: 0, offsetY: 0 };
  private cssSize = { width: 0, height: 0 };
  private dpr = 1;
  private animationHandle: number | null = null;
  private animating = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private options: MapViewOptions,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
  }

  async init(): Promise<void> {
    try {
      await this.basemap.load();
    } catch (error) {
      // 背景地図が無くても kmoni 画像だけで成立させる (単体で成立させる方針 §1)
      console.warn('背景地図の読み込みに失敗しました', error);
    }
    this.observeResize();
    this.resize();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopAnimation();
  }

  setOptions(patch: Partial<MapViewOptions>): void {
    this.options = { ...this.options, ...patch };
    this.resize();
  }

  setFrame(frame: FrameImages): void {
    this.frame = frame;
    this.requestRender();
  }

  setEew(eew: EewState | null): void {
    this.eew = eew;
    this.syncAnimation();
  }

  setTsunami(tsunami: TsunamiInfo | null): void {
    this.tsunami = tsunami;
    this.syncAnimation();
  }

  /** 脈動する要素がある間だけ連続描画する。平常時は毎秒 1 回で済ませる。 */
  private isAnimating(): boolean {
    const eewActive = this.eew !== null && !this.eew.isCancel;
    const tsunamiActive =
      this.tsunami !== null && !this.tsunami.cancelled && this.tsunami.areas.length > 0;
    return eewActive || tsunamiActive;
  }

  private syncAnimation(): void {
    if (this.isAnimating()) this.startAnimation();
    else {
      this.stopAnimation();
      this.requestRender();
    }
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    // フル HD キオスクでは DPR=1。高 DPI 端末でも 2 で頭打ちにして描画量を抑える。
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssSize = { width, height };
    this.canvas.width = Math.floor(width * this.dpr);
    this.canvas.height = Math.floor(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.transform = this.computeTransform(width, height);
    this.requestRender();
  }

  private computeTransform(width: number, height: number): Transform {
    const view =
      this.options.mode === 'home'
        ? homeViewport(this.options.home)
        : { x: 0, y: 0, width: KMONI_MAP.width, height: KMONI_MAP.height };
    const scale = Math.min(width / view.width, height / view.height);
    return {
      scale,
      offsetX: (width - view.width * scale) / 2 - view.x * scale,
      offsetY: (height - view.height * scale) / 2 - view.y * scale,
    };
  }

  private requestRender(): void {
    if (this.animationHandle !== null) return;
    this.animationHandle = requestAnimationFrame(() => {
      this.animationHandle = null;
      this.render();
    });
  }

  private startAnimation(): void {
    if (this.animating) return;
    this.animating = true;
    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);
    const loop = (): void => {
      this.render();
      this.animationHandle = this.animating ? requestAnimationFrame(loop) : null;
    };
    this.animationHandle = requestAnimationFrame(loop);
  }

  private stopAnimation(): void {
    this.animating = false;
    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);
    this.animationHandle = null;
  }

  private render(): void {
    const ctx = this.ctx;
    const { width, height } = this.cssSize;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = DARK_THEME.sea;
    ctx.fillRect(0, 0, width, height);

    this.basemap.draw(ctx, this.transform, { width, height });
    this.drawTsunamiAreas(ctx);
    this.drawKmoniLayers(ctx);
    this.drawHomeMarker(ctx);
    this.drawEpicenter(ctx);

    ctx.restore();
  }

  /** 津波予報区の強調。宮崎県沿岸 (利用地) は特に目立たせる (§3)。 */
  private drawTsunamiAreas(ctx: CanvasRenderingContext2D): void {
    const tsunami = this.tsunami;
    if (!tsunami || tsunami.cancelled || tsunami.areas.length === 0) return;
    const pulse = 0.16 + 0.1 * Math.sin(Date.now() / 400);
    for (const area of tsunami.areas) {
      const color = tsunamiColor(area.grade);
      this.basemap.fillPrefectures(
        ctx,
        [area.name],
        area.isHome ? withAlpha(color, 0.22 + pulse) : withAlpha(color, 0.18),
        this.transform,
      );
    }
  }

  /**
   * kmoni 由来のレイヤ群。
   * いずれも同じ座標系で配信されるため、無変換で重ねられる。
   * ここでは重ねて表示するだけで、色から値を読み取るような処理は一切しない (§2(2))。
   */
  private drawKmoniLayers(ctx: CanvasRenderingContext2D): void {
    const frame = this.frame;
    if (!frame) return;
    ctx.save();
    ctx.translate(this.transform.offsetX, this.transform.offsetY);
    ctx.scale(this.transform.scale, this.transform.scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (frame.estShindo) {
      ctx.globalAlpha = 0.75;
      this.drawLayer(ctx, frame.estShindo);
      ctx.globalAlpha = 1;
    }

    if (this.options.glow) {
      // 観測点を少しにじませて重ねると、拡大時の粗さが目立たなくなる。
      ctx.save();
      ctx.filter = `blur(${(1.6 / this.transform.scale).toFixed(2)}px)`;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      this.drawLayer(ctx, frame.realtime);
      ctx.restore();
    }
    this.drawLayer(ctx, frame.realtime);

    if (frame.psWave) this.drawLayer(ctx, frame.psWave);
    ctx.restore();
  }

  /**
   * 配信画像を等倍で重ねる。見出し帯を隠す設定のときは、その矩形を避けて
   * 2 回に分けて描く (画像そのものは加工しない)。
   */
  private drawLayer(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap): void {
    const { width, height } = KMONI_MAP;
    if (!this.options.hideCaption) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      return;
    }
    const cap = KMONI_CAPTION_BOX;
    // 見出し帯の下 (全幅)
    ctx.drawImage(bitmap, 0, cap.height, width, height - cap.height, 0, cap.height, width, height - cap.height);
    // 見出し帯の右側 (帯の外に出ている部分)
    const restWidth = width - cap.width;
    if (restWidth > 0) {
      ctx.drawImage(bitmap, cap.width, 0, restWidth, cap.height, cap.width, 0, restWidth, cap.height);
    }
  }

  private drawHomeMarker(ctx: CanvasRenderingContext2D): void {
    const { lat, lon } = this.options.home;
    const p = this.toScreen(lat, lon);
    ctx.save();
    ctx.strokeStyle = '#7fe3ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = '#7fe3ff';
    ctx.fill();
    ctx.restore();
  }

  /**
   * 震央。P/S 波の到達円は kmoni 配信画像 (PSWaveImg) をそのまま重ねており、
   * こちらで半径を計算することはしない (§2(3) 独自の到達予測をしない)。
   */
  private drawEpicenter(ctx: CanvasRenderingContext2D): void {
    const eew = this.eew;
    if (!eew || eew.hypocenter.lat == null || eew.hypocenter.lon == null) return;
    const p = this.toScreen(eew.hypocenter.lat, eew.hypocenter.lon);
    const cancelled = eew.isCancel;
    const color = cancelled ? '#8a93a5' : eew.alert === 'warning' ? '#ff4d5e' : '#ffb454';
    const phase = (Date.now() % 1400) / 1400;

    ctx.save();
    if (!cancelled) {
      // 発表中であることを示す脈動。到達予測を表すものではない。
      ctx.strokeStyle = withAlpha(color, 1 - phase);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 + phase * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x - 9, p.y - 9);
    ctx.lineTo(p.x + 9, p.y + 9);
    ctx.moveTo(p.x + 9, p.y - 9);
    ctx.lineTo(p.x - 9, p.y + 9);
    ctx.stroke();
    ctx.restore();
  }

  private toScreen(lat: number, lon: number): { x: number; y: number } {
    const p = projectToPixel(lat, lon);
    return {
      x: p.x * this.transform.scale + this.transform.offsetX,
      y: p.y * this.transform.scale + this.transform.offsetY,
    };
  }
}

/** 利用地を中心にした表示範囲 (日向灘周辺が入るくらい) */
function homeViewport(home: { lat: number; lon: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const center = projectToPixel(home.lat, home.lon);
  const width = 150;
  const height = 170;
  return {
    x: clamp(center.x - width / 2, 0, KMONI_MAP.width - width),
    y: clamp(center.y - height / 2, 0, KMONI_MAP.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function tsunamiColor(grade: string): string {
  switch (grade) {
    case 'MajorWarning':
      return '#c026a8';
    case 'Warning':
      return '#e8452c';
    case 'Watch':
      return '#e5c53c';
    default:
      return '#6b7a90';
  }
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
