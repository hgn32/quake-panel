/**
 * 強震モニタの表示指標。
 *
 * kmoni は同じ観測網を複数の指標で毎秒配信している。既定はリアルタイム震度で、
 * これは平常時ほぼ真っ青のまま (実測で全国 3〜15 画素) なので、常時表示に向く。
 *
 * 最大加速度は揺れの立ち上がりが 1〜2 秒早い代わりに、交通や機械の振動を拾って
 * **平常時から常に 300〜470 画素が光る** (2026-08-15 の実測)。速さと引き換えに
 * 「いつもざわついている画面」になるため、既定にはしていない。
 */
export type KmoniLayer = 'jma' | 'acmap' | 'vcmap' | 'dcmap';

export const KMONI_LAYERS: readonly KmoniLayer[] = ['jma', 'acmap', 'vcmap', 'dcmap'];

export const DEFAULT_KMONI_LAYER: KmoniLayer = 'jma';

/** 画面に出す名前 */
export const KMONI_LAYER_LABELS: Record<KmoniLayer, string> = {
  jma: 'リアルタイム震度',
  acmap: '最大加速度',
  vcmap: '最大速度',
  dcmap: '最大変位',
};

/** 選ぶときの手がかり (設定画面に出す) */
export const KMONI_LAYER_NOTES: Record<KmoniLayer, string> = {
  jma: '既定。平常時は静かで、震度という馴染みのある尺度',
  acmap: '揺れの検知が 1〜2 秒早い。ただし平常時から全国がざわつく',
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
