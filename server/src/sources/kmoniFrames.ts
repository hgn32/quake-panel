import {
  fromKmoniTimestamp,
  kmoniDatePart,
  toKmoniTimestamp,
  type FrameNotice,
} from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import { fetchBinary } from './httpClient.js';
import type { KmoniClock } from './kmoniClock.js';

const log = createLogger('kmoni-frames');

/** 追加待ちを 1 秒縮めるまでに必要な連続成功回数 (毎秒取得なのでおよそ 30 秒) */
const LAG_DECAY_AFTER_SUCCESSES = 30;
/** 追加待ちの上限。これを超えても取れないなら kmoni 側の問題として劣化モードへ。 */
const MAX_EXTRA_LAG_SEC = 6;

export type FrameLayer = 'realtime' | 'psWave' | 'estShindo';

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

  private async tick(): Promise<void> {
    if (this.running) {
      this.schedule(this.interval());
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.fetchOnce();
    } catch (error) {
      this.hub.markFailure('kmoniImage', describeError(error));
      log.warn(`frame fetch failed: ${describeError(error)}`);
    } finally {
      this.running = false;
      // 取得に掛かった時間を差し引いて、実効的な取得間隔を一定に保つ。
      const elapsed = Date.now() - startedAt;
      this.schedule(Math.max(100, this.interval() - elapsed));
    }
  }

  private async fetchOnce(): Promise<void> {
    const target = new Date(this.clock.latestAvailable().getTime() - this.extraLagSec * 1000);
    const timestamp = toKmoniTimestamp(target);
    if (timestamp === this.lastTimestamp) return;

    const realtime = await fetchBinary(this.realtimeUrl(timestamp), {
      timeoutMs: this.config.kmoni.requestTimeoutMs,
    });

    if (!realtime) {
      // まだ生成されていない。1 秒ずつ遡って追従する (端末時計のズレもここで吸収される)。
      this.successStreak = 0;
      if (this.extraLagSec < MAX_EXTRA_LAG_SEC) {
        this.extraLagSec += 1;
        log.debug(`frame ${timestamp} not ready, extraLag=${this.extraLagSec}s`);
      } else {
        this.hub.markFailure('kmoniImage', `frame ${timestamp} not found`);
      }
      return;
    }

    // 余裕を取りすぎた分は少しずつ戻して、表示の遅れを最小に保つ。
    // 成功するたびに縮めると 404 と増減を往復するので、しばらく安定してから 1 秒戻す。
    this.successStreak += 1;
    if (this.extraLagSec > 0 && this.successStreak >= LAG_DECAY_AFTER_SUCCESSES) {
      this.extraLagSec -= 1;
      this.successStreak = 0;
    }

    this.store('realtime', timestamp, realtime.body, realtime.contentType);

    const layers = { realtime: true, psWave: false, estShindo: false };
    if (this.eewActive) {
      const [ps, est] = await Promise.all([
        this.tryFetch('psWave', timestamp),
        this.tryFetch('estShindo', timestamp),
      ]);
      layers.psWave = ps;
      layers.estShindo = est;
    }

    this.lastTimestamp = timestamp;
    this.hub.markSuccess('kmoniImage');
    this.prune();

    const frameTime = fromKmoniTimestamp(timestamp);
    const notice: FrameNotice = {
      timestamp,
      isoTime: frameTime ? frameTime.toISOString() : new Date().toISOString(),
      layers,
      latencyMs: frameTime ? Math.max(0, this.clock.kmoniNow().getTime() - frameTime.getTime()) : 0,
    };
    this.hub.publishFrame(notice);
  }

  private async tryFetch(layer: 'psWave' | 'estShindo', timestamp: string): Promise<boolean> {
    try {
      const url = layer === 'psWave' ? this.psWaveUrl(timestamp) : this.estShindoUrl(timestamp);
      const res = await fetchBinary(url, { timeoutMs: this.config.kmoni.requestTimeoutMs });
      if (!res) return false;
      this.store(layer, timestamp, res.body, res.contentType);
      return true;
    } catch (error) {
      // 補助レイヤの欠落は本体表示を止める理由にならないので握りつぶす。
      log.debug(`${layer} fetch failed: ${describeError(error)}`);
      return false;
    }
  }

  private store(layer: FrameLayer, timestamp: string, body: Buffer, contentType: string): void {
    this.cache.set(cacheKey(layer, timestamp), {
      body,
      contentType,
      timestamp,
      fetchedAt: Date.now(),
    });
  }

  /** メモリを一定に保つ。72 時間ソーク条件 (§6) の要。 */
  private prune(): void {
    const limit = this.config.kmoni.frameCacheSize * 3;
    if (this.cache.size <= limit) return;
    const keys = [...this.cache.keys()];
    for (const key of keys.slice(0, this.cache.size - limit)) this.cache.delete(key);
  }

  private realtimeUrl(timestamp: string): string {
    const date = kmoniDatePart(timestamp);
    return `${this.config.kmoni.baseUrl}/data/map_img/RealTimeImg/jma_s/${date}/${timestamp}.jma_s.gif`;
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
