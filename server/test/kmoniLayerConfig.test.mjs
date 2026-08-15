import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';

describe('KMONI_LAYER', () => {
  it('既定は最大加速度 (揺れの検知が 1〜2 秒早い)', () => {
    assert.equal(loadConfig({}).kmoni.layer, 'acmap');
  });

  it('環境変数で切り替えられる', () => {
    assert.equal(loadConfig({ KMONI_LAYER: 'jma' }).kmoni.layer, 'jma');
    assert.equal(loadConfig({ KMONI_LAYER: 'vcmap' }).kmoni.layer, 'vcmap');
  });

  it('知らない値・空文字は既定へ落とす (起動を止めない)', () => {
    assert.equal(loadConfig({ KMONI_LAYER: 'rsp0125' }).kmoni.layer, 'acmap');
    assert.equal(loadConfig({ KMONI_LAYER: '' }).kmoni.layer, 'acmap');
    assert.equal(loadConfig({ KMONI_LAYER: 'jma_b' }).kmoni.layer, 'acmap');
  });
});
