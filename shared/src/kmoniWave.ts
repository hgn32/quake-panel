/**
 * EEW 予測円画像 (PSWaveImg) から P 波・S 波の半径を測る。
 *
 * §2(3) 気象業務法: 到達予測を独自に計算することは絶対にしない。ここで求める半径は
 * 気象庁が配信した画像から測った値そのものであり、こちらで到達予測を計算するもの
 * ではない。
 */

/** 予測円画像から測った半径 (配信画像のピクセル)。測れなければ null。 */
export interface WaveRadii {
  /** P 波 (青) */
  p: number | null;
  /** S 波 (赤) */
  s: number | null;
}

/**
 * 予測円画像の画素から、震央中心の半径を測る (中央値)。
 *
 * 実測 (2026-09-07 23:21 熊本県天草・芦北地方の EEW、`PSWaveImg/eew/20260907/*.eew.gif`)
 * では、予測円画像で S 波は純赤 (ff0000)、P 波は純青 (0000ff) の 1px 線として描かれて
 * おり、震央からの距離の**中央値**を採ると半径が正確に出る (四分位は中央値の ±0.4px
 * に収まる)。円が画像の端で切れていても、焼き込みの「P」「S」の文字や震央マーカー
 * (赤い X) が混ざっても、中央値なら影響を受けない (実測で 23:22:30 以降は文字が
 * 第3四分位を汚したが中央値は無傷だった)。平均や外接矩形ではこの汚染に弱いため、
 * 中央値を採用している。
 *
 * 全画素の走査は `while` で書く (規約で `for` は禁止)。
 */
export function measureWaveRadii(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  center: { x: number; y: number },
): WaveRadii {
  const redDistances: number[] = [];
  const blueDistances: number[] = [];
  const total = width * height;
  let index = 0;
  while (index < total) {
    const offset = index * 4;
    const alpha = pixels[offset + 3] ?? 0;
    if (alpha !== 0) {
      const r = pixels[offset] ?? 0;
      const g = pixels[offset + 1] ?? 0;
      const b = pixels[offset + 2] ?? 0;
      const isRed = r > 200 && g < 60 && b < 60;
      const isBlue = b > 200 && r < 60 && g < 60;
      if (isRed || isBlue) {
        const x = index % width;
        const y = (index - x) / width;
        const distance = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y);
        if (isRed) redDistances.push(distance);
        else blueDistances.push(distance);
      }
    }
    index += 1;
  }

  return {
    p: medianOrNull(blueDistances),
    s: medianOrNull(redDistances),
  };
}

/** 円と判定できる最小画素数 (実測では円は 269〜447 画素あった)。 */
const MIN_PIXELS = 20;

/** 中央値。画素数が `MIN_PIXELS` 未満なら測定不能として null を返す。 */
function medianOrNull(distances: number[]): number | null {
  if (distances.length < MIN_PIXELS) return null;
  const sorted = [...distances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1] ?? null;
  const upper = sorted[mid] ?? null;
  if (lower === null || upper === null) return null;
  return (lower + upper) / 2;
}
