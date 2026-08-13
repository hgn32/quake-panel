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

/**
 * 都道府県名から、その県に関わる津波予報区の手掛かりを作る。
 *
 * 予報区名は多くが「<県名>」か「<県名>○○沿岸」なので県名だけで拾えるが、
 * 県名を含まない予報区もある (「東京湾内湾」「有明・八代海」など)。
 * それらだけをここに持つ。網羅表ではなく、自動設定を実用にするための補助。
 * 足りなければ設定画面で手動指定に切り替えられる。
 */
const EXTRA_AREAS: Record<string, readonly string[]> = {
  北海道: ['オホーツク海沿岸'],
  青森県: ['陸奥湾'],
  東京都: ['東京湾内湾', '伊豆諸島', '小笠原諸島'],
  神奈川県: ['相模湾・三浦半島', '東京湾内湾'],
  千葉県: ['東京湾内湾'],
  愛知県: ['伊勢・三河湾'],
  三重県: ['伊勢・三河湾'],
  兵庫県: ['淡路島南部'],
  島根県: ['隠岐'],
  福岡県: ['有明・八代海'],
  佐賀県: ['有明・八代海'],
  長崎県: ['壱岐・対馬', '有明・八代海'],
  熊本県: ['有明・八代海'],
  鹿児島県: ['種子島・屋久島地方', '奄美群島・トカラ列島'],
  沖縄県: ['沖縄本島地方', '宮古島・八重山地方', '大東島地方'],
};

/** 利用地の都道府県から、強調する津波予報区を決める */
export function tsunamiAreasForPrefecture(prefecture: string | null): string[] {
  if (!prefecture) return [];
  return [prefecture, ...(EXTRA_AREAS[prefecture] ?? [])];
}
