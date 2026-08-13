import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyHomeAreas, tsunamiAreasForPrefecture } from '../dist/index.js';

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

describe('都道府県から津波予報区を決める', () => {
  it('県名がそのまま予報区名になる県', () => {
    assert.deepEqual(tsunamiAreasForPrefecture('宮崎県'), ['宮崎県']);
    // 「大分県豊後水道沿岸」等は県名を含むので部分一致で拾える
    assert.deepEqual(tsunamiAreasForPrefecture('大分県'), ['大分県']);
  });

  it('県名を含まない予報区がある県は補う', () => {
    const tokyo = tsunamiAreasForPrefecture('東京都');
    assert.ok(tokyo.includes('東京湾内湾'));
    assert.ok(tokyo.includes('伊豆諸島'));
    assert.ok(tsunamiAreasForPrefecture('熊本県').includes('有明・八代海'));
    assert.ok(tsunamiAreasForPrefecture('沖縄県').includes('宮古島・八重山地方'));
  });

  it('利用地の県が分からなければ空', () => {
    assert.deepEqual(tsunamiAreasForPrefecture(null), []);
  });

  it('自動で決めた予報区で実際に印が付く', () => {
    const areas = tsunamiAreasForPrefecture('東京都');
    const marked = applyHomeAreas(info, areas);
    assert.equal(marked.areas[0].isHome, true); // 東京湾内湾
    assert.equal(marked.areas[1].isHome, true); // 伊豆諸島
  });
});
