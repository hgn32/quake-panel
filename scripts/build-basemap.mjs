#!/usr/bin/env node
/**
 * 自前のダークテーマ地図データを作る。
 *
 * 強震モニタの配信画像は観測点シンボルの透過オーバーレイなので、その下に敷く
 * 背景地図を差し替えるだけで見た目は大きく変わる (§5)。画像そのものには一切
 * 手を加えないため、規約上の「改変」には当たらない。
 *
 * 出力は kmoni 配信画像のピクセル座標系 (352x400) に投影済みの多角形。
 * クライアントは変換せずそのまま Canvas へ描ける。
 *
 *   node scripts/build-basemap.mjs [--source <geojson の URL かパス>] [--out <出力先>]
 *
 * 事前に `npm run build -w @quake-panel/shared` を実行しておくこと
 * (投影パラメータを shared から取り込むため)。
 *
 * データ出典: 「国土数値情報(行政区域データ)」(国土交通省) を加工して作成。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KMONI_INSET, KMONI_MAP, isInsetLocation, latLonToPixel } from '../shared/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson';
const DEFAULT_OUT = resolve(ROOT, 'client/public/assets/japan-map.json');

/** 単純化の許容誤差 (配信画像の 1px 単位)。拡大表示に耐えるよう控えめにする。 */
const TOLERANCE_PX = 0.15;
/** これより小さい島は描いても見えないので落とす (px^2) */
const MIN_AREA_PX2 = 1.2;

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--source' && value) args.source = value;
    else if (key === '--out' && value) args.out = resolve(value);
  }
  return args;
}

async function loadGeoJson(source) {
  if (/^https?:\/\//.test(source)) {
    process.stderr.write(`downloading ${source}\n`);
    const res = await fetch(source);
    if (!res.ok) throw new Error(`GeoJSON の取得に失敗しました: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(resolve(source), 'utf8'));
}

/** Douglas-Peucker。閉じたリングは端点を固定したまま間引く。 */
function simplify(points, tolerance) {
  if (points.length <= 3) return points;
  const sqTolerance = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxSqDist = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx;
      const qy = ay + t * dy;
      const sqDist = (px - qx) ** 2 + (py - qy) ** 2;
      if (sqDist > maxSqDist) {
        maxSqDist = sqDist;
        index = i;
      }
    }
    if (index !== -1 && maxSqDist > sqTolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function ringArea(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(sum) / 2;
}

/**
 * リング全体をどちらの座標系に載せるか、重心で決める。
 * 点ごとに切り替えると、境界をまたぐリングが裂けてしまう。
 */
function projectRing(ring) {
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  const inset = isInsetLocation(sumLat / ring.length, sumLon / ring.length);
  return ring.map(([lon, lat]) => {
    const p = latLonToPixel(lat, lon);
    return inset ? [p.x + KMONI_INSET.offsetX, p.y + KMONI_INSET.offsetY] : [p.x, p.y];
  });
}

function withinCanvas(points) {
  const margin = 24;
  return points.some(
    ([x, y]) =>
      x > -margin && x < KMONI_MAP.width + margin && y > -margin && y < KMONI_MAP.height + margin,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const geo = await loadGeoJson(args.source);

  const prefectures = [];
  let ringCount = 0;
  let pointCount = 0;

  for (const feature of geo.features) {
    const name = feature.properties.nam_ja ?? feature.properties.nam ?? '';
    const code = feature.properties.id ?? null;
    const geometry = feature.geometry;
    const polygons =
      geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];

    const rings = [];
    for (const polygon of polygons) {
      // 穴 (polygon[1..]) は湖沼で、この縮尺では描いても潰れるので外周だけ使う
      const projected = projectRing(polygon[0]);
      if (!withinCanvas(projected)) continue;
      if (ringArea(projected) < MIN_AREA_PX2) continue;
      const reduced = simplify(projected, TOLERANCE_PX);
      if (reduced.length < 3) continue;
      // 座標は 0.01px 刻みで十分。JSON を小さく保つ。
      const flat = new Array(reduced.length * 2);
      for (let i = 0; i < reduced.length; i += 1) {
        flat[i * 2] = Math.round(reduced[i][0] * 100) / 100;
        flat[i * 2 + 1] = Math.round(reduced[i][1] * 100) / 100;
      }
      rings.push(flat);
      ringCount += 1;
      pointCount += reduced.length;
    }
    if (rings.length > 0) prefectures.push({ code, name, rings });
  }

  prefectures.sort((a, b) => (a.code ?? 0) - (b.code ?? 0));

  const output = {
    attribution: '「国土数値情報(行政区域データ)」(国土交通省) を加工して作成',
    projection: {
      width: KMONI_MAP.width,
      height: KMONI_MAP.height,
      west: KMONI_MAP.west,
      north: KMONI_MAP.north,
      pxPerDegLon: KMONI_MAP.pxPerDegLon,
      pxPerDegLat: KMONI_MAP.pxPerDegLat,
      inset: { offsetX: KMONI_INSET.offsetX, offsetY: KMONI_INSET.offsetY },
    },
    tolerancePx: TOLERANCE_PX,
    prefectures,
  };

  await mkdir(dirname(args.out), { recursive: true });
  const json = JSON.stringify(output);
  await writeFile(args.out, json);
  process.stderr.write(
    `wrote ${args.out}: ${prefectures.length} prefectures, ${ringCount} rings, ` +
      `${pointCount} points, ${(json.length / 1024).toFixed(0)} KiB\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
