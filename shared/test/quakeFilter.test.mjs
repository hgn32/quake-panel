import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_QUAKE_FILTER,
  clampFlashSeconds,
  clampSoundSeconds,
  matchesQuakeFilter,
  parseKmoniLayer,
} from '../dist/index.js';

const quake = (maxIntensity, points) => ({
  id: 'q1',
  issuedAt: null,
  occurredAt: null,
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity,
  domesticTsunami: 'None',
  points,
  receivedAt: '2026-08-15T10:00:00.000Z',
});

const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

describe('地震情報の絞り込み', () => {
  it('既定では何も落とさない', () => {
    assert.equal(matchesQuakeFilter(quake(10, []), DEFAULT_QUAKE_FILTER, '宮崎県'), true);
  });

  it('最大震度のしきい値で落とす', () => {
    const filter = { minIntensity: 30, homePrefectureOnly: false };
    assert.equal(matchesQuakeFilter(quake(20, []), filter, null), false);
    assert.equal(matchesQuakeFilter(quake(30, []), filter, null), true);
    assert.equal(matchesQuakeFilter(quake(45, []), filter, null), true);
  });

  it('しきい値があるとき、震度不明の電文 (震源に関する情報など) は落とす', () => {
    const filter = { minIntensity: 10, homePrefectureOnly: false };
    assert.equal(matchesQuakeFilter(quake(null, []), filter, null), false);
    // しきい値なしなら残る
    assert.equal(matchesQuakeFilter(quake(null, []), DEFAULT_QUAKE_FILTER, null), true);
  });

  it('利用地の県で揺れたものだけに絞れる (台湾付近で沖縄だけ揺れた例)', () => {
    const filter = { minIntensity: 0, homePrefectureOnly: true };
    const taiwan = quake(10, [point('沖縄県', 10)]);
    assert.equal(matchesQuakeFilter(taiwan, filter, '東京都'), false);
    assert.equal(matchesQuakeFilter(taiwan, filter, '沖縄県'), true);
  });

  it('利用地の県が分からないときは県の条件を無視する (出しすぎる方が安全)', () => {
    const filter = { minIntensity: 0, homePrefectureOnly: true };
    assert.equal(matchesQuakeFilter(quake(10, [point('沖縄県', 10)]), filter, null), true);
  });

  it('震度が入っていない観測点は「揺れた」と数えない', () => {
    const filter = { minIntensity: 0, homePrefectureOnly: true };
    assert.equal(matchesQuakeFilter(quake(10, [point('宮崎県', null)]), filter, '宮崎県'), false);
  });

  it('双方向部分一致で誤爆しない (「京都」と「東京都」の回帰テスト)', () => {
    // 旧実装は point.pref.includes(homePrefecture) || homePrefecture.includes(point.pref)
    // という双方向部分一致だったため、利用地「東京都」の設定で「京都府」が揺れた
    // 地震が "東京都".includes("京都") === true で誤って一致していた。
    const filter = { minIntensity: 0, homePrefectureOnly: true };
    const kyoto = quake(10, [point('京都府', 10)]);
    assert.equal(matchesQuakeFilter(kyoto, filter, '東京都'), false);
    assert.equal(matchesQuakeFilter(kyoto, filter, '京都府'), true);
  });
});

describe('強震モニタの指標', () => {
  it('既知の指標だけ受け付ける', () => {
    assert.equal(parseKmoniLayer('jma'), 'jma');
    assert.equal(parseKmoniLayer('acmap'), 'acmap');
    assert.equal(parseKmoniLayer('rsp0125'), null);
    assert.equal(parseKmoniLayer(''), null);
    assert.equal(parseKmoniLayer(undefined), null);
    // 地中 (_b) は地表と同じ地点なので選択肢に無い
    assert.equal(parseKmoniLayer('jma_b'), null);
  });
});

describe('音を鳴らす時間', () => {
  it('範囲外は丸め、0 (鳴らし切る) は保つ', () => {
    assert.equal(clampSoundSeconds(10), 10);
    assert.equal(clampSoundSeconds(0), 0);
    assert.equal(clampSoundSeconds(-3), 0);
    assert.equal(clampSoundSeconds(9999), 120);
    assert.equal(clampSoundSeconds(Number.NaN), 10);
  });
});

describe('明滅を続ける時間', () => {
  it('範囲外は丸め、0 (止めない) は保つ', () => {
    assert.equal(clampFlashSeconds(60), 60);
    assert.equal(clampFlashSeconds(0), 0);
    assert.equal(clampFlashSeconds(-5), 0);
    assert.equal(clampFlashSeconds(99999), 600);
    assert.equal(clampFlashSeconds(Number.NaN), 60);
  });
});
