import type { EewState } from './models.js';
import type { HomeLocation } from './homeLocation.js';

/** この EEW が利用地にとってどのランクか */
export type EewRelevance = 'warning' | 'forecast' | 'none';

/** 「関わる」とみなす震央距離の選択肢 (km) */
export const EEW_RADIUS_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 150, label: '150km' },
  { value: 300, label: '300km' },
  { value: 500, label: '500km' },
];

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 2 点間の大円距離 (km)。ハバーサイン公式。 */
export function haversineKm(a: HomeLocation, b: HomeLocation): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const PREFECTURE_SUFFIX_CHARS: readonly string[] = ['都', '道', '府', '県'];

/**
 * 「都・道・府・県」で終わる名前は、その接尾辞を落とした形も候補に含めて返す。
 *
 * 単純に両辺の末尾を無条件で 1 文字落として比べると、「京都」(地名自体が「都」で
 * 終わる) のようなケースで壊れる。「京都府」→「京都」(接尾辞を落とした形) と
 * 「京都」(そのまま) は一致してほしいが、「京都」の末尾の「都」も無条件で
 * 落としてしまうと「京」対「京都」になり一致しなくなる。
 * そこで各辺について「そのままの形」と「接尾辞を落とした形」の両方を候補とし、
 * どちらかの組み合わせが一致すれば同じ県とみなす。
 */
function candidateNames(name: string): ReadonlySet<string> {
  const suffix = name.slice(-1);
  if (PREFECTURE_SUFFIX_CHARS.includes(suffix)) {
    return new Set([name, name.slice(0, -1)]);
  }
  return new Set([name]);
}

/**
 * 県名の照合。P2P 556 の pref は「宮崎」のように接尾辞なしで来ることがあり、
 * 地図由来の県名は「宮崎県」形式。末尾の都・道・府・県の有無を吸収して比べる。
 * 部分一致は使わない (「京都」と「東京都」の類の誤一致を避ける)。
 */
export function prefMatches(a: string, b: string): boolean {
  const trimmedA = a.trim();
  const trimmedB = b.trim();
  if (trimmedA === '' || trimmedB === '') return false;
  if (trimmedA === trimmedB) return true;
  const candidatesA = candidateNames(trimmedA);
  return [...candidateNames(trimmedB)].some((candidate) => candidatesA.has(candidate));
}

/**
 * この EEW の利用地にとってのランク。
 *
 * - 警報かつ警報対象地域 (P2P 556 の regions) に利用地の県が含まれる場合は 'warning'。
 * - 震央が radiusKm 以内なら 'forecast'
 *   (対象地域に利用地の県が無い警報もここへ落ちる。利用地が警報対象外でも
 *   震央が近ければ揺れる可能性はあるので、予報扱いで知らせる)。
 * - 震央が不明 (lat/lon が null) なら 'forecast' (判定できないものは鳴らす側に倒す)。
 * - それ以外は 'none'。
 *
 * キャンセル報・訓練報の扱いはここでは関知しない (呼び出し側の責務)。
 * 距離は「関わりがあるかどうか」の絞り込みにのみ使い、
 * 独自の到達予測・震度予測は一切行わない (気象業務法、検討書 §2(3))。
 */
export function eewRelevance(
  eew: EewState,
  homePrefecture: string | null,
  home: HomeLocation,
  radiusKm: number,
): EewRelevance {
  if (
    homePrefecture !== null &&
    eew.alert === 'warning' &&
    eew.regions.some((region) => prefMatches(region.pref, homePrefecture))
  ) {
    return 'warning';
  }

  if (eew.hypocenter.lat === null || eew.hypocenter.lon === null) return 'forecast';

  const distanceKm = haversineKm(home, { lat: eew.hypocenter.lat, lon: eew.hypocenter.lon });
  if (distanceKm <= radiusKm) return 'forecast';

  return 'none';
}
