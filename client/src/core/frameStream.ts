import { DEFAULT_KMONI_LAYER, ENDPOINTS, type KmoniLayer, type FrameNotice } from '@quake-panel/shared';
import { resolveUrl } from './urls.js';

export interface FrameImages {
  notice: FrameNotice;
  /** リアルタイム震度。これが取れなかったフレームは公開しないので必ず存在する。 */
  realtime: ImageBitmap;
  psWave: ImageBitmap | null;
  estShindo: ImageBitmap | null;
}

/**
 * 1 フレーム取得のタイムアウト (ms)。
 *
 * サーバーはフレームを毎秒配る (idleFrameIntervalMs / activeFrameIntervalMs の
 * 既定 1000ms、server/src/config.ts) が、キャッシュに無いタイムスタンプは
 * サーバーが上流 (kmoni) まで取りに行くため、サーバー既定の上流タイムアウト
 * (KMONI_REQUEST_TIMEOUT_MS 既定 4000ms) までは正常に時間がかかりうる。
 * それより短いタイムアウトだと成功するはずの取得までハング扱いで捨てて
 * しまうため、余裕を見て 6 秒とする。これを超えたら abort し、`loading` を
 * 解放して次のフレーム要求で復帰できるようにする (下記クラスコメント参照)。
 */
const FETCH_TIMEOUT_MS = 6000;

/**
 * 新フレーム通知を受けて画像を取りに行く層。
 *
 * WS でバイナリを流さず HTTP で取りに行くのは、キャッシュ制御とデバッグが
 * 単純になるため (§4)。取得は毎秒発生するので、以下を守らないと
 * 24 時間稼働でじわじわ壊れる。
 *   - 取得が間に合わないときは古い要求を捨てる (積まない)
 *   - ImageBitmap は差し替え時に必ず close() する
 *   - 取得がハングしても FETCH_TIMEOUT_MS で必ず解放する (loading を握ったままにしない)
 */
export class FrameStream {
  private current: FrameImages | null = null;
  private inflight: AbortController | null = null;
  private pending: FrameNotice | null = null;
  private loading = false;
  /** 表示する指標。設定で切り替わる (サーバーは要求された指標だけ取りに行く)。 */
  private layer: KmoniLayer = DEFAULT_KMONI_LAYER;

  constructor(private readonly onFrame: (frame: FrameImages) => void) {}

  /** 指標を切り替える。次の通知から新しい指標で取りに行く。 */
  setLayer(layer: KmoniLayer): void {
    this.layer = layer;
  }

  getLayer(): KmoniLayer {
    return this.layer;
  }

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

  /**
   * 溜まっている通知を 1 つずつ処理する。
   *
   * 毎秒来るので、前の取得が終わる前に次が来る。最後の 1 件だけを追いかける
   * ため、処理中は `pending` に上書きしておき、終わってから次へ進む。
   */
  private pump(): Promise<void> {
    this.loading = true;
    const notice = this.pending;
    this.pending = null;
    if (!notice) {
      this.loading = false;
      return Promise.resolve();
    }
    return this.load(notice).then(() => this.pump());
  }

  private load(notice: FrameNotice): Promise<void> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    // ハングして戻ってこない取得の保険。詳細は FETCH_TIMEOUT_MS のコメント。
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    return Promise.allSettled([
      loadBitmap(resolveUrl(ENDPOINTS.frame(this.layer, notice.timestamp)), controller.signal),
      notice.layers.psWave
        ? loadBitmap(resolveUrl(ENDPOINTS.psWave(notice.timestamp)), controller.signal)
        : Promise.resolve(null),
      notice.layers.estShindo
        ? loadBitmap(resolveUrl(ENDPOINTS.estShindo(notice.timestamp)), controller.signal)
        : Promise.resolve(null),
    ])
      .then(([realtimeResult, psWaveResult, estShindoResult]) => {
        // allSettled なので個々の失敗 (中断・HTTP エラー等) で全体が reject
        // することはない。失敗した分は settledBitmap が null を返す。
        const realtime = settledBitmap(realtimeResult);
        const psWave = settledBitmap(psWaveResult);
        const estShindo = settledBitmap(estShindoResult);

        if (controller.signal.aborted || !realtime) {
          // 採用しない (中断された・realtime が取れなかった) 場合は、
          // 生成済みの ImageBitmap を取りこぼさず必ず閉じる (リーク防止)。
          // 1 フレームの取りこぼし自体は次の通知で回復するので、ここでは
          // それ以上のことはしない。
          closeAll(realtime, psWave, estShindo);
          return;
        }

        const next: FrameImages = { notice, realtime, psWave, estShindo };
        this.release(this.current);
        this.current = next;
        this.onFrame(next);
      })
      .then(() => {
        window.clearTimeout(timeout);
        if (this.inflight === controller) this.inflight = null;
      });
  }

  private release(frame: FrameImages | null): void {
    if (!frame) return;
    closeAll(frame.realtime, frame.psWave, frame.estShindo);
  }
}

function closeAll(...bitmaps: Array<ImageBitmap | null>): void {
  bitmaps.forEach((bitmap) => bitmap?.close());
}

/** Promise.allSettled の結果から、取得できていれば bitmap を、失敗していれば null を返す */
function settledBitmap(result: PromiseSettledResult<ImageBitmap | null>): ImageBitmap | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function loadBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  return fetch(url, { signal, cache: 'force-cache' })
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => {
      if (!blob || signal.aborted) return null;
      return createImageBitmap(blob);
    });
}
