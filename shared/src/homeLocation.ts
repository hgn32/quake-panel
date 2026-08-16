/**
 * 利用地 (緯度経度) の読み取り。
 *
 * 同じ形の値を複数箇所で扱う。
 *
 * - 保存された利用地・URL パラメータなどの `lat` / `lon`
 * - 外部 API 由来の `latitude` / `longitude`
 * - ブラウザの位置情報 API (`coords.latitude` / `coords.longitude`)
 *
 * 取り違えと範囲外の値を一か所で止めるため、検証はここに集める。
 */

export interface HomeLocation {
  lat: number;
  lon: number;
}

/** `JSON.parse` / `Response#json` から受けた値を、型を緩めずに扱うための最小の型 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** ブラウザの位置情報 API が返すエラーコード (`GeolocationPositionError`) */
export const GEOLOCATION_ERROR = {
  permissionDenied: 1,
  positionUnavailable: 2,
  timeout: 3,
} as const;

/**
 * `{lat, lon}` でも `{latitude, longitude}` でも読む。
 *
 * 欠損・型違い・範囲外はすべて `null`。呼び出し側は「取得できなかった」に倒す。
 */
export function parseHomeLocation(value: JsonValue): HomeLocation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const lat = pickNumber(value['lat'], value['latitude']);
  const lon = pickNumber(value['lon'], value['longitude']);
  if (lat === null || lon === null) return null;
  if (!isLat(lat) || !isLon(lon)) return null;
  // 外部 API には位置未設定のとき 0,0 (ギニア湾沖) を返すものがある。
  // 地図が世界の反対側へ飛ぶので「未設定」として扱う。
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** 位置情報の取得に失敗した理由を、画面に出せる日本語にする */
export function geolocationErrorMessage(code: number | null): string {
  switch (code) {
    case GEOLOCATION_ERROR.permissionDenied:
      return '位置情報の利用が許可されませんでした。ブラウザの設定で許可してください。';
    case GEOLOCATION_ERROR.positionUnavailable:
      return '位置情報を取得できませんでした。屋内では測位できないことがあります。';
    case GEOLOCATION_ERROR.timeout:
      return '位置情報の取得に時間がかかりすぎました。もう一度試してください。';
    default:
      return '位置情報を取得できませんでした。';
  }
}

function pickNumber(...candidates: Array<JsonValue | undefined>): number | null {
  const found = candidates.find((candidate) => typeof candidate === 'number');
  return typeof found === 'number' ? found : null;
}

const isLat = (value: number): boolean => Number.isFinite(value) && value >= -90 && value <= 90;
const isLon = (value: number): boolean => Number.isFinite(value) && value >= -180 && value <= 180;
