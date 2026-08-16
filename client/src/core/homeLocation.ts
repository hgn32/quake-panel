import { GEOLOCATION_ERROR, type HomeLocation } from '@quake-panel/shared';

/**
 * 利用地を自動で決めるための取得元。
 *
 * ブラウザの位置情報 (その端末の現在地) を使う。**セキュアコンテキスト (HTTPS または
 * localhost) でしか API が存在しない**ので、素の HTTP で開くキオスク端末では使えない。
 *
 * 「取れたら設定へ入れる」だけで、保存の確定は利用者の操作に任せる。
 */

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  maximumAge: 60_000,
};

/**
 * こちら側の見切り時間。
 *
 * `PositionOptions.timeout` は「許可された後の測位」にしか効かない。
 * 許可ダイアログを閉じられた場合はブラウザからどちらのコールバックも来ず、
 * ボタンが押せないまま固まるので、自前でも打ち切る。
 */
const WATCHDOG_MS = 30_000;

/** ブラウザの位置情報が使えるか (HTTPS でないと API 自体が無い) */
export function canUseBrowserLocation(): boolean {
  return window.isSecureContext && 'geolocation' in navigator;
}

/** 現在地。失敗は `GeolocationPositionError` のまま返し、文言は呼び出し側で決める。 */
export function requestBrowserLocation(): Promise<HomeLocation> {
  if (!canUseBrowserLocation()) {
    return Promise.reject(new Error('この端末では位置情報を取得できません'));
  }
  return new Promise((resolve, reject) => {
    const watchdog = window.setTimeout(
      () => reject({ code: GEOLOCATION_ERROR.timeout }),
      WATCHDOG_MS,
    );
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(watchdog);
        resolve({ lat: position.coords.latitude, lon: position.coords.longitude });
      },
      (error) => {
        window.clearTimeout(watchdog);
        reject(error);
      },
      GEOLOCATION_OPTIONS,
    );
  });
}
