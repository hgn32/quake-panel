import { parseJstDateTime } from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import { fetchJson } from './httpClient.js';

const log = createLogger('kmoni-clock');

interface LatestJson {
  latest_time?: string;
  request_time?: string;
  result?: { status?: string; message?: string };
}

/**
 * kmoni の基準時刻に自分の時計を合わせる。
 *
 * `latest.json` は 2 種類の時刻を返す。
 *   - `request_time`: kmoni 側がリクエストを受けた時刻 → 自分の時計とのズレ (clock offset)
 *   - `latest_time` : 配信済みデータの最新時刻      → データ生成の遅れ (data lag)
 *
 * 端末時計が狂っていても、この 2 つを使えば「いま取りに行くべきタイムスタンプ」を
 * 正しく決められる。受け入れ条件の「端末時計ズレ時の動作」はここが担保する。
 */
export class KmoniClock {
  private clockOffsetMs = 0;
  private dataLagMs = 2000;
  private timer: NodeJS.Timeout | null = null;
  private synced = false;

  constructor(
    private readonly config: Config,
    private readonly hub: Hub,
  ) {}

  start(): Promise<void> {
    return this.sync().then(() => {
      this.timer = setInterval(() => {
        void this.sync();
      }, this.config.kmoni.clockSyncIntervalMs);
      this.timer.unref?.();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** kmoni 側の現在時刻 (自分の時計を補正したもの) */
  kmoniNow(): Date {
    return new Date(Date.now() - this.clockOffsetMs);
  }

  /** 取得できる見込みのある最新フレーム時刻 */
  latestAvailable(): Date {
    return new Date(this.kmoniNow().getTime() - this.dataLagMs);
  }

  isSynced(): boolean {
    return this.synced;
  }

  private sync(): Promise<void> {
    const url = `${this.config.kmoni.baseUrl}/webservice/server/pros/latest.json`;
    const sentAt = Date.now();
    return fetchJson<LatestJson>(url, {
      timeoutMs: this.config.kmoni.requestTimeoutMs,
      noStore: true,
    }).then((json) => {
      const receivedAt = Date.now();
      const requestTime = parseJstDateTime(json.request_time);
      const latestTime = parseJstDateTime(json.latest_time);
      if (!requestTime || !latestTime) {
        throw new Error(`unexpected latest.json payload: ${JSON.stringify(json).slice(0, 200)}`);
      }
      // 往復の半分だけ kmoni 側の時刻は進んでいるとみなす。
      // request_time の分解能は 1 秒なので、この補正の誤差も 1 秒程度。
      const rtt = receivedAt - sentAt;
      const kmoniAtReceive = requestTime.getTime() + rtt / 2;
      this.clockOffsetMs = Math.round(receivedAt - kmoniAtReceive);
      this.dataLagMs = Math.max(1000, requestTime.getTime() - latestTime.getTime());
      this.synced = true;
      this.hub.setClockOffset(this.clockOffsetMs);
      log.debug(`synced offset=${this.clockOffsetMs}ms lag=${this.dataLagMs}ms rtt=${rtt}ms`);
    }).catch((error: Error) => {
      // 時刻合わせに失敗しても取得は続ける (前回の補正値のまま進む)
      log.warn(`sync failed: ${describeError(error)}`);
    });
  }
}
