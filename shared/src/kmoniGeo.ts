/**
 * 強震モニタ配信画像の座標系。
 *
 * kmoni は投影パラメータを公開していないため、公開されている基図
 * (`/data/map_img/CommonImg/base_map_w.gif`) と実際の観測点配置に対して
 * オープンな行政区域データを重ね、最小二乗で較正した値を用いる。
 * 較正手順は `scripts/calibrate-kmoni-map.py` に残してあり、いつでも再実行できる。
 *
 * 較正結果 (2026-08-13):
 *   - 投影は正距円筒 (経度・緯度それぞれに一定の px/度)。回転・円錐投影ではない。
 *   - 島嶼 15 点の対応付けによる残差 RMS は経度方向 0.72px / 緯度方向 0.49px。
 *   - sy/sx = 1.208 → 標準緯度およそ 34.1°N。日本域図として妥当な値。
 *
 * この座標系は「リアルタイム震度」「予測円 (PSWaveImg)」「予想震度 (EstShindoImg)」
 * すべてで共通。したがって kmoni 由来の画像同士は無変換で重ねられる。
 *
 * 注意: 南西諸島 (沖縄・先島) は基図左上に別枠 (インセット) として描かれており、
 * この線形変換の対象外。`isInsetArea()` で判定できる。
 */
export const KMONI_MAP = {
  /** 配信画像の実サイズ (実測: 352x400 GIF) */
  width: 352,
  height: 400,
  /** x = (lon - west) * pxPerDegLon */
  west: 128.6169,
  /** y = (north - lat) * pxPerDegLat */
  north: 46.2239,
  pxPerDegLon: 20.2976,
  pxPerDegLat: 24.5262,
} as const;

export const KMONI_MAP_EAST = KMONI_MAP.west + KMONI_MAP.width / KMONI_MAP.pxPerDegLon;
export const KMONI_MAP_SOUTH = KMONI_MAP.north - KMONI_MAP.height / KMONI_MAP.pxPerDegLat;

/**
 * 南西諸島インセットの配置。
 * 縮尺は本土と同じで、平行移動だけで一致する (較正で scale=0.997、実質 1.0)。
 */
export const KMONI_INSET = {
  offsetX: 124.585,
  offsetY: -345.334,
  /** インセットとして描かれる範囲 (この外は本土側の変換に従う) */
  maxLon: 130.0,
  maxLat: 30.6,
} as const;

/** 南西諸島インセットに描かれる位置か */
export function isInsetLocation(lat: number, lon: number): boolean {
  return lat < KMONI_INSET.maxLat && lon < KMONI_INSET.maxLon;
}

/** 本土・インセットを自動で判別してピクセル座標にする */
export function projectToPixel(lat: number, lon: number): Point {
  const base = latLonToPixel(lat, lon);
  if (!isInsetLocation(lat, lon)) return base;
  return { x: base.x + KMONI_INSET.offsetX, y: base.y + KMONI_INSET.offsetY };
}

export interface Point {
  x: number;
  y: number;
}

/** 緯度経度 → 配信画像のピクセル座標 (画像左上原点、範囲外でも外挿する) */
export function latLonToPixel(lat: number, lon: number): Point {
  return {
    x: (lon - KMONI_MAP.west) * KMONI_MAP.pxPerDegLon,
    y: (KMONI_MAP.north - lat) * KMONI_MAP.pxPerDegLat,
  };
}

/** 配信画像のピクセル座標 → 緯度経度 */
export function pixelToLatLon(x: number, y: number): { lat: number; lon: number } {
  return {
    lon: x / KMONI_MAP.pxPerDegLon + KMONI_MAP.west,
    lat: KMONI_MAP.north - y / KMONI_MAP.pxPerDegLat,
  };
}

/** 配信画像の描画範囲に収まるか */
export function isInsideMap(lat: number, lon: number): boolean {
  const p = latLonToPixel(lat, lon);
  return p.x >= 0 && p.x <= KMONI_MAP.width && p.y >= 0 && p.y <= KMONI_MAP.height;
}

/**
 * 基図左上のインセット (南西諸島の別枠) と重なる領域か。
 * インセット内の観測点は線形変換では正しい位置にならないため、
 * 震央マーカー等を描くときはこの領域を避ける (もしくは枠外表示に切り替える)。
 */
export function isInsetArea(px: Point): boolean {
  return px.x < 190 && px.y < 215;
}

/**
 * 配信画像の左上に焼き込まれている見出し ("Realtime Sindo (Surface)" と時刻) の位置。
 *
 * フル HD へ引き伸ばすとこの文字が画面を占領してしまうため、表示側でこの帯を
 * 描画対象から外せるようにしてある。実測 (2026-08-13) で文字は y=8..34 / x=6..218 に
 * 収まっており、この帯には観測点が 1 点も存在しないので、外しても情報は落ちない。
 * 同じ時刻はアプリのヘッダーに表示している。
 */
export const KMONI_CAPTION_BOX = {
  x: 0,
  y: 0,
  width: 240,
  height: 40,
} as const;

/** 表示の初期中心。利用地 (宮崎県延岡市) を既定とする。 */
export const HOME_LOCATION = {
  name: '宮崎県延岡市',
  lat: 32.582,
  lon: 131.665,
} as const;
