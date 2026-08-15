import { DEFAULT_SIDE_WIDTH, clampSideSize, type SideAxis } from '@quake-panel/shared';

/** 縦並び (地図が上・情報が下) に切り替わる幅。styles.css のメディアクエリと揃えること。 */
const STACK_BREAKPOINT = 1100;

/** 矢印キー 1 回で動かす量 */
const KEY_STEP = 16;

export interface SplitterDeps {
  /** 動かす境目 */
  handle: HTMLElement;
  /** 地図と情報を並べている入れ物 (この矩形を基準に大きさを決める) */
  container: HTMLElement;
  /** いま保存されている大きさ */
  getSize: () => { width: number; height: number };
  /** 動かした結果。0 は「まだ動かしていない」(縦並びの高さのみ) */
  onResize: (patch: { sideWidth?: number; sideHeight?: number }) => void;
}

/**
 * 地図と地震情報パネルの境目。
 *
 * 横並びのときは左右、縦並び (スマホ・縦長のキオスク) のときは上下に動く。
 * 動かした結果は呼び出し側が端末へ保存する。地図の再描画は MapView 側の
 * ResizeObserver が拾うので、ここでは大きさだけを決める。
 */
export class Splitter {
  private dragging = false;

  constructor(private readonly deps: SplitterDeps) {
    const { handle } = deps;
    handle.addEventListener('pointerdown', (ev) => this.start(ev));
    handle.addEventListener('pointermove', (ev) => this.move(ev));
    handle.addEventListener('pointerup', (ev) => this.end(ev));
    handle.addEventListener('pointercancel', (ev) => this.end(ev));
    // 既定に戻す手段が無いと、狭くしすぎたときに詰む
    handle.addEventListener('dblclick', () => this.reset());
    handle.addEventListener('keydown', (ev) => this.key(ev));
  }

  /** 保存されている値を画面へ反映する。起動時と設定変更時に呼ぶ。 */
  apply(): void {
    const { container } = this.deps;
    const { width, height } = this.deps.getSize();
    const rect = container.getBoundingClientRect();
    container.style.setProperty('--side-width', `${clampSideSize(width, rect.width, 'width')}px`);
    if (height > 0) {
      container.style.setProperty('--side-height', `${clampSideSize(height, rect.height, 'height')}px`);
      container.classList.add('main--sized');
    } else {
      container.style.removeProperty('--side-height');
      container.classList.remove('main--sized');
    }
  }

  /** キオスク運用では動かせなくする */
  setLocked(locked: boolean): void {
    this.deps.handle.classList.toggle('split--locked', locked);
  }

  /** いま上下に分かれているか (styles.css のメディアクエリと同じ判定) */
  private get stacked(): boolean {
    return window.innerWidth <= STACK_BREAKPOINT;
  }

  private start(ev: PointerEvent): void {
    this.dragging = true;
    // 指やマウスが境目から外れても追随させる
    this.deps.handle.setPointerCapture(ev.pointerId);
    this.deps.handle.classList.add('split--dragging');
    ev.preventDefault();
  }

  private move(ev: PointerEvent): void {
    if (!this.dragging) return;
    this.resizeTo(ev.clientX, ev.clientY);
    ev.preventDefault();
  }

  private end(ev: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.deps.handle.hasPointerCapture(ev.pointerId)) {
      this.deps.handle.releasePointerCapture(ev.pointerId);
    }
    this.deps.handle.classList.remove('split--dragging');
  }

  /** 掴んでいる位置から、情報パネルの大きさを決める */
  private resizeTo(clientX: number, clientY: number): void {
    const rect = this.deps.container.getBoundingClientRect();
    if (this.stacked) {
      this.emit('height', clampSideSize(rect.bottom - clientY, rect.height, 'height'));
    } else {
      this.emit('width', clampSideSize(rect.right - clientX, rect.width, 'width'));
    }
  }

  private key(ev: KeyboardEvent): void {
    const step = keyStep(ev.key, this.stacked);
    if (step === 0) return;
    const rect = this.deps.container.getBoundingClientRect();
    const current = this.deps.getSize();
    if (this.stacked) {
      // まだ動かしていないときは、いまの見た目 (CSS の 45vh) を起点にする
      const base = current.height > 0 ? current.height : Math.round(rect.height * 0.45);
      this.emit('height', clampSideSize(base + step, rect.height, 'height'));
    } else {
      this.emit('width', clampSideSize(current.width + step, rect.width, 'width'));
    }
    ev.preventDefault();
  }

  private emit(axis: SideAxis, value: number): void {
    this.deps.onResize(axis === 'width' ? { sideWidth: value } : { sideHeight: value });
    this.apply();
  }

  private reset(): void {
    this.deps.onResize(this.stacked ? { sideHeight: 0 } : { sideWidth: DEFAULT_SIDE_WIDTH });
    this.apply();
  }
}

/**
 * 矢印キーで動かす量。
 * 情報パネルは右 (または下) にあるので、左/上へ動かすと大きくなる。
 */
function keyStep(key: string, stacked: boolean): number {
  if (stacked) {
    if (key === 'ArrowUp') return KEY_STEP;
    if (key === 'ArrowDown') return -KEY_STEP;
    return 0;
  }
  if (key === 'ArrowLeft') return KEY_STEP;
  if (key === 'ArrowRight') return -KEY_STEP;
  return 0;
}
