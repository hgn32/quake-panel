import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyHomeAreas } from '../dist/index.js';

const info = {
  id: 't1',
  issuedAt: null,
  cancelled: false,
  areas: [
    { name: '東京湾内湾', grade: 'Watch', immediate: false, firstHeightCondition: null, firstHeightArrivalTime: null, maxHeightDescription: null, maxHeightValue: null, isHome: false },
    { name: '伊豆諸島', grade: 'Watch', immediate: false, firstHeightCondition: null, firstHeightArrivalTime: null, maxHeightDescription: null, maxHeightValue: null, isHome: false },
  ],
  affectsHome: false,
  receivedAt: '2026-08-13T10:00:00.000Z',
};

describe('津波予報の利用地判定', () => {
  it('設定した予報区に印が付く', () => {
    const marked = applyHomeAreas(info, ['伊豆諸島']);
    assert.equal(marked.areas[0].isHome, false);
    assert.equal(marked.areas[1].isHome, true);
    assert.equal(marked.affectsHome, true);
  });

  it('予報区名が県名でなくても部分一致で拾う', () => {
    // 設定に「東京都」と書いてあっても、予報区名は「東京湾内湾」で来る
    const marked = applyHomeAreas(info, ['東京湾']);
    assert.equal(marked.areas[0].isHome, true);
    assert.equal(marked.affectsHome, true);
  });

  it('設定が空なら何も印を付けない', () => {
    const marked = applyHomeAreas(info, ['   ']);
    assert.equal(marked.affectsHome, false);
    assert.equal(marked.areas.some((a) => a.isHome), false);
  });
});
