import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectToPixel, unprojectFromPixel } from '../dist/index.js';

/**
 * 較正の回帰テスト (2026-09-02 再較正)。
 *
 * 防災科研の公式観測点リスト (K-NET/KiK-net) の緯度経度と、配信画像から実測した
 * 中心画素の対応。孤立していて隣の観測点と取り違えようがない 6 点を選んである
 * (与論のみ南西諸島インセット側)。
 */
const FIXTURES = [
  { name: 'K-NET NGS020 上対馬', lat: 34.6551, lon: 129.4591, x: 17.47, y: 284.82, pixel: [17, 284], inset: false },
  { name: 'K-NET TKY010 新島', lat: 34.3779, lon: 139.2573, x: 216.89, y: 291.62, pixel: [216, 291], inset: false },
  { name: 'K-NET NGS023 郷ノ浦', lat: 33.75, lon: 129.691, x: 22.18, y: 307.04, pixel: [22, 307], inset: false },
  { name: 'K-NET TKY012 八丈', lat: 33.1195, lon: 139.7986, x: 227.91, y: 322.51, pixel: [227, 322], inset: false },
  { name: 'K-NET NGS016 若松', lat: 32.8876, lon: 129.0213, x: 8.55, y: 328.2, pixel: [8, 328], inset: false },
  {
    name: 'K-NET KGS035 与論 (南西諸島インセット)',
    lat: 27.0522,
    lon: 128.4241,
    x: 120.15,
    y: 122.42,
    pixel: [120, 122],
    inset: true,
  },
];

describe('kmoni 座標系の較正 (2026-09-02 観測点リスト対応による再推定)', () => {
  FIXTURES.forEach((fixture) => {
    it(`${fixture.name}: projectToPixel が実測値と 0.05px 以内で一致する`, () => {
      const p = projectToPixel(fixture.lat, fixture.lon);
      assert.ok(
        Math.abs(p.x - fixture.x) < 0.05,
        `x: got ${p.x}, expected ${fixture.x}`,
      );
      assert.ok(
        Math.abs(p.y - fixture.y) < 0.05,
        `y: got ${p.y}, expected ${fixture.y}`,
      );
    });

    it(`${fixture.name}: floor(x)/floor(y) が画像上の中心画素と一致する (丸め規則の回帰)`, () => {
      const p = projectToPixel(fixture.lat, fixture.lon);
      assert.equal(Math.floor(p.x), fixture.pixel[0]);
      assert.equal(Math.floor(p.y), fixture.pixel[1]);
    });

    it(`${fixture.name}: unprojectFromPixel で往復して元の緯度経度に戻る`, () => {
      const p = projectToPixel(fixture.lat, fixture.lon);
      const back = unprojectFromPixel(p.x, p.y, { inset: fixture.inset });
      assert.ok(Math.abs(back.lat - fixture.lat) < 1e-9, `lat: got ${back.lat}`);
      assert.ok(Math.abs(back.lon - fixture.lon) < 1e-9, `lon: got ${back.lon}`);
    });
  });
});
