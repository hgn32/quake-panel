import { ENDPOINTS, type FrameNotice } from '@quake-panel/shared';
import { resolveUrl } from './urls.js';

export interface FrameImages {
  notice: FrameNotice;
  /** リアルタイム震度。これが取れなかったフレームは公開しないので必ず存在する。 */
  realtime: ImageBitmap;
  psWave: ImageBitmap | null;
  estShindo: ImageBitmap | null;
}

/**
 * 新フレーム通知を受けて画像を取りに行く層。
 *
 * WS でバイナリを流さず HTTP で取りに行くのは、キャッシュ制御とデバッグが
 * 単純になるため (§4)。取得は毎秒発生するので、以下を守らないと
 * 24 時間稼働でじわじわ壊れる。
 *   - 取得が間に合わないときは古い要求を捨てる (積まない)
 *   - ImageBitmap は差し替え時に必ず close() する
 */
export class FrameStream {
  private current: FrameImages | null = null;
  private inflight: AbortController | null = null;
  private pending: FrameNotice | null = null;
  private loading = false;

  constructor(private readonly onFrame: (frame: FrameImages) => void) {}

  /** WS から新フレーム通知を受け取る */
  accept(notice: FrameNotice): void {
    this.pending = notice;
    if (!this.loading) void this.pump();
  }

  getCurrent(): FrameImages | null {
    return this.current;
  }

  dispose(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.pending = null;
    this.release(this.current);
    this.current = null;
  }

  private async pump(): Promise<void> {
    this.loading = true;
    try {
      while (this.pending) {
        const notice = this.pending;
        this.pending = null;
        await this.load(notice);
      }
    } finally {
      this.loading = false;
    }
  }

  private async load(notice: FrameNotice): Promise<void> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;

    try {
      const [realtime, psWave, estShindo] = await Promise.all([
        loadBitmap(resolveUrl(ENDPOINTS.frame(notice.timestamp)), controller.signal),
        notice.layers.psWave
          ? loadBitmap(resolveUrl(ENDPOINTS.psWave(notice.timestamp)), controller.signal)
          : Promise.resolve(null),
        notice.layers.estShindo
          ? loadBitmap(resolveUrl(ENDPOINTS.estShindo(notice.timestamp)), controller.signal)
          : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) {
        closeAll(realtime, psWave, estShindo);
        return;
      }
      if (!realtime) return;

      const next: FrameImages = { notice, realtime, psWave, estShindo };
      this.release(this.current);
      this.current = next;
      this.onFrame(next);
    } catch {
      // 1 フレームの取りこぼしは次の通知で回復するので、ここでは何もしない
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  private release(frame: FrameImages | null): void {
    if (!frame) return;
    closeAll(frame.realtime, frame.psWave, frame.estShindo);
  }
}

function closeAll(...bitmaps: Array<ImageBitmap | null>): void {
  for (const bitmap of bitmaps) bitmap?.close();
}

async function loadBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (signal.aborted) return null;
  return createImageBitmap(blob);
}
