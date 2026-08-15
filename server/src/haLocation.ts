import { parseHomeLocation, type HomeLocation, type JsonValue } from '@quake-panel/shared';
import type { Config } from './config.js';
import { createLogger, describeError } from './logger.js';

const log = createLogger('ha');

/** テストから差し替えるための最小の型 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Home Assistant に設定されている自宅の緯度経度。
 *
 * パネルの「HA の自宅位置を使う」で使う。ブラウザの位置情報 API は HTTPS でしか
 * 使えないため、素の HTTP で開くキオスク端末ではこちらが唯一の自動取得手段になる。
 *
 * 取得できなければ `null`。通知と同じで、失敗してもパネルの表示は止めない。
 */
export function fetchHomeLocation(
  config: Config,
  fetchImpl: FetchLike = fetch,
): Promise<HomeLocation | null> {
  const base = config.homeAssistant.apiUrl.replace(/\/$/, '');
  if (base === '' || config.homeAssistant.token === '') return Promise.resolve(null);
  return fetchImpl(`${base}/config`, {
    headers: { authorization: `Bearer ${config.homeAssistant.token}` },
    signal: AbortSignal.timeout(config.homeAssistant.timeoutMs),
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    // fetch のボディは型が付かないので、ここで JSON の形として受け直す
    .then((body) => parseHomeLocation(body as JsonValue))
    .catch((error: Error) => {
      log.warn(`Home Assistant から自宅の位置を取得できません: ${describeError(error)}`);
      return null;
    });
}
