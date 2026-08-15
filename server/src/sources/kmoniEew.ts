import {
  fromKmoniTimestamp,
  parseIntensityText,
  parseJstDateTime,
  toKmoniTimestamp,
  type EewAlertKind,
  type Hypocenter,
  type IntensityLevel,
} from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import { fetchJson } from './httpClient.js';
import type { KmoniClock } from './kmoniClock.js';

const log = createLogger('kmoni-eew');

/** kmoni EEW JSON の生の形。値はすべて文字列で来る (真偽値も "true"/"" 混在)。 */
export interface KmoniEewRaw {
  result?: { status?: string; message?: string; is_auth?: boolean };
  report_time?: string;
  report_num?: string;
  report_id?: string;
  region_code?: string;
  region_name?: string;
  longitude?: string;
  latitude?: string;
  depth?: string;
  magunitude?: string; // kmoni 側の綴りのまま (typo ではなく実際のキー名)
  calcintensity?: string;
  origin_time?: string;
  is_cancel?: string | boolean;
  is_final?: string | boolean;
  is_training?: string | boolean;
  alertflg?: string;
  request_time?: string;
  request_hypo_type?: string;
}

/** kmoni EEW JSON から取り出した 1 報分 */
export interface KmoniEewReport {
  id: string;
  reportNumber: number;
  alert: EewAlertKind;
  isCancel: boolean;
  isFinal: boolean;
  isTraining: boolean;
  hypocenter: Hypocenter;
  maxIntensity: IntensityLevel | null;
  originTime: Date | null;
  announcedAt: Date | null;
}

const truthy = (value: string | boolean | undefined): boolean =>
  value === true || (typeof value === 'string' && /^(true|1)$/i.test(value.trim()));

const numberOrNull = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  // "10km" / "M5.5" のような単位付きでも数値だけ拾う
  const m = /-?\d+(?:\.\d+)?/.exec(value);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

/** report_time は "YYYY/MM/DD hh:mm:ss"、origin_time は "YYYYMMDDhhmmss" が観測されている。 */
const parseEitherTime = (value: string | undefined): Date | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{14}$/.test(trimmed)) return fromKmoniTimestamp(trimmed);
  return parseJstDateTime(trimmed);
};

/**
 * 平常時のレスポンスは全フィールドが空文字で `alertflg` キー自体が無い
 * (2026-08-13 実測、docs/kmoni-endpoints.md)。したがって
 * 「alertflg が予報/警報のいずれかであること」を発表判定に使う。
 */
export function parseKmoniEew(raw: KmoniEewRaw): KmoniEewReport | null {
  const flag = raw.alertflg?.trim();
  if (flag !== '予報' && flag !== '警報') return null;

  const id = raw.report_id?.trim();
  if (!id) return null;

  return {
    id,
    reportNumber: numberOrNull(raw.report_num) ?? 0,
    alert: flag === '警報' ? 'warning' : 'forecast',
    isCancel: truthy(raw.is_cancel),
    isFinal: truthy(raw.is_final),
    isTraining: truthy(raw.is_training),
    hypocenter: {
      name: raw.region_name?.trim() || '不明',
      lat: numberOrNull(raw.latitude),
      lon: numberOrNull(raw.longitude),
      depthKm: numberOrNull(raw.depth),
      magnitude: numberOrNull(raw.magunitude),
    },
    maxIntensity: parseIntensityText(raw.calcintensity),
    originTime: parseEitherTime(raw.origin_time),
    announcedAt: parseEitherTime(raw.report_time),
  };
}

/**
 * kmoni EEW JSON の毎秒ポーリング。
 *
 * 無償で「予報」レベルまで取れる唯一の現実解 (§3)。取得した内容は自宅内の
 * 私的表示にのみ使い、第三者への配信・通知サービス化には使わない (§2(2))。
 */
export class KmoniEewWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly hub: Hub,
    private readonly clock: KmoniClock,
    private readonly onReport: (report: KmoniEewReport | null) => void,
  ) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      this.schedule(this.config.kmoni.eewIntervalMs);
      return Promise.resolve();
    }
    this.running = true;
    const startedAt = Date.now();
    const timestamp = toKmoniTimestamp(this.clock.latestAvailable());
    const url = `${this.config.kmoni.baseUrl}/webservice/hypo/eew/${timestamp}.json`;
    return fetchJson<KmoniEewRaw>(url, { timeoutMs: this.config.kmoni.requestTimeoutMs })
      .then((raw) => {
        this.hub.markSuccess('kmoniEew');
        this.onReport(parseKmoniEew(raw));
      })
      .catch((error: Error) => {
        this.hub.markFailure('kmoniEew', describeError(error));
        log.warn(`eew poll failed: ${describeError(error)}`);
      })
      .then(() => {
        this.running = false;
        const elapsed = Date.now() - startedAt;
        this.schedule(Math.max(100, this.config.kmoni.eewIntervalMs - elapsed));
      });
  }
}
