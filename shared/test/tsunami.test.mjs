import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    // 県名は部分一致で「宮崎県」「大分県豊後水道沿岸」等をまとめて拾える。
    // 加えて、県名を含まない広域の区 (九州地方東部) も必ず付く。
    // 広域の区は津波警報の第一報で使われるので、落とすと一番肝心なときに印が付かない。
    assert.deepEqual(tsunamiAreasForPrefecture('宮崎県'), ['宮崎県', '九州地方東部']);
    assert.deepEqual(tsunamiAreasForPrefecture('大分県'), [
      '大分県',
      '九州地方東部',
      '大分県瀬戸内海沿岸',
      '大分県豊後水道沿岸',
    ]);
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

describe('津波予報区の網羅性 (気象庁 AreaTsunami コード表との突き合わせ)', () => {
  // 気象庁「地震火山関連コード表」シート31 (津波予報区) の全区名。
  // https://xml.kishou.go.jp/ の個別コード表から起こしたもの。
  const ALL_AREAS = JSON.parse(
    readFileSync(new URL('./jma-tsunami-areas.json', import.meta.url), 'utf8'),
  );
  const PREFECTURES = [
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
    '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
    '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
    '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
  ];

  /** その予報区が「利用地の県から自動」でどの県に拾われるか */
  const pickedBy = (areaName) =>
    PREFECTURES.filter((pref) => {
      const info = {
        id: 't1', issuedAt: null, cancelled: false, affectsHome: false, receivedAt: '',
        areas: [{
          name: areaName, grade: 'Watch', immediate: false, firstHeightCondition: null,
          firstHeightArrivalTime: null, maxHeightDescription: null, maxHeightValue: null,
          isHome: false,
        }],
      };
      return applyHomeAreas(info, tsunamiAreasForPrefecture(pref)).affectsHome;
    });

  it('気象庁の全 98 区を対象にしている', () => {
    assert.equal(ALL_AREAS.length, 98);
  });

  it('どの都道府県を選んでも拾えない予報区が無い', () => {
    const orphans = ALL_AREAS.filter((area) => pickedBy(area).length === 0);
    assert.deepEqual(orphans, [], `拾えない予報区: ${orphans.join(' / ')}`);
  });

  it('広域の予報区 (警報の第一報で使われる) が構成県すべてに届く', () => {
    // 気象庁の備考欄「領域表現（構成する津波予報区…）」から起こした期待値
    assert.deepEqual(pickedBy('東北地方太平洋沿岸'), ['青森県', '岩手県', '宮城県', '福島県']);
    assert.deepEqual(pickedBy('関東地方'), ['茨城県', '千葉県', '東京都', '神奈川県']);
    assert.deepEqual(pickedBy('薩南諸島'), ['鹿児島県']);
    assert.deepEqual(pickedBy('佐渡'), ['新潟県']);
  });

  it('隣県まで巻き込まない (東京湾内湾は 3 都県、相模湾は神奈川県だけ)', () => {
    assert.deepEqual(pickedBy('東京湾内湾'), ['千葉県', '東京都', '神奈川県']);
    assert.deepEqual(pickedBy('相模湾・三浦半島'), ['神奈川県']);
    assert.deepEqual(pickedBy('千葉県九十九里・外房'), ['千葉県']);
  });
});
