import {
  KMONI_CAPTION_BOX,
  KMONI_MAP,
  projectToPixel,
  unprojectFromPixel,
  type EewState,
  type TsunamiInfo,
} from '@quake-panel/shared';
import { Basemap, DARK_THEME } from './basemap.js';
import type { FrameImages } from './frameStream.js';

/**
 * 地図の表示位置。中心は配信画像のピクセル座標で持つ。
 * 画面の大きさに依らないので、そのまま保存・復元できる。
 */
export interface MapViewState {
  centerX: number;
  centerY: number;
  /** 画像全体が画面に収まる倍率を 1 とした拡大率 */
  zoom: number;
}

/** 暗い観測点をどれだけ明るく寄せるか (0 で無調整) */
const LIFT = 0.3;

/**
 * 観測点の色の明るさ調整。凡例も同じ見え方にするために公開している。
 * 暗い色ほど白へ寄せるだけで、色相は変えない。
 */
export function liftPointColor(r: number, g: number, b: number): [number, number, number] {
  const lift = LIFT * (1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255);
  return [r + (255 - r) * lift, g + (255 - g) * lift, b + (255 - b) * lift];
}

/** 拡大率の範囲。1 未満は余白が増えるだけなので許さない。 */
export const ZOOM_RANGE = { min: 1, max: 8 } as const;

export interface MapViewOptions {
  /** 観測点の発光表現。Pi4 で重い場合に切れるようにしておく。 */
  glow: boolean;
  /** 表示位置。ホイールとドラッグで動く */
  view: MapViewState;
  /** false ならホイールもドラッグも受け付けない (キオスク運用) */
  interactive: boolean;
  home: { lat: number; lon: number };
}

/** 日本全体を写す表示 */
export function fullMapView(): MapViewState {
  return { centerX: KMONI_MAP.width / 2, centerY: KMONI_MAP.height / 2, zoom: 1 };
}

/** 利用地の周辺を写す表示 */
export function homeMapView(home: { lat: number; lon: number }): MapViewState {
  const p = projectToPixel(home.lat, home.lon);
  return { centerX: p.x, centerY: p.y, zoom: 2.4 };
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
  private drag: { pointerId: number; x: number; y: number; moved: number } | null = null;
  /** いま画面に触れている指。2 本になったらピンチ操作に切り替える。 */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance: number | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private points: Map<string, number[]> | null = null;
  private pointsFor: ImageBitmap | null = null;
  private pick: ((location: { lat: number; lon: number }) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private options: MapViewOptions,
    /** ホイール・ドラッグで表示位置が動いたときに呼ばれる (保存はアプリ側) */
    private readonly onViewChange?: (view: MapViewState) => void,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
    this.attachInteraction();
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

  /**
   * 座標にある都道府県名。背景地図が読めていなければ null。
   * 利用地の県を地名の設定なしに知るために使う。
   */
  prefectureAt(lat: number, lon: number): string | null {
    const p = projectToPixel(lat, lon);
    return this.basemap.prefectureAtPixel(p.x, p.y);
  }


  /**
   * ホイールで拡大縮小、ドラッグでスクロール。
   *
   * キオスクでは触られたくないので `interactive` で止められる。止めている間も
   * イベントは購読したままにして、設定を切り替えた瞬間から効くようにする。
   */
  private attachInteraction(): void {
    // ページ全体のスクロールに持っていかれないよう passive を外す
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
  }

  private detachInteraction(): void {
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
  }

  /**
   * 利用地を地図から選ぶモードに入る。
   *
   * クリックのたびに候補の座標を返すだけで、モードは抜けない (決めるのは呼び出し側)。
   * 押した位置がその場で確定してしまうと「選び直せるのか」が分からないため。
   * ドラッグでのスクロールとホイールでの拡大縮小は効いたまま。
   */
  startPick(onPick: (location: { lat: number; lon: number }) => void): void {
    this.pick = onPick;
    this.canvas.style.cursor = 'crosshair';
  }

  cancelPick(): void {
    this.pick = null;
    this.canvas.style.cursor = '';
  }

  get isPicking(): boolean {
    return this.pick !== null;
  }

  private readonly handleWheel = (ev: WheelEvent): void => {
    if (!this.options.interactive) return;
    ev.preventDefault();
    // 1 ノッチで約 1.1 倍。トラックパッドの細かい値でも同じ感覚になるよう指数で扱う。
    const factor = Math.exp(-ev.deltaY * 0.0015);
    this.zoomAt(ev.clientX, ev.clientY, factor);
  };

  private readonly handlePointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size >= 2) {
      // 2 本目が触れたらピンチ。1 本指のスクロールは止める。
      this.drag = null;
      this.pinchDistance = this.currentPinchDistance();
      return;
    }
    this.drag = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0 };
    this.canvas.setPointerCapture(ev.pointerId);
  };

  /** 2 本の指の間隔。2 本触れていなければ null。 */
  private currentPinchDistance(): number | null {
    const points = [...this.pointers.values()];
    const first = points[0];
    const second = points[1];
    if (!first || !second) return null;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  /** 2 本の指の中点。2 本触れていなければ null。 */
  private currentPinchCenter(): { x: number; y: number } | null {
    const points = [...this.pointers.values()];
    const first = points[0];
    const second = points[1];
    if (!first || !second) return null;
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  /**
   * ピンチでの拡大縮小。指の中点を動かさずに倍率だけ変える。
   * スマホではホイールが無いので、これが唯一の拡大手段になる。
   */
  private handlePinch(): void {
    const previous = this.pinchDistance;
    const distance = this.currentPinchDistance();
    const center = this.currentPinchCenter();
    if (previous === null || distance === null || center === null) return;
    if (previous <= 0 || distance <= 0) return;
    this.pinchDistance = distance;
    if (!this.options.interactive) return;
    this.zoomAt(center.x, center.y, distance / previous);
  }

  private readonly handlePointerMove = (ev: PointerEvent): void => {
    if (this.pointers.has(ev.pointerId)) {
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (this.pointers.size >= 2) {
      this.handlePinch();
      return;
    }
    const drag = this.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (!this.options.interactive) return;
    this.panBy(dx, dy);
  };

  private readonly handlePointerUp = (ev: PointerEvent): void => {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = null;
    const drag = this.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(ev.pointerId)) {
      this.canvas.releasePointerCapture(ev.pointerId);
    }
    // 動かさずに離したときだけ「クリック」とみなす (スクロールと区別する)
    if (drag.moved > 4 || !this.pick) return;
    this.pick(this.locationAt(ev.clientX, ev.clientY));
  };

  /** ドラッグ中に出る選択メニューを抑える */
  private readonly handleContextMenu = (ev: MouseEvent): void => {
    if (this.options.interactive) ev.preventDefault();
  };

  /** 画面上の一点を動かさずに拡大縮小する */
  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const before = this.toMapPixel(x, y);
    const zoom = clampValue(
      this.options.view.zoom * factor,
      ZOOM_RANGE.min,
      ZOOM_RANGE.max,
    );
    if (zoom === this.options.view.zoom) return;
    const scale = this.fitScale(this.cssSize.width, this.cssSize.height) * zoom;
    // カーソル下の点が動かないように中心を決め直す
    this.commitView({
      centerX: before.x + (this.cssSize.width / 2 - x) / scale,
      centerY: before.y + (this.cssSize.height / 2 - y) / scale,
      zoom,
    });
  }

  private panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.commitView({
      ...this.options.view,
      centerX: this.options.view.centerX - dx / this.transform.scale,
      centerY: this.options.view.centerY - dy / this.transform.scale,
    });
  }

  /** 画面座標 → 配信画像のピクセル座標 */
  private toMapPixel(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.transform.offsetX) / this.transform.scale,
      y: (y - this.transform.offsetY) / this.transform.scale,
    };
  }

  /**
   * 画面座標 → 緯度経度。
   *
   * 南西諸島は画像左上の別枠 (インセット) に描かれていて、ピクセルだけでは
   * どちらの変換か決まらない。その位置に沖縄県の多角形があるかどうかで判断する。
   */
  private locationAt(clientX: number, clientY: number): { lat: number; lon: number } {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.toMapPixel(clientX - rect.left, clientY - rect.top);
    const inset = this.basemap.prefectureAtPixel(p.x, p.y) === '沖縄県';
    return unprojectFromPixel(p.x, p.y, { inset });
  }

  /** 中心は画像の中に収める。行き過ぎて真っ黒になるのを防ぐ。 */
  private commitView(view: MapViewState): void {
    const next: MapViewState = {
      centerX: clampValue(view.centerX, 0, KMONI_MAP.width),
      centerY: clampValue(view.centerY, 0, KMONI_MAP.height),
      zoom: clampValue(view.zoom, ZOOM_RANGE.min, ZOOM_RANGE.max),
    };
    const current = this.options.view;
    if (
      next.centerX === current.centerX &&
      next.centerY === current.centerY &&
      next.zoom === current.zoom
    ) {
      return;
    }
    this.options = { ...this.options, view: next };
    this.transform = this.computeTransform(this.cssSize.width, this.cssSize.height);
    this.requestRender();
    this.onViewChange?.(next);
  }

  dispose(): void {
    this.detachInteraction();
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

  /**
   * 表示位置から描画変換を作る。
   * 拡大率 1 は「画像全体が画面に収まる」状態で、画面の大きさが変わっても
   * 保存してある中心と拡大率がそのまま使える。
   */
  private computeTransform(width: number, height: number): Transform {
    const scale = this.fitScale(width, height) * this.options.view.zoom;
    return {
      scale,
      offsetX: width / 2 - this.options.view.centerX * scale,
      offsetY: height / 2 - this.options.view.centerY * scale,
    };
  }

  private fitScale(width: number, height: number): number {
    return Math.min(width / KMONI_MAP.width, height / KMONI_MAP.height);
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

  /** 津波予報区の強調。利用地の予報区は特に目立たせる (§3)。 */
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

    // 予想震度と予測円は面で描かれているので、画像のまま地図に重ねる
    ctx.save();
    ctx.translate(this.transform.offsetX, this.transform.offsetY);
    ctx.scale(this.transform.scale, this.transform.scale);
    ctx.imageSmoothingEnabled = false;
    if (frame.estShindo) {
      ctx.globalAlpha = 0.75;
      this.drawLayer(ctx, frame.estShindo);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 観測点は倍率によらず一定の大きさで描く (画像ごと拡大しない)
    this.drawPoints(ctx, frame.realtime);

    if (frame.psWave) {
      ctx.save();
      ctx.translate(this.transform.offsetX, this.transform.offsetY);
      ctx.scale(this.transform.scale, this.transform.scale);
      ctx.imageSmoothingEnabled = false;
      this.drawLayer(ctx, frame.psWave);
      ctx.restore();
    }
  }



  /**
   * 観測点の位置と色を拾う。
   *
   * 配信画像では観測点が 3x3 px の四角で描かれている。画像のまま拡大すると
   * 四角も一緒に大きくなり、拡大するほど地図が四角で埋まってしまう
   * (本家の強震モニタは倍率によらず一定の大きさで描いている)。
   * そこで観測点の位置だけを拾い、画面上の大きさは描画側で決める。
   *
   * 密集地では隣り合う四角がくっついて 1 つの大きな塊になる (実測で最大
   * 1264 px = 100 点以上が地続き)。塊の内側を無条件に拾うと、ありもしない
   * 観測点が線状に並んでしまうため、塊ごとに 3px 間隔の格子で拾い直す。
   * 3px は四角の一辺で、隣り合う観測点の最小間隔でもある。
   *
   * 毎秒動く処理なので、全画素を見る走査は 1 回だけにしてある。
   */
  private extractPoints(bitmap: ImageBitmap): Map<string, number[]> {
    if (this.pointsFor === bitmap && this.points) return this.points;
    const { width, height } = KMONI_MAP;
    const canvas = this.scratch ?? document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.scratch = canvas;
    const points = new Map<string, number[]>();
    if (!ctx) return points;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    const src = ctx.getImageData(0, 0, width, height).data;

    // 色の付いている画素を集める (全画素を見るのはここだけ)
    const filled = new Uint8Array(width * height);
    const cap = KMONI_CAPTION_BOX;
    const opaque: number[] = [];
    for (let y = 1; y < height - 1; y += 1) {
      const row = y * width;
      const inCaptionRow = y < cap.height;
      for (let x = 1; x < width - 1; x += 1) {
        if (src[(row + x) * 4 + 3] === 0) continue;
        // 左上の見出し帯 (英字と時刻) は観測点ではない
        if (inCaptionRow && x < cap.width) continue;
        filled[row + x] = 1;
        opaque.push(row + x);
      }
    }

    const visited = new Uint8Array(width * height);
    const stack: number[] = [];
    const cells: number[] = [];
    const add = (index: number): void => {
      const color = this.pointColor(src, index);
      const list = points.get(color) ?? [];
      list.push((index % width) + 0.5, Math.floor(index / width) + 0.5);
      points.set(color, list);
    };

    for (const seed of opaque) {
      if (visited[seed] === 1) continue;
      // ひとつながりの塊を集める
      cells.length = 0;
      stack.length = 0;
      stack.push(seed);
      visited[seed] = 1;
      let minX = width;
      let minY = height;
      while (stack.length > 0) {
        const index = stack.pop() as number;
        cells.push(index);
        const x = index % width;
        const y = (index - x) / width;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        // 上下は端の判定だけ、左右は行をまたがないことも見る
        if (x + 1 < width && filled[index + 1] === 1 && visited[index + 1] === 0) {
          visited[index + 1] = 1;
          stack.push(index + 1);
        }
        if (x > 0 && filled[index - 1] === 1 && visited[index - 1] === 0) {
          visited[index - 1] = 1;
          stack.push(index - 1);
        }
        const down = index + width;
        if (down < filled.length && filled[down] === 1 && visited[down] === 0) {
          visited[down] = 1;
          stack.push(down);
        }
        const up = index - width;
        if (up >= 0 && filled[up] === 1 && visited[up] === 0) {
          visited[up] = 1;
          stack.push(up);
        }
      }

      // 塊の左上を基準に 3px 間隔で拾う (1 つの四角からは 1 点だけ出る)
      let found = 0;
      for (const index of cells) {
        const x = index % width;
        const y = (index - x) / width;
        if ((x - minX) % 3 !== 1 || (y - minY) % 3 !== 1) continue;
        add(index);
        found += 1;
      }
      if (found === 0) {
        // 2x2 以下の小さな四角は格子に乗らない。中心を 1 点だけ置く。
        add(cells[Math.floor(cells.length / 2)] as number);
      }
    }
    this.points = points;
    this.pointsFor = bitmap;
    return points;
  }

  /**
   * 観測点の色。
   * 平常時の色 (濃い青) は黒い背景の上だと重く沈むので、暗い色ほど白へ寄せて
   * 明るくする。色相は変えない (強い揺れの黄〜赤はほぼそのまま)。
   */
  private pointColor(src: Uint8ClampedArray, index: number): string {
    const i = index * 4;
    const [r, g, b] = liftPointColor(src[i] ?? 0, src[i + 1] ?? 0, src[i + 2] ?? 0);
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }

  /**
   * 観測点を画面上の一定の大きさで描く。
   *
   * 倍率を上げても四角は大きくならない (上限を付けてある)。
   * 画面座標で整数に丸めて描くので、拡大しても輪郭がぼやけない。
   */
  private drawPoints(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap): void {
    const { scale, offsetX, offsetY } = this.transform;
    const size = Math.max(3, Math.min(Math.round(3 * scale), 8));
    const half = size / 2;
    const points = this.extractPoints(bitmap);
    const { width, height } = this.cssSize;

    ctx.save();
    for (const [color, coords] of points) {
      ctx.fillStyle = color;
      for (let i = 0; i < coords.length; i += 2) {
        const sx = Math.round((coords[i] ?? 0) * scale + offsetX - half);
        const sy = Math.round((coords[i + 1] ?? 0) * scale + offsetY - half);
        // 画面の外は描かない (拡大時はほとんどが外になる)
        if (sx + size < 0 || sy + size < 0 || sx > width || sy > height) continue;
        ctx.fillRect(sx, sy, size, size);
      }
    }
    if (this.options.glow) {
      // 少し大きい四角を薄く重ねて発光させる。にじませるより軽い。
      // 日本全体を写しているときは観測点が密で、強くすると重なって白く潰れる。
      // 拡大して疎になるほど強くする。
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.3, 0.02 * scale);
      const glowSize = size + 4;
      const glowHalf = glowSize / 2;
      for (const [color, coords] of points) {
        ctx.fillStyle = color;
        for (let i = 0; i < coords.length; i += 2) {
          const sx = Math.round((coords[i] ?? 0) * scale + offsetX - glowHalf);
          const sy = Math.round((coords[i + 1] ?? 0) * scale + offsetY - glowHalf);
          if (sx + glowSize < 0 || sy + glowSize < 0 || sx > width || sy > height) continue;
          ctx.fillRect(sx, sy, glowSize, glowSize);
        }
      }
    }
    ctx.restore();
  }

  /**
   * 配信画像を等倍で重ねる。左上の見出し帯 (英字と時刻) は画面を占領するだけで
   * 観測点も含まれないため、その矩形を避けて 2 回に分けて描く
   * (画像そのものは加工しない)。
   */
  private drawLayer(ctx: CanvasRenderingContext2D, bitmap: CanvasImageSource): void {
    const { width, height } = KMONI_MAP;
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
function clampValue(value: number, min: number, max: number): number {
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
