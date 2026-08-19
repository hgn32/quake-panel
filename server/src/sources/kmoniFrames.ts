import {
  fromKmoniTimestamp,
  kmoniDatePart,
  kmoniLayerPath,
  toKmoniTimestamp,
  type FrameNotice,
  type KmoniLayer,
} from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import { fetchBinary, type BinaryResponse } from './httpClient.js';
import type { KmoniClock } from './kmoniClock.js';

const log = createLogger('kmoni-frames');

/** 追加待ちを 1 秒縮めるまでに必要な連続成功回数 (毎秒取得なのでおよそ 30 秒) */
const LAG_DECAY_AFTER_SUCCESSES = 30;
/** 追加待ちの上限。これを超えても取れないなら kmoni 側の問題として劣化モードへ。 */
const MAX_EXTRA_LAG_SEC = 6;

/**
 * 取得・保持する画像の種類。
 *
 * 観測画像は指標ごとに分かれる (jma / acmap / …)。既定の指標は設定で決まり、
 * それ以外は「実際に見ている端末があるときだけ」取りに行く。
 */
export type FrameLayer = KmoniLayer | 'psWave' | 'estShindo';

/** 取得できた画像 (取得できなければ null) */
type BinaryFrame = BinaryResponse;

/** 端末から要求された指標を、何秒間「見られている」とみなすか */
const LAYER_ACTIVE_MS = 60_000;

/**
 * requestImage で受け付けるタイムスタンプの許容範囲 (現在時刻からの差)。
 *
 * - 過去方向: prune() のキャッシュ保持上限 (frameCacheSize*3、既定 90 件) は全レイヤ
 *   合算の件数であり、既定の取得間隔 (1 秒) 換算でもキャッシュに残っているのはせいぜい
 *   数十秒〜数分程度。それより古い時刻は、当ワーカーのキャッシュにまず残っていない
 *   (=どのみち上流へ取りに行くしかない) ので、妥当な上限として 5 分を採る。
 * - 未来方向: 端末側の時計が多少進んでいる分は許容したいが、本来ありえない未来の
 *   画像を無制限に要求されると (上流には存在しないので) 毎回 404 を引くだけになる。
 *   NTP のずれとして現実的な範囲を見て 15 秒とする。
 *
 * これを外れるタイムスタンプは、形式が正しくても上流へは取りに行かず拒否する
 * (毎秒起こりうるクライアントの時計ズレ・スクラブ操作による上流への負荷を抑える)。
 */
const REQUEST_PAST_LIMIT_MS = 5 * 60 * 1000;
const REQUEST_FUTURE_LIMIT_MS = 15 * 1000;

/** 14 桁形式かつ実在する日時で、かつ現在時刻から見て妥当な範囲内か */
export function isRequestableTimestamp(timestamp: string, now: number): boolean {
  const date = fromKmoniTimestamp(timestamp);
  if (!date) return false;
  const diffMs = now - date.getTime();
  return diffMs <= REQUEST_PAST_LIMIT_MS && diffMs >= -REQUEST_FUTURE_LIMIT_MS;
}

export interface CachedImage {
  body: Buffer;
  contentType: string;
  timestamp: string;
  fetchedAt: number;
}

/**
 * 強震モニタ画像の取得と保持。
 *
 * ここが外部への唯一の入口で、クライアント数に関わらず 1 秒あたり 1 回しか
 * NIED を叩かない (§4 通信境界)。取得した画像はメモリ上にだけ置き、
 * クライアントへは自前の HTTP エンドポイント経由で配る。
 */
export class KmoniFrameWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** 404 が続いたときに広げる追加待ち (秒)。端末時計ズレと配信遅延を吸収する。 */
  private extraLagSec = 0;
  private successStreak = 0;
  private lastTimestamp: string | null = null;
  private readonly cache = new Map<string, CachedImage>();
  /** EEW 発表中のみ補助レイヤを取りに行く */
  private eewActive = false;
  /** 既定以外の指標。端末が実際に見ている間だけ取りに行く (層 → 最後に要求された時刻) */
  private readonly requestedLayers = new Map<KmoniLayer, number>();
  /** 同じ画像を同時に何度も取りに行かないための止め輪 */
  private readonly inflight = new Map<string, Promise<CachedImage | null>>();

  constructor(
    private readonly config: Config,
    private readonly hub: Hub,
    private readonly clock: KmoniClock,
  ) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setEewActive(active: boolean): void {
    this.eewActive = active;
  }

  /** サーバーが既定で取りに行く指標 (KMONI_LAYER) */
  get defaultLayer(): KmoniLayer {
    return this.config.kmoni.layer;
  }

  /**
   * 端末が指標つきで画像を要求してきたときの入口。
   *
   * 既定以外の指標は普段取っていないので、初回だけここで取りに行き、
   * 以後しばらくは毎秒の取得対象に加える (見ている端末がいなくなれば戻る)。
   */
  requestImage(layer: KmoniLayer, timestamp: string): Promise<CachedImage | null> {
    if (layer !== this.config.kmoni.layer) this.requestedLayers.set(layer, Date.now());
    const cached = this.getImage(layer, timestamp);
    if (cached) return Promise.resolve(cached);
    if (!isRequestableTimestamp(timestamp, Date.now())) {
      log.debug(`${layer} の要求タイムスタンプ ${timestamp} が範囲外のため上流へ取りに行きません`);
      return Promise.resolve(null);
    }
    return this.fetchLayer(layer, timestamp);
  }

  /** いま毎秒取りに行く指標 (既定 + 見られているもの) */
  private activeLayers(): KmoniLayer[] {
    const now = Date.now();
    const extra = [...this.requestedLayers.entries()]
      .filter(([layer, at]) => {
        if (now - at <= LAYER_ACTIVE_MS) return true;
        this.requestedLayers.delete(layer);
        return false;
      })
      .map(([layer]) => layer);
    return [this.config.kmoni.layer, ...extra.filter((layer) => layer !== this.config.kmoni.layer)];
  }

  /** 同じ画像への同時要求は 1 本にまとめる */
  private fetchLayer(layer: KmoniLayer, timestamp: string): Promise<CachedImage | null> {
    const key = cacheKey(layer, timestamp);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = fetchBinary(this.frameUrl(layer, timestamp), {
      timeoutMs: this.config.kmoni.requestTimeoutMs,
    })
      .then((res) => {
        if (!res) return null;
        this.store(layer, timestamp, res.body, res.contentType);
        return this.getImage(layer, timestamp);
      })
      .catch((error: Error) => {
        log.debug(`${layer} fetch failed: ${describeError(error)}`);
        return null;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  getImage(layer: FrameLayer, timestamp: string): CachedImage | null {
    return this.cache.get(cacheKey(layer, timestamp)) ?? null;
  }

  getLatest(layer: FrameLayer): CachedImage | null {
    if (!this.lastTimestamp) return null;
    return this.getImage(layer, this.lastTimestamp);
  }

  private interval(): number {
    return this.eewActive
      ? this.config.kmoni.activeFrameIntervalMs
      : this.config.kmoni.idleFrameIntervalMs;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private tick(): Promise<void> {
    if (this.running) {
      this.schedule(this.interval());
      return Promise.resolve();
    }
    this.running = true;
    const startedAt = Date.now();
    return this.fetchOnce()
      .catch((error: Error) => {
        this.hub.markFailure('kmoniImage', describeError(error));
        log.warn(`frame fetch failed: ${describeError(error)}`);
      })
      .then(() => {
        this.running = false;
        // 取得に掛かった時間を差し引いて、実効的な取得間隔を一定に保つ。
        const elapsed = Date.now() - startedAt;
        this.schedule(Math.max(100, this.interval() - elapsed));
      });
  }

  private fetchOnce(): Promise<void> {
    const target = new Date(this.clock.latestAvailable().getTime() - this.extraLagSec * 1000);
    const timestamp = toKmoniTimestamp(target);
    if (timestamp === this.lastTimestamp) return Promise.resolve();

    return fetchBinary(this.frameUrl(this.config.kmoni.layer, timestamp), {
      timeoutMs: this.config.kmoni.requestTimeoutMs,
    }).then((realtime) => this.acceptFrame(timestamp, realtime));
  }

  /** 取得できた本体フレームを取り込み、補助レイヤを揃えてから通知する */
  private acceptFrame(timestamp: string, realtime: BinaryFrame | null): Promise<void> {
    if (!realtime) {
      // まだ生成されていない。1 秒ずつ遡って追従する (端末時計のズレもここで吸収される)。
      this.successStreak = 0;
      if (this.extraLagSec < MAX_EXTRA_LAG_SEC) {
        this.extraLagSec += 1;
        log.debug(`frame ${timestamp} not ready, extraLag=${this.extraLagSec}s`);
      } else {
        this.hub.markFailure('kmoniImage', `frame ${timestamp} not found`);
      }
      return Promise.resolve();
    }

    // 余裕を取りすぎた分は少しずつ戻して、表示の遅れを最小に保つ。
    // 成功するたびに縮めると 404 と増減を往復するので、しばらく安定してから 1 秒戻す。
    this.successStreak += 1;
    if (this.extraLagSec > 0 && this.successStreak >= LAG_DECAY_AFTER_SUCCESSES) {
      this.extraLagSec -= 1;
      this.successStreak = 0;
    }

    this.store(this.config.kmoni.layer, timestamp, realtime.body, realtime.contentType);

    // 既定以外の指標を見ている端末がいれば、その分も同じ時刻で揃えておく
    const extras = Promise.all(
      this.activeLayers()
        .filter((layer) => layer !== this.config.kmoni.layer)
        .map((layer) => this.fetchLayer(layer, timestamp)),
    );
    // 補助レイヤ (予測円・予想震度) は EEW 発表中だけ生成される
    const aux = this.eewActive
      ? Promise.all([this.tryFetch('psWave', timestamp), this.tryFetch('estShindo', timestamp)])
      : Promise.resolve([false, false] as [boolean, boolean]);

    return Promise.all([extras, aux]).then(([, [psWave, estShindo]]) =>
      this.publishFrame(timestamp, { realtime: true, psWave, estShindo }),
    );
  }

  /** フレームの取り込みが済んだことをクライアントへ知らせる */
  private publishFrame(timestamp: string, layers: FrameNotice['layers']): void {
    this.lastTimestamp = timestamp;
    this.hub.markSuccess('kmoniImage');
    // prune() は store() に一本化済み (このフレーム取得でも複数回 store() を呼んでいるため)

    const frameTime = fromKmoniTimestamp(timestamp);
    const notice: FrameNotice = {
      timestamp,
      isoTime: frameTime ? frameTime.toISOString() : new Date().toISOString(),
      layers,
      latencyMs: frameTime ? Math.max(0, this.clock.kmoniNow().getTime() - frameTime.getTime()) : 0,
    };
    this.hub.publishFrame(notice);
  }

  private tryFetch(layer: 'psWave' | 'estShindo', timestamp: string): Promise<boolean> {
    const url = layer === 'psWave' ? this.psWaveUrl(timestamp) : this.estShindoUrl(timestamp);
    return fetchBinary(url, { timeoutMs: this.config.kmoni.requestTimeoutMs })
      .then((res) => {
        if (!res) return false;
        this.store(layer, timestamp, res.body, res.contentType);
        return true;
      })
      .catch((error: Error) => {
        // 補助レイヤの欠落は本体表示を止める理由にならないので握りつぶす。
        log.debug(`${layer} fetch failed: ${describeError(error)}`);
        return false;
      });
  }

  /**
   * キャッシュへの書き込みはここに一本化する。publishFrame 経由 (毎秒の本体取得) だけでなく
   * requestImage 経由 (端末からの任意タイムスタンプ要求) で入った画像にも prune() を効かせ、
   * kmoni 障害中でも無制限に積み上がらないようにする。
   */
  private store(layer: FrameLayer, timestamp: string, body: Buffer, contentType: string): void {
    this.cache.set(cacheKey(layer, timestamp), {
      body,
      contentType,
      timestamp,
      fetchedAt: Date.now(),
    });
    this.prune();
  }

  /** メモリを一定に保つ。72 時間ソーク条件 (§6) の要。 */
  private prune(): void {
    const limit = this.config.kmoni.frameCacheSize * 3;
    if (this.cache.size <= limit) return;
    const keys = [...this.cache.keys()];
    keys.slice(0, this.cache.size - limit).forEach((key) => this.cache.delete(key));
  }

  private frameUrl(layer: KmoniLayer, timestamp: string): string {
    const date = kmoniDatePart(timestamp);
    const path = kmoniLayerPath(layer);
    return `${this.config.kmoni.baseUrl}/data/map_img/RealTimeImg/${path}/${date}/${timestamp}.${path}.gif`;
  }

  private psWaveUrl(timestamp: string): string {
    const date = kmoniDatePart(timestamp);
    return `${this.config.kmoni.baseUrl}/data/map_img/PSWaveImg/eew/${date}/${timestamp}.eew.gif`;
  }

  private estShindoUrl(timestamp: string): string {
    const date = kmoniDatePart(timestamp);
    return `${this.config.kmoni.baseUrl}/data/map_img/EstShindoImg/eew/${date}/${timestamp}.eew.gif`;
  }
}

function cacheKey(layer: FrameLayer, timestamp: string): string {
  return `${layer}:${timestamp}`;
}
