/**
 * 強震モニタの表示指標。
 *
 * kmoni は同じ観測網を複数の指標で毎秒配信している。
 *
 * 既定は最大加速度。揺れの立ち上がりが 1〜2 秒早い (実測: 2026-08-15 の熊本 M2.3 で
 * 加速度 18:47:04 / リアルタイム震度 18:47:05〜06)。ただし交通や機械の振動を拾うため
 * **平常時から常に 300〜470 画素が光る** (リアルタイム震度は 3〜15 画素)。
 * 静かな画面が好みなら設定でリアルタイム震度に戻せる。
 */
export type KmoniLayer = 'jma' | 'acmap' | 'vcmap' | 'dcmap';

export const KMONI_LAYERS: readonly KmoniLayer[] = ['jma', 'acmap', 'vcmap', 'dcmap'];

/**
 * 既定の指標。
 *
 * 揺れの立ち上がりが 1〜2 秒早い最大加速度を既定にしている (2026-08-15 実測)。
 * その代わり平常時から交通や機械の振動を拾って全国がざわつくので、
 * 静かな画面が好みなら設定で「リアルタイム震度」に戻せる。
 */
export const DEFAULT_KMONI_LAYER: KmoniLayer = 'acmap';

/** 画面に出す名前 */
export const KMONI_LAYER_LABELS: Record<KmoniLayer, string> = {
  jma: 'リアルタイム震度',
  acmap: '最大加速度',
  vcmap: '最大速度',
  dcmap: '最大変位',
};

/** 選ぶときの手がかり (設定画面に出す) */
export const KMONI_LAYER_NOTES: Record<KmoniLayer, string> = {
  jma: '平常時は静かで、震度という馴染みのある尺度',
  acmap: '既定。揺れの検知が 1〜2 秒早い。ただし平常時から全国がざわつく',
  vcmap: '震度と加速度の中間。平常時は比較的静か',
  dcmap: '長周期成分。揺れの検知は明らかに遅い (実測で 30 秒以上)',
};

/** kmoni の画像パスに使う名前 (地表のみ扱う。地中は地表と同じ地点なので採らない) */
export function kmoniLayerPath(layer: KmoniLayer): string {
  return `${layer}_s`;
}

export function parseKmoniLayer(value: string | null | undefined): KmoniLayer | null {
  const found = KMONI_LAYERS.find((layer) => layer === value);
  return found ?? null;
}
