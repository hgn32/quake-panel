import { findAreaAtPixel } from '@quake-panel/shared';
import { resolveUrl } from './urls.js';

export interface BasemapPrefecture {
  code: number | null;
  name: string;
  /** [x0,y0,x1,y1,...] 形式。座標は kmoni 配信画像のピクセル系。 */
  rings: number[][];
}

export interface BasemapData {
  attribution: string;
  prefectures: BasemapPrefecture[];
}

export interface BasemapTheme {
  sea: string;
  land: string;
  border: string;
  coast: string;
}

export const DARK_THEME: BasemapTheme = {
  sea: '#080b12',
  land: '#232c3a',
  border: '#3d4a5e',
  coast: '#55688a',
};

/**
 * 自前の背景地図。
 *
 * kmoni の配信画像は透過オーバーレイなので、下にこれを敷くだけで見た目が変わる (§5)。
 * 配信画像そのものには手を加えない。
 */
export class Basemap {
  private data: BasemapData | null = null;
  private cache: HTMLCanvasElement | null = null;
  private cacheKey = '';
  /** 予報区の強調表示用に、名前から都道府県を引けるようにしておく */
  private byName = new Map<string, BasemapPrefecture>();

  async load(url = resolveUrl('/assets/japan-map.json')): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`背景地図を読み込めませんでした: HTTP ${res.status}`);
    this.data = (await res.json()) as BasemapData;
    this.byName = new Map(this.data.prefectures.map((p) => [p.name, p]));
  }

  isLoaded(): boolean {
    return this.data !== null;
  }

  /**
   * 配信画像のピクセル座標にある都道府県名。無ければ null (海上など)。
   *
   * 利用地の都道府県を座標から引くために使う。地名を設定させなくても
   * 「自宅のある県」の観測点を履歴で前に出せる。
   */
  prefectureAtPixel(x: number, y: number): string | null {
    if (!this.data) return null;
    return findAreaAtPixel(this.data.prefectures, x, y);
  }

  get attribution(): string {
    return this.data?.attribution ?? '';
  }

  /**
   * 変換後の背景をオフスクリーンに焼いて使い回す。
   * 毎秒の再描画で 1 万点の多角形を引き直すのは Pi4 には重い。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    transform: { scale: number; offsetX: number; offsetY: number },
    size: { width: number; height: number },
    theme: BasemapTheme = DARK_THEME,
  ): void {
    if (!this.data) return;
    const key = [
      transform.scale.toFixed(3),
      transform.offsetX.toFixed(1),
      transform.offsetY.toFixed(1),
      size.width,
      size.height,
    ].join(':');

    if (this.cacheKey !== key || !this.cache) {
      const canvas = this.cache ?? document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const c = canvas.getContext('2d');
      if (!c) return;
      c.clearRect(0, 0, canvas.width, canvas.height);
      this.paint(c, transform, theme);
      this.cache = canvas;
      this.cacheKey = key;
    }
    ctx.drawImage(this.cache, 0, 0);
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    transform: { scale: number; offsetX: number; offsetY: number },
    theme: BasemapTheme,
  ): void {
    if (!this.data) return;
    ctx.save();
    ctx.translate(transform.offsetX, transform.offsetY);
    ctx.scale(transform.scale, transform.scale);

    ctx.fillStyle = theme.land;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.12, 0.6 / transform.scale);
    ctx.lineJoin = 'round';

    for (const pref of this.data.prefectures) {
      for (const ring of pref.rings) {
        tracePath(ctx, ring);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 海岸線は少し明るくして輪郭を立たせる (県境と区別する)
    ctx.strokeStyle = theme.coast;
    ctx.lineWidth = Math.max(0.15, 0.9 / transform.scale);
    for (const pref of this.data.prefectures) {
      for (const ring of pref.rings) {
        if (ring.length < 40) {
          tracePath(ctx, ring);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** 津波予報区などを塗りつぶすためのパス描画 */
  fillPrefectures(
    ctx: CanvasRenderingContext2D,
    names: readonly string[],
    style: string,
    transform: { scale: number; offsetX: number; offsetY: number },
  ): void {
    if (!this.data || names.length === 0) return;
    ctx.save();
    ctx.translate(transform.offsetX, transform.offsetY);
    ctx.scale(transform.scale, transform.scale);
    ctx.fillStyle = style;
    for (const name of names) {
      const pref = this.matchPrefecture(name);
      if (!pref) continue;
      for (const ring of pref.rings) {
        tracePath(ctx, ring);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * 津波予報区名は必ずしも都道府県名ではない (例: 「有明・八代海」)。
   * 完全一致 → 部分一致の順で探し、見つからなければ塗らない。
   */
  matchPrefecture(name: string): BasemapPrefecture | null {
    const exact = this.byName.get(name);
    if (exact) return exact;
    for (const [key, pref] of this.byName) {
      if (name.includes(key) || key.includes(name)) return pref;
    }
    return null;
  }
}

function tracePath(ctx: CanvasRenderingContext2D, ring: number[]): void {
  ctx.beginPath();
  ctx.moveTo(ring[0] ?? 0, ring[1] ?? 0);
  for (let i = 2; i < ring.length; i += 2) {
    ctx.lineTo(ring[i] ?? 0, ring[i + 1] ?? 0);
  }
  ctx.closePath();
}
