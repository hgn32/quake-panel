import type { TsunamiGrade, TsunamiInfo } from './models.js';

/**
 * 津波予報のうち「利用地に関わる区」に印を付ける。
 *
 * どの予報区を自分ごととして扱うかは端末ごとの設定なので、サーバーでは決めない
 * (サーバーは受け取った予報をそのまま配り、印を付けるのは表示側)。
 *
 * 以前は `area.name.includes(target) || target.includes(area.name)` という
 * 双方向部分一致で判定していたが、これだと例えば「瀬戸内海沿岸」を home に持つ
 * 大阪府の設定に「大分県瀬戸内海沿岸」が誤って一致してしまう
 * (気象庁のコード表と突き合わせると、拾いすぎ 34 件・取りこぼし 18 件)。
 * この判定はこれから音・明滅のゲートになるため、曖昧な部分一致はやめて
 * 完全一致にする。予報区名が県名そのものでない場合は、呼び出し側が
 * {@link tsunamiAreasForPrefecture} で県名を予報区名の一覧へ展開してから
 * 渡すことを前提とする。
 */
export function applyHomeAreas(
  info: TsunamiInfo,
  homeAreas: readonly string[],
): TsunamiInfo {
  const targets = new Set(homeAreas.map((name) => name.trim()).filter((name) => name !== ''));
  // 設定が空 (利用地未設定・手動モードで予報区を空にした等) でも、以前 isHome が
  // 付いていた info をそのまま返してはいけない。全区を isHome: false に写像し直し、
  // 印と affectsHome を確実に消す (印はこの後 tsunamiAlertRank の鳴動ゲートに使われる)。
  const areas = info.areas.map((area) => ({
    ...area,
    isHome: targets.has(area.name),
  }));
  return { ...info, areas, affectsHome: areas.some((area) => area.isHome) };
}

/**
 * 都道府県名から、その県に関わる津波予報区を引く表。
 *
 * 予報区名は必ずしも県名を含まない。県名で拾えるものは県名で拾えるが、
 * 「東京湾内湾」「有明・八代海」のような湾・諸島の区と、
 * **「東北地方太平洋沿岸」「関東地方」「瀬戸内海沿岸」のような広域の区**は
 * 県名を含まないため、県名だけの部分一致では取りこぼす。
 * 広域の区は津波警報の第一報で実際に使われるので、取りこぼすと
 * 一番知りたい場面で自分の県に印が付かない。
 *
 * この表は手書きではなく、気象庁「地震火山関連コード表」の
 * AreaTsunami コード表 (津波予報区 98 区) から機械的に起こしている。
 * 同表は備考欄に「領域表現（構成する津波予報区 201,210,220,250）」のように
 * 広域の区の構成を、「結合表現（構成する津波予報区 310,311,312）」のように
 * 県境をまたぐ結合表現の構成を、それぞれ明記しているので、
 * どの区がどの県に関わるかは推測せずに決められる。
 * 表から県名を機械的に決められないのは湾・諸島の 7 区
 * (オホーツク海沿岸・東京湾内湾・伊豆諸島・小笠原諸島・沖縄本島地方・
 * 大東島地方・宮古島＆八重山地方) だけで、そこだけ人手で対応付けた。
 * 全 98 区について、この機械的な導出と本表を突き合わせるテストを
 * shared/test/tsunami.test.mjs に置いている。
 *
 * 出典: https://xml.kishou.go.jp/ 個別コード表 「地震火山関連コード表.xls」シート31
 */
const PREFECTURE_TSUNAMI_AREAS: Record<string, readonly string[]> = {
  北海道: [
    'オホーツク海沿岸', '北海道太平洋沿岸', '北海道太平洋沿岸中部', '北海道太平洋沿岸東部', '北海道太平洋沿岸西部', '北海道日本海沿岸', '北海道日本海沿岸北部',
    '北海道日本海沿岸南部',
  ],
  青森県: ['東北地方太平洋沿岸', '東北地方日本海沿岸', '陸奥湾', '青森県太平洋沿岸', '青森県日本海沿岸'],
  岩手県: ['東北地方太平洋沿岸'],
  宮城県: ['東北地方太平洋沿岸'],
  秋田県: ['東北地方日本海沿岸'],
  山形県: ['東北地方日本海沿岸'],
  福島県: ['東北地方太平洋沿岸'],
  茨城県: ['関東地方'],
  // 「千葉県」(481) は 310,311,312 の結合表現で、東京湾内湾 (312) を含むため
  // 東京都・神奈川県にも関わる。同様に「神奈川県」(482) も 312,330 を含むため
  // 千葉県・東京都に関わる。広報が基本区に分解せず結合表現のまま
  // (例:「千葉県」とだけ) 発表することがあるので、県境をまたぐ相手県も
  // 互いの一覧に加えておく。
  千葉県: ['千葉県九十九里・外房', '千葉県内房', '東京湾内湾', '関東地方', '神奈川県'],
  東京都: ['伊豆・小笠原諸島', '伊豆諸島', '小笠原諸島', '東京湾内湾', '関東地方', '千葉県', '神奈川県'],
  神奈川県: ['東京湾内湾', '相模湾・三浦半島', '関東地方', '千葉県'],
  新潟県: ['佐渡', '北陸地方', '新潟県上中下越'],
  富山県: ['北陸地方'],
  石川県: ['北陸地方', '石川県加賀', '石川県能登'],
  福井県: ['北陸地方'],
  静岡県: ['東海地方'],
  // 「愛知県」(485) / 「三重県」(486) はどちらも伊勢・三河湾 (391) を共有する
  // 結合表現なので、互いの一覧に加える。
  愛知県: ['伊勢・三河湾', '愛知県外海', '東海地方', '三重県'],
  三重県: ['三重県南部', '伊勢・三河湾', '東海地方', '愛知県'],
  京都府: ['近畿中国日本海沿岸'],
  大阪府: ['瀬戸内海沿岸'],
  兵庫県: ['兵庫県北部', '兵庫県瀬戸内海沿岸', '淡路島南部', '瀬戸内海沿岸', '近畿中国日本海沿岸', '近畿四国太平洋沿岸'],
  和歌山県: ['近畿四国太平洋沿岸'],
  鳥取県: ['近畿中国日本海沿岸'],
  島根県: ['島根県出雲・石見', '近畿中国日本海沿岸', '隠岐'],
  岡山県: ['瀬戸内海沿岸'],
  広島県: ['瀬戸内海沿岸'],
  山口県: ['山口県日本海沿岸', '山口県瀬戸内海沿岸', '瀬戸内海沿岸', '近畿中国日本海沿岸'],
  徳島県: ['近畿四国太平洋沿岸'],
  香川県: ['瀬戸内海沿岸'],
  愛媛県: ['愛媛県宇和海沿岸', '愛媛県瀬戸内海沿岸', '瀬戸内海沿岸', '近畿四国太平洋沿岸'],
  高知県: ['近畿四国太平洋沿岸'],
  // 「佐賀県」(783) 「長崎県」(784) 「熊本県」(785) 「福岡県」(782 の一部) は
  // いずれも有明・八代海 (712) を共有する結合表現なので、4 県で互いの一覧に加える。
  福岡県: ['九州地方東部', '九州地方西部', '有明・八代海', '福岡県日本海沿岸', '福岡県瀬戸内海沿岸', '佐賀県', '長崎県', '熊本県'],
  佐賀県: ['九州地方西部', '佐賀県北部', '有明・八代海', '福岡県', '長崎県', '熊本県'],
  長崎県: ['九州地方西部', '壱岐・対馬', '有明・八代海', '長崎県西方', '福岡県', '佐賀県', '熊本県'],
  熊本県: ['九州地方西部', '有明・八代海', '熊本県天草灘沿岸', '福岡県', '佐賀県', '長崎県'],
  大分県: ['九州地方東部', '大分県瀬戸内海沿岸', '大分県豊後水道沿岸'],
  宮崎県: ['九州地方東部'],
  鹿児島県: ['九州地方東部', '九州地方西部', '奄美群島・トカラ列島', '種子島・屋久島地方', '薩南諸島', '鹿児島県東部', '鹿児島県西部'],
  沖縄県: ['大東島地方', '宮古島・八重山地方', '沖縄本島地方', '沖縄県地方'],
};

/** 利用地の都道府県から、強調する津波予報区を決める */
export function tsunamiAreasForPrefecture(prefecture: string | null): string[] {
  if (!prefecture) return [];
  // 県名そのものも手掛かりに残す。「宮崎県」のように県名がそのまま区名になる県や、
  // 「熊本県天草灘沿岸」のように県名で始まる区は、これだけで拾える。
  return [prefecture, ...(PREFECTURE_TSUNAMI_AREAS[prefecture] ?? [])];
}

/** 音・明滅を出す下限。'none' は津波では鳴らさない設定 */
export type TsunamiAlertMin = 'major' | 'warning' | 'watch' | 'forecast' | 'none';

/** 設定画面に出す選択肢 */
export const TSUNAMI_ALERT_MIN_CHOICES: ReadonlyArray<{ value: TsunamiAlertMin; label: string }> = [
  { value: 'major', label: '大津波警報のみ' },
  { value: 'warning', label: '津波警報以上' },
  { value: 'watch', label: '津波注意報以上' },
  { value: 'forecast', label: '津波予報でも' },
  { value: 'none', label: '出さない' },
];

/**
 * グレードの強さ。数が大きいほど重い。
 * `Unknown` は電文上「その他の情報 (若干の海面変動等)」、いわゆる津波予報にあたるため
 * 4 段階のうち最も軽い扱いにする。
 */
export function tsunamiGradeRank(grade: TsunamiGrade): number {
  switch (grade) {
    case 'MajorWarning':
      return 4;
    case 'Warning':
      return 3;
    case 'Watch':
      return 2;
    case 'Unknown':
      return 1;
  }
}

/** {@link TsunamiAlertMin} を、それ以上のグレードだけ通すしきい値ランクに変換する */
function tsunamiAlertMinRank(min: TsunamiAlertMin): number {
  switch (min) {
    case 'major':
      return 4;
    case 'warning':
      return 3;
    case 'watch':
      return 2;
    case 'forecast':
      return 1;
    case 'none':
      // 4 段階の最大 (MajorWarning=4) より大きくして、何があっても超えないようにする。
      return Infinity;
  }
}

/**
 * この津波予報で音・明滅を出すべき強さ (0 なら出さない)。
 *
 * - 自分の予報区 (isHome) の最大グレードが下限 (min) 以上なら、そのランクを返す。
 * - `nationalMajor` が true のときは、自分の区が対象外でもどこかに大津波警報が
 *   出ていればランク 4 を返す (3.11 のような国家的事象は、自分の県が対象でなくても
 *   知らせる)。ただし `min === 'none'` は「津波では一切鳴らさない」という明示的な
 *   設定なので、この例外より優先する (nationalMajor では上書きしない)。
 * - 解除・予報区なし・情報自体が無い場合は常に 0。
 *
 * 呼び出し側 (client) は「前回より上がったときだけ」鳴らす想定。
 * 続報のたびに同じランクで鳴り直すのを防ぐのは、この関数の責務ではなく呼び出し側で行う。
 */
export function tsunamiAlertRank(
  info: TsunamiInfo | null,
  min: TsunamiAlertMin,
  nationalMajor: boolean,
): number {
  if (info === null || info.cancelled) return 0;
  if (min === 'none') return 0;

  const thresholdRank = tsunamiAlertMinRank(min);
  const homeRanks = info.areas
    .filter((area) => area.isHome)
    .map((area) => tsunamiGradeRank(area.grade));
  const maxHomeRank = homeRanks.length === 0 ? 0 : Math.max(...homeRanks);
  // nationalMajor の条件 (どこかに大津波警報があり、国家的事象として知らせる設定) が
  // 成立するときは、自区のランクが既にしきい値を超えていても、結果が 4 を
  // 下回らないようにする。自区が対象外のときだけ 4 に上がるのは非対称なので揃える。
  const nationalMajorHit = nationalMajor && info.areas.some((area) => area.grade === 'MajorWarning');
  if (maxHomeRank >= thresholdRank) return nationalMajorHit ? Math.max(maxHomeRank, 4) : maxHomeRank;

  if (nationalMajorHit) return 4;

  return 0;
}
