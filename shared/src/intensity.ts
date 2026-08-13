/**
 * 気象庁震度階級の表現をひとつに揃えるためのユーティリティ。
 *
 * 扱う入力は 3 系統ある。
 *   - P2P地震情報の `scale` 整数 (10=1, 45=5弱, 70=7 …)
 *   - kmoni EEW JSON の `calcintensity` 文字列 ("5弱" / "5-" など表記ゆれあり)
 *   - 内部表現 `IntensityLevel` (下記)
 *
 * 内部表現は「震度階級を順序比較したい」という要求が中心なので、
 * P2P と同じ整数コードをそのまま正とする。
 */

/** P2P地震情報と同じ整数コード。順序比較に使える。 */
export type IntensityLevel =
  | 10 // 震度1
  | 20 // 震度2
  | 30 // 震度3
  | 40 // 震度4
  | 45 // 震度5弱
  | 46 // 震度5弱以上と推定 (震度計不明)
  | 50 // 震度5強
  | 55 // 震度6弱
  | 60 // 震度6強
  | 70; // 震度7

export const INTENSITY_UNKNOWN = -1;

const LABELS: ReadonlyArray<readonly [number, string]> = [
  [10, '1'],
  [20, '2'],
  [30, '3'],
  [40, '4'],
  [45, '5弱'],
  [46, '5弱以上'],
  [50, '5強'],
  [55, '6弱'],
  [60, '6強'],
  [70, '7'],
];

/** 震度階級の表示ラベル。不明・欠測は null。 */
export function intensityLabel(scale: number | null | undefined): string | null {
  if (scale == null) return null;
  const hit = LABELS.find(([code]) => code === scale);
  return hit ? hit[1] : null;
}

/**
 * 文字列表記の震度をコードへ。
 * kmoni は "5弱" と "5-" の両方の表記が観測されているため双方を受ける。
 */
export function parseIntensityText(text: string | null | undefined): IntensityLevel | null {
  if (!text) return null;
  const t = text.trim().replace(/\s/g, '');
  if (t === '') return null;
  switch (t) {
    case '5弱':
    case '5-':
    case '5m':
      return 45;
    case '5強':
    case '5+':
    case '5p':
      return 50;
    case '6弱':
    case '6-':
    case '6m':
      return 55;
    case '6強':
    case '6+':
    case '6p':
      return 60;
    default:
      break;
  }
  const n = Number.parseInt(t, 10);
  if (Number.isNaN(n)) return null;
  if (n >= 1 && n <= 4) return (n * 10) as IntensityLevel;
  if (n === 7) return 70;
  return null;
}

/** 震度階級ごとの表示色 (気象庁の配色に準拠しつつ暗背景向けに調整) */
export function intensityColor(scale: number | null | undefined): string {
  switch (scale) {
    case 10:
      return '#4a6a8a';
    case 20:
      return '#3f9ec4';
    case 30:
      return '#39a86b';
    case 40:
      return '#e5c53c';
    case 45:
    case 46:
      return '#f0a03c';
    case 50:
      return '#e8752c';
    case 55:
      return '#d94a3d';
    case 60:
      return '#b02a5b';
    case 70:
      return '#8f2fa8';
    default:
      return '#5a6270';
  }
}

/** 震度色の上に置く文字色 (可読性のため明度で切り替える) */
export function intensityTextColor(scale: number | null | undefined): string {
  return scale === 40 || scale === 45 || scale === 46 ? '#1b1d22' : '#ffffff';
}

/** a が b 以上の震度か (不明は常に false) */
export function intensityAtLeast(
  a: number | null | undefined,
  b: number,
): boolean {
  return a != null && a > 0 && a >= b;
}
