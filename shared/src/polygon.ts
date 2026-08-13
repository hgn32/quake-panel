/**
 * 多角形の内外判定。
 *
 * 用途は「利用地の座標がどの都道府県に入るか」を引くことだけ。地名を設定させずに
 * 済ませるための最小限の道具なので、境界の厳密さや測地系の扱いは追わない
 * (背景地図と同じ、kmoni 配信画像のピクセル座標で判定する)。
 */

/** 名前付きの領域。rings は [x0,y0,x1,y1,...] の平坦配列 (島ごとに 1 本)。 */
export interface PixelArea {
  name: string;
  rings: number[][];
}

/** 交差数による内外判定。ring は [x0,y0,x1,y1,...]。 */
export function pointInRing(ring: readonly number[], x: number, y: number): boolean {
  const count = Math.floor(ring.length / 2);
  if (count < 3) return false;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = ring[i * 2] ?? 0;
    const yi = ring[i * 2 + 1] ?? 0;
    const xj = ring[j * 2] ?? 0;
    const yj = ring[j * 2 + 1] ?? 0;
    // 頂点の重なりで二重に数えないよう、上向きの辺だけを数える
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 座標を含む領域の名前。どれにも入らなければ null (海上など)。 */
export function findAreaAtPixel(
  areas: readonly PixelArea[],
  x: number,
  y: number,
): string | null {
  for (const area of areas) {
    for (const ring of area.rings) {
      if (pointInRing(ring, x, y)) return area.name;
    }
  }
  return null;
}
