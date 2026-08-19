import { prefMatches } from './eewRelevance.js';
import type { QuakeInfo } from './models.js';

/**
 * 地震情報の絞り込み。
 *
 * 全国の地震をすべて並べると、体に感じない小さな地震や、日本国内の観測点が
 * わずかに揺れただけの海外の地震 (例: 台湾付近で国内が震度 1) が履歴を埋めてしまう。
 * 何を「自分に関係がある」とみなすかは住んでいる場所と好みで変わるので、
 * 端末ごとの設定にして、判定だけここへ置く。
 */
export interface QuakeFilter {
  /** この震度に満たない地震は出さない (0 ならすべて出す。P2P と同じ整数コード) */
  minIntensity: number;
  /** 利用地の都道府県で震度が観測された地震だけ出す */
  homePrefectureOnly: boolean;
}

export const DEFAULT_QUAKE_FILTER: QuakeFilter = {
  minIntensity: 0,
  homePrefectureOnly: false,
};

/** 設定画面に出す選択肢 (値は P2P の整数コード) */
export const MIN_INTENSITY_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'すべて' },
  { value: 10, label: '震度1以上' },
  { value: 20, label: '震度2以上' },
  { value: 30, label: '震度3以上' },
  { value: 40, label: '震度4以上' },
  { value: 45, label: '震度5弱以上' },
];

/**
 * この地震を表示するか。
 *
 * - 震度のしきい値を設けている場合、震度が分からない電文 (震源に関する情報など) は
 *   「揺れの情報が無い」ものとして落とす。
 * - 利用地の県が分からないとき (地図の外を指しているなど) は、県の条件を無視する。
 *   分からないことを理由に何も出さないより、出しすぎる方が安全側。
 */
export function matchesQuakeFilter(
  quake: QuakeInfo,
  filter: QuakeFilter,
  homePrefecture: string | null,
): boolean {
  if (filter.minIntensity > 0) {
    if (quake.maxIntensity === null) return false;
    if (quake.maxIntensity < filter.minIntensity) return false;
  }
  if (filter.homePrefectureOnly && homePrefecture !== null) {
    // 双方向部分一致 (point.pref.includes(homePrefecture) など) は「京都」で
    // 「東京都」に誤爆するため使わない。eewRelevance.ts の prefMatches と同じ方針
    // (接尾辞の有無だけ吸収する完全一致) に揃える。
    const shook = quake.points.some(
      (point) => point.scale !== null && prefMatches(point.pref, homePrefecture),
    );
    if (!shook) return false;
  }
  return true;
}
