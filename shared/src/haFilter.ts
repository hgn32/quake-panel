import { parseIntensityText } from './intensity.js';
import type { EewState, QuakeInfo, TsunamiInfo } from './models.js';
import { applyHomeAreas, tsunamiAreasForPrefecture } from './tsunami.js';

/**
 * Home Assistant へ流す通知の絞り込み。
 *
 * パネルの履歴は端末ごとに絞れるが、HA への通知はサーバーが 1 か所で出すので
 * サーバーの設定になる。全国の小さな地震まで自動化を起こすと、ダッシュボードの
 * 切り替えや照明の点灯が毎日走ってしまうため、既定でも通知は絞れるようにする。
 *
 * 判定は「表示するかどうか」とは別物なので、パネル側の絞り込み
 * (`quakeFilter.ts`) とは共有しない。画面には出したいが自動化は起こしたくない、
 * という組み合わせが普通にあるため。
 */
export interface HaNotifyFilter {
  /** この震度に満たない地震は通知しない (0 ならすべて通知) */
  minIntensity: number;
  /**
   * 通知する都道府県。空なら全国。
   * 地震情報は観測点の県、緊急地震速報は予想震度が出ている地域名で見る。
   */
  prefectures: readonly string[];
}

export const DEFAULT_HA_NOTIFY_FILTER: HaNotifyFilter = {
  minIntensity: 0,
  prefectures: [],
};

/** 地震情報 (P2P 551) を HA へ流すか */
export function shouldNotifyQuake(quake: QuakeInfo, filter: HaNotifyFilter): boolean {
  if (filter.minIntensity > 0) {
    // 震度の分からない電文 (震源に関する情報など) は「揺れの情報が無い」ものとして落とす
    if (quake.maxIntensity === null) return false;
    if (quake.maxIntensity < filter.minIntensity) return false;
  }
  if (filter.prefectures.length === 0) return true;
  return quake.points.some(
    (point) => point.scale !== null && matchesArea(point.pref, filter.prefectures),
  );
}

/**
 * 緊急地震速報を HA へ流すか。
 *
 * 取消報は「解除」を伝える必要があるので、絞り込みに関わらず必ず流す。
 * 通知だけ止めると、自動化で点けた照明が消えないままになる。
 */
export function shouldNotifyEew(eew: EewState | null, filter: HaNotifyFilter): boolean {
  if (!eew) return true;
  if (eew.isCancel) return true;
  if (filter.minIntensity > 0) {
    if (eew.maxIntensity === null) return false;
    if (eew.maxIntensity < filter.minIntensity) return false;
  }
  if (filter.prefectures.length === 0) return true;
  // 予想震度の地域が来ていない第一報は、地域では落とさない (震度の条件だけ見る)
  if (eew.regions.length === 0) return true;
  return eew.regions.some((region) => matchesArea(region.name, filter.prefectures));
}

/**
 * 津波予報を HA へ流すか。
 *
 * 判定は**画面と同じ仕様**にする (`applyHomeAreas` の `affectsHome`)。
 * 県名だけの部分一致では「東北地方太平洋沿岸」のような広域の区や
 * 「有明・八代海」のような湾の区を取りこぼすため、
 * 県から予報区を引き直してから判定する。
 *
 * 震度のしきい値は見ない。津波に震度は無く、遠地地震で震度が小さくても
 * 津波は来るため (2010年チリ地震など)。
 *
 * 解除と対象地域なしは、絞り込みに関わらず必ず流す。
 * 緊急地震速報の取消と同じで、ここで黙ると自動化を戻せなくなる。
 */
export function shouldNotifyTsunami(
  tsunami: TsunamiInfo | null,
  filter: HaNotifyFilter,
): boolean {
  if (!tsunami) return true;
  if (tsunami.cancelled) return true;
  if (tsunami.areas.length === 0) return true;
  if (filter.prefectures.length === 0) return true;
  const homeAreas = filter.prefectures.flatMap((pref) => tsunamiAreasForPrefecture(pref));
  return applyHomeAreas(tsunami, homeAreas).affectsHome;
}

/** 予報区名・地域名は県名と一致しないことがあるので、部分一致でも拾う */
function matchesArea(name: string, prefectures: readonly string[]): boolean {
  return prefectures.some((pref) => name === pref || name.includes(pref) || pref.includes(name));
}

/** 設定文字列 (カンマ区切り) を県の一覧にする。読点・全角カンマも区切りとして扱う。 */
export function parsePrefectureList(value: string): string[] {
  return value
    .split(/[,、，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** アドオンの設定画面に出す選択肢 (値は P2P の整数コード) */
export const HA_MIN_INTENSITY_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'すべて' },
  { value: 10, label: '震度1以上' },
  { value: 20, label: '震度2以上' },
  { value: 30, label: '震度3以上' },
  { value: 40, label: '震度4以上' },
  { value: 45, label: '震度5弱以上' },
  { value: 50, label: '震度5強以上' },
  { value: 55, label: '震度6弱以上' },
];

/**
 * しきい値の設定文字列を震度コードにする。
 *
 * アドオンの設定は日本語のラベル ("震度3以上") で選ばせたいが、
 * ラベルとコードの対応を options-env.mjs 側に持たせると二重管理になるので、
 * ラベルも整数コードもここで受ける。解釈できない値は null を返し、
 * 呼び出し側で既定 (絞り込みなし) に落とす。
 */
export function parseMinIntensity(value: string | null | undefined): number | null {
  if (value == null) return null;
  const text = value.trim();
  if (text === '') return null;
  if (text === 'すべて' || text === 'all' || text === 'off') return 0;
  // 整数コードでの指定 (0 / 10 / 45 …)
  const code = Number(text);
  if (Number.isInteger(code) && (code === 0 || HA_MIN_INTENSITY_CHOICES.some((c) => c.value === code))) {
    return code;
  }
  // "震度5弱以上" のようなラベル
  return parseIntensityText(text.replace(/^震度/, '').replace(/以上$/, ''));
}
