/**
 * 地図と地震情報パネルの境目の位置。
 *
 * 端末ごとに好みが分かれる (キオスクの縦置き・手元のスマホ・PC) ので
 * ドラッグで変えられるようにしてある。値はその端末のブラウザに保存する。
 *
 * 画面より大きい値や、パネルが潰れて読めなくなる値を弾く計算をここへ置く。
 * DOM に触らない純粋な計算なのでテストできる。
 */

/** 境目を動かせる範囲。最大は画面に対する割合で決める (小さい画面ほど狭くなる)。 */
export const SIDE_SIZE_LIMITS = {
  /** 横並び (地図 | 情報) のときのパネル幅 */
  width: { min: 260, maxRatio: 0.6 },
  /** 縦並び (地図 / 情報) のときのパネル高さ */
  height: { min: 140, maxRatio: 0.7 },
} as const;

/** 既定値。幅は従来の固定値と同じにして、見え方を変えない。 */
export const DEFAULT_SIDE_WIDTH = 420;

export type SideAxis = 'width' | 'height';

/**
 * パネルの大きさを画面に収まる範囲へ丸める。
 *
 * 画面が極端に小さいときは下限より上限が小さくなり得るので、そのときは
 * 上限を優先する (下限を守って画面からはみ出す方が困る)。
 */
export function clampSideSize(px: number, total: number, axis: SideAxis): number {
  const limits = SIDE_SIZE_LIMITS[axis];
  if (!Number.isFinite(total) || total <= 0) return limits.min;
  const upper = Math.max(1, Math.round(total * limits.maxRatio));
  const lower = Math.min(limits.min, upper);
  // px が壊れている (NaN 等) ときも、下限一律 (limits.min) ではなく画面に応じた
  // lower を返す。小さい画面では lower が upper 側 (下限より狭い) に丸まっている
  // ことがあり、そちらを優先しないと画面からはみ出す。
  if (!Number.isFinite(px)) return lower;
  return Math.round(Math.min(Math.max(px, lower), upper));
}
