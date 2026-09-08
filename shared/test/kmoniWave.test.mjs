import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureWaveRadii } from '../dist/index.js';

/**
 * 合成した画素バッファで `measureWaveRadii` を検証する。
 * 実運用では中央値のズレは 0.4px 程度に収まる想定 (課題文の実測値) なので、
 * ここでも ±0.6px 以内を合格ラインにしている。
 */

function makeBuffer(width, height) {
  return new Uint8ClampedArray(width * height * 4);
}

function setPixel(pixels, width, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= width || y * width + x < 0) return;
  const index = (y * width + x) * 4;
  pixels[index] = r;
  pixels[index + 1] = g;
  pixels[index + 2] = b;
  pixels[index + 3] = a;
}

/**
 * 中心 (cx, cy)・半径 r の円周上に色を置く (1 度刻み)。
 * 画素 x は連続座標の [x, x+1) を表す (中心は x+0.5) ので、連続座標を
 * `Math.floor` で画素番号に落とす (`measureWaveRadii` 側の +0.5 と対になる)。
 */
function drawCircle(pixels, width, height, cx, cy, r, color) {
  Array.from({ length: 360 }).forEach((_, deg) => {
    const rad = (deg * Math.PI) / 180;
    const x = Math.floor(cx + r * Math.cos(rad));
    const y = Math.floor(cy + r * Math.sin(rad));
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    setPixel(pixels, width, x, y, color);
  });
}

/** 震央マーカーの焼き込み (中心から ±5px の対角線の赤い X)。 */
function drawEpicenterMark(pixels, width, height, cx, cy) {
  for (let d = -5; d <= 5; d += 1) {
    const x1 = Math.floor(cx + d);
    const y1 = Math.floor(cy + d);
    setPixel(pixels, width, x1, y1, [255, 0, 0, 255]);
    const x2 = Math.floor(cx + d);
    const y2 = Math.floor(cy - d);
    setPixel(pixels, width, x2, y2, [255, 0, 0, 255]);
  }
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe('measureWaveRadii (予測円画像から測る半径)', () => {
  it('赤 (S波) の半径 20、青 (P波) の半径 35 の円から、それぞれの半径を ±0.6px 以内で測れる', () => {
    const width = 100;
    const height = 100;
    const center = { x: 50, y: 50 };
    const pixels = makeBuffer(width, height);
    drawCircle(pixels, width, height, center.x, center.y, 20, RED);
    drawCircle(pixels, width, height, center.x, center.y, 35, BLUE);

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.notEqual(radii.s, null);
    assert.notEqual(radii.p, null);
    assert.ok(Math.abs((radii.s ?? 0) - 20) < 0.6, `s: got ${radii.s}`);
    assert.ok(Math.abs((radii.p ?? 0) - 35) < 0.6, `p: got ${radii.p}`);
  });

  it('焼き込みの震央マーカー (赤い X) が混ざっても中央値なら S 波の半径は変わらない', () => {
    const width = 100;
    const height = 100;
    const center = { x: 50, y: 50 };
    const pixels = makeBuffer(width, height);
    drawCircle(pixels, width, height, center.x, center.y, 20, RED);
    drawCircle(pixels, width, height, center.x, center.y, 35, BLUE);
    drawEpicenterMark(pixels, width, height, center.x, center.y);

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.ok(Math.abs((radii.s ?? 0) - 20) < 0.6, `s: got ${radii.s}`);
    assert.ok(Math.abs((radii.p ?? 0) - 35) < 0.6, `p: got ${radii.p}`);
  });

  it('円が画像の端で切れていても (中心を隅に置く) 半径が正しく測れる', () => {
    const width = 100;
    const height = 100;
    const center = { x: 5, y: 5 };
    const pixels = makeBuffer(width, height);
    drawCircle(pixels, width, height, center.x, center.y, 40, RED);

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.ok(Math.abs((radii.s ?? 0) - 40) < 0.6, `s: got ${radii.s}`);
    assert.equal(radii.p, null);
  });

  it('赤も青も無ければ両方 null になる', () => {
    const width = 50;
    const height = 50;
    const pixels = makeBuffer(width, height);

    const radii = measureWaveRadii(pixels, width, height, { x: 25, y: 25 });
    assert.equal(radii.p, null);
    assert.equal(radii.s, null);
  });

  it('赤だけの画像では p が null になる', () => {
    const width = 100;
    const height = 100;
    const center = { x: 50, y: 50 };
    const pixels = makeBuffer(width, height);
    drawCircle(pixels, width, height, center.x, center.y, 30, RED);

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.notEqual(radii.s, null);
    assert.equal(radii.p, null);
  });

  it('青だけの画像では s が null になる', () => {
    const width = 100;
    const height = 100;
    const center = { x: 50, y: 50 };
    const pixels = makeBuffer(width, height);
    drawCircle(pixels, width, height, center.x, center.y, 30, BLUE);

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.notEqual(radii.p, null);
    assert.equal(radii.s, null);
  });

  it('画素数が 20 未満なら null を返す (円周の一部だけしか置かない)', () => {
    const width = 100;
    const height = 100;
    const center = { x: 50, y: 50 };
    const pixels = makeBuffer(width, height);
    // 半径 30 の円のうち先頭 10 度分だけ置く (20 画素未満になるようにする)
    Array.from({ length: 10 }).forEach((_, deg) => {
      const rad = (deg * Math.PI) / 180;
      const x = Math.floor(center.x + 30 * Math.cos(rad));
      const y = Math.floor(center.y + 30 * Math.sin(rad));
      setPixel(pixels, width, x, y, RED);
    });

    const radii = measureWaveRadii(pixels, width, height, center);
    assert.equal(radii.s, null);
  });
});
