import type { TsunamiInfo } from './models.js';

/**
 * 津波予報のうち「利用地に関わる区」に印を付ける。
 *
 * どの予報区を自分ごととして扱うかは端末ごとの設定なので、サーバーでは決めない
 * (サーバーは受け取った予報をそのまま配り、印を付けるのは表示側)。
 *
 * 予報区名は必ずしも都道府県名ではない (例: 「宮崎県」「北海道太平洋沿岸東部」)。
 * 設定側に「宮崎県」とだけ書いても効くよう、部分一致で判定する。
 */
export function applyHomeAreas(
  info: TsunamiInfo,
  homeAreas: readonly string[],
): TsunamiInfo {
  const targets = homeAreas.map((name) => name.trim()).filter((name) => name !== '');
  if (targets.length === 0) return info;
  const areas = info.areas.map((area) => ({
    ...area,
    isHome: targets.some((target) => area.name.includes(target) || target.includes(area.name)),
  }));
  return { ...info, areas, affectsHome: areas.some((area) => area.isHome) };
}
