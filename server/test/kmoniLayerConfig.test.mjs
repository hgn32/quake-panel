import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';

describe('KMONI_LAYER', () => {
  it('既定はリアルタイム震度', () => {
    assert.equal(loadConfig({}).kmoni.layer, 'jma');
  });

  it('環境変数で切り替えられる', () => {
    assert.equal(loadConfig({ KMONI_LAYER: 'acmap' }).kmoni.layer, 'acmap');
    assert.equal(loadConfig({ KMONI_LAYER: 'vcmap' }).kmoni.layer, 'vcmap');
  });

  it('知らない値・空文字は既定へ落とす (起動を止めない)', () => {
    assert.equal(loadConfig({ KMONI_LAYER: 'rsp0125' }).kmoni.layer, 'jma');
    assert.equal(loadConfig({ KMONI_LAYER: '' }).kmoni.layer, 'jma');
    assert.equal(loadConfig({ KMONI_LAYER: 'jma_b' }).kmoni.layer, 'jma');
  });
});
