import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyHomeAreas,
  tsunamiAreasForPrefecture,
  tsunamiAlertRank,
  tsunamiGradeRank,
} from '../dist/index.js';

const baseArea = {
  grade: 'Watch',
  immediate: false,
  firstHeightCondition: null,
  firstHeightArrivalTime: null,
  maxHeightDescription: null,
  maxHeightValue: null,
  isHome: false,
};

const makeInfo = (areas, overrides = {}) => ({
  id: 't1',
  issuedAt: null,
  cancelled: false,
  areas,
  affectsHome: false,
  receivedAt: '2026-08-13T10:00:00.000Z',
  ...overrides,
});

const info = makeInfo([
  { ...baseArea, name: '東京湾内湾' },
  { ...baseArea, name: '伊豆諸島' },
]);

describe('津波予報の利用地判定 (完全一致)', () => {
  it('設定した予報区に印が付く', () => {
    const marked = applyHomeAreas(info, ['伊豆諸島']);
    assert.equal(marked.areas[0].isHome, false);
    assert.equal(marked.areas[1].isHome, true);
    assert.equal(marked.affectsHome, true);
  });

  it('展開済みの予報区名で拾える', () => {
    // 設定側の県名は tsunamiAreasForPrefecture() で予報区名へ展開してから渡す前提。
    const areas = tsunamiAreasForPrefecture('東京都');
    const marked = applyHomeAreas(info, areas);
    assert.equal(marked.areas[0].isHome, true); // 東京湾内湾
    assert.equal(marked.areas[1].isHome, true); // 伊豆諸島
    assert.equal(marked.affectsHome, true);
  });

  it('部分文字列では一致しない (旧仕様からの回帰テスト)', () => {
    // 旧実装は area.name.includes(target) || target.includes(area.name) の
    // 双方向部分一致だったため、「東京湾」だけの設定でも「東京湾内湾」に一致していた。
    const marked = applyHomeAreas(info, ['東京湾']);
    assert.equal(marked.areas[0].isHome, false);
    assert.equal(marked.affectsHome, false);
  });

  it('広域の区名と紛らわしい部分文字列でも誤爆しない (瀬戸内海沿岸の拾いすぎ回帰)', () => {
    // 旧実装だと大分県瀬戸内海沿岸を持つ info に「瀬戸内海沿岸」の設定が
    // target.includes(area.name) 側で一致してしまっていた。
    const oitaInfo = makeInfo([{ ...baseArea, name: '大分県瀬戸内海沿岸' }]);
    const marked = applyHomeAreas(oitaInfo, ['瀬戸内海沿岸']);
    assert.equal(marked.areas[0].isHome, false);
    assert.equal(marked.affectsHome, false);
  });

  it('設定が空・空白のみなら何も印を付けない', () => {
    const marked = applyHomeAreas(info, ['   ', '']);
    assert.equal(marked.affectsHome, false);
    assert.equal(marked.areas.some((a) => a.isHome), false);
  });
});

describe('都道府県から津波予報区を決める', () => {
  it('県名がそのまま予報区名になる県 + 広域の区', () => {
    assert.deepEqual(tsunamiAreasForPrefecture('宮崎県'), ['宮崎県', '九州地方東部']);
  });

  it('東京都は湾・諸島の区に加えて、県境をまたぐ千葉県・神奈川県も含む', () => {
    const tokyo = tsunamiAreasForPrefecture('東京都');
    assert.ok(tokyo.includes('東京湾内湾'));
    assert.ok(tokyo.includes('伊豆諸島'));
    assert.ok(tokyo.includes('関東地方'));
    assert.ok(tokyo.includes('千葉県'));
    assert.ok(tokyo.includes('神奈川県'));
  });

  it('利用地の県が分からなければ空', () => {
    assert.deepEqual(tsunamiAreasForPrefecture(null), []);
  });

  it('「大分県瀬戸内海沿岸」は大分県だけに関わる (大阪府では affectsHome にならない)', () => {
    const oitaInfo = makeInfo([{ ...baseArea, name: '大分県瀬戸内海沿岸' }]);
    assert.equal(applyHomeAreas(oitaInfo, tsunamiAreasForPrefecture('大分県')).affectsHome, true);
    assert.equal(applyHomeAreas(oitaInfo, tsunamiAreasForPrefecture('大阪府')).affectsHome, false);
  });

  it('「千葉県」の発表で東京都に印が付く (旧実装の取りこぼしの回帰テスト)', () => {
    // 「千葉県」(結合表現 481 = 310,311,312) は東京湾内湾 (312) を含むため、
    // 東京都にも関わる。基本区に分解されず結合表現のまま発表されることがある。
    const chibaInfo = makeInfo([{ ...baseArea, name: '千葉県' }]);
    assert.equal(applyHomeAreas(chibaInfo, tsunamiAreasForPrefecture('東京都')).affectsHome, true);
  });
});

describe('津波予報区の網羅性と正確性 (気象庁 AreaTsunami コード表との突き合わせ)', () => {
  // 気象庁「地震火山関連コード表」シート31 (津波予報区) の全区。
  // https://xml.kishou.go.jp/ の個別コード表から起こしたもの。
  // note の「領域表現（構成する津波予報区…）」「結合表現（構成する津波予報区…）」が
  // その区を構成する基本区を明記しているので、期待される「区→関係する県」の対応は
  // 手で決めずにこの構成情報から機械的に導出できる。
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

  // 名前から県を決められない基本区 (湾・諸島の 7 区) だけ人手で対応付ける。
  const MANUAL = {
    'オホーツク海沿岸': ['北海道'],
    '東京湾内湾': ['東京都'],
    '伊豆諸島': ['東京都'],
    '小笠原諸島': ['東京都'],
    '沖縄本島地方': ['沖縄県'],
    '大東島地方': ['沖縄県'],
    '宮古島・八重山地方': ['沖縄県'],
  };

  /** note の「構成する津波予報区…」から構成コードの配列を取り出す (無ければ null = 基本区) */
  const constituents = (note) => {
    const m = /構成する津波予報区([0-9,]+)/.exec(note);
    return m ? m[1].split(',').map(Number) : null;
  };

  /** 期待される「区名→関係する県の集合」を機械的に導出する */
  const buildExpected = () => {
    // ① 構成の無い基本区の期待県集合: 47 都道府県のうち name に含まれるもの + MANUAL 分。
    const basicSets = new Map();
    ALL_AREAS.filter((area) => constituents(area.note) === null).forEach((area) => {
      const set = new Set(PREFECTURES.filter((pref) => area.name.includes(pref)));
      (MANUAL[area.name] ?? []).forEach((pref) => set.add(pref));
      basicSets.set(area.code, set);
    });

    // ② 結合表現 (name が県名そのもの) は、その県を構成する基本区すべてにも追加する。
    // 例:「千葉県」(481) は 310,311,312 の結合表現なので、東京湾内湾 (312) の
    // 県集合に千葉県を足す。これで東京湾内湾の県集合が {東京都,千葉県,神奈川県} になる。
    ALL_AREAS.filter((area) => PREFECTURES.includes(area.name) && constituents(area.note) !== null).forEach(
      (area) => {
        constituents(area.note).forEach((code) => {
          basicSets.get(code)?.add(area.name);
        });
      },
    );

    // ③ 各区の期待県集合: 基本区は自身の集合、構成のある区 (結合表現・領域表現) は
    // 構成する基本区の集合の和。
    const expected = new Map();
    ALL_AREAS.forEach((area) => {
      const codes = constituents(area.note);
      if (codes === null) {
        expected.set(area.name, new Set(basicSets.get(area.code)));
        return;
      }
      const union = new Set();
      codes.forEach((code) => {
        basicSets.get(code)?.forEach((pref) => union.add(pref));
      });
      expected.set(area.name, union);
    });
    return expected;
  };

  const expected = buildExpected();

  /** その予報区が「利用地の県から自動で決めた予報区一覧」でどの県に拾われるか */
  const pickedBy = (areaName) =>
    new Set(
      PREFECTURES.filter((pref) => {
        const single = makeInfo([{ ...baseArea, name: areaName }]);
        return applyHomeAreas(single, tsunamiAreasForPrefecture(pref)).affectsHome;
      }),
    );

  it('気象庁の全 98 区を対象にしている', () => {
    assert.equal(ALL_AREAS.length, 98);
  });

  it('導出した期待県集合が空の区は無い', () => {
    const orphans = [...expected.entries()].filter(([, set]) => set.size === 0).map(([name]) => name);
    assert.deepEqual(orphans, [], `県が決められない区: ${orphans.join(' / ')}`);
  });

  it('全 98 区 × 47 都道府県で、取りこぼしも拾いすぎも無い', () => {
    // 導出した期待値 (expected) と、実装の tsunamiAreasForPrefecture + applyHomeAreas を
    // 突き合わせる。改修前 (双方向部分一致 + 旧テーブル) だと、ここで
    // 拾いすぎ 34 件・取りこぼし 18 件が検出される。
    const mismatches = [];
    ALL_AREAS.forEach((area) => {
      const expectedPrefs = expected.get(area.name);
      const actualPrefs = pickedBy(area.name);
      PREFECTURES.forEach((pref) => {
        const inExpected = expectedPrefs.has(pref);
        const inActual = actualPrefs.has(pref);
        if (inExpected && !inActual) mismatches.push(`取りこぼし: ${area.name} / ${pref}`);
        if (!inExpected && inActual) mismatches.push(`拾いすぎ: ${area.name} / ${pref}`);
      });
    });
    assert.deepEqual(mismatches, []);
  });
});

describe('tsunamiGradeRank', () => {
  it('MajorWarning が最も重く、Unknown (津波予報) が最も軽い', () => {
    assert.equal(tsunamiGradeRank('MajorWarning'), 4);
    assert.equal(tsunamiGradeRank('Warning'), 3);
    assert.equal(tsunamiGradeRank('Watch'), 2);
    assert.equal(tsunamiGradeRank('Unknown'), 1);
  });
});

describe('tsunamiAlertRank', () => {
  const miyazakiAreas = tsunamiAreasForPrefecture('宮崎県');

  it('自分の区が対象外なら 0', () => {
    const okinawaOnly = makeInfo([{ ...baseArea, name: '沖縄本島地方', grade: 'Watch' }]);
    assert.equal(tsunamiAlertRank(okinawaOnly, 'watch', false), 0);
  });

  it('自分の区を含む警報は、下限 watch でランク 3 を返す', () => {
    const warning = makeInfo([{ ...baseArea, name: '宮崎県', grade: 'Warning', isHome: true }]);
    assert.equal(tsunamiAlertRank(warning, 'watch', false), 3);
  });

  it('自分の区が注意報でも、下限が warning なら 0', () => {
    const watch = makeInfo([{ ...baseArea, name: '宮崎県', grade: 'Watch', isHome: true }]);
    assert.equal(tsunamiAlertRank(watch, 'warning', false), 0);
  });

  it('min が none なら、どこかに大津波警報があっても常に 0', () => {
    const major = makeInfo([{ ...baseArea, name: '宮崎県', grade: 'MajorWarning', isHome: true }]);
    assert.equal(tsunamiAlertRank(major, 'none', true), 0);
  });

  it('nationalMajor: 自分の区が対象外でも、どこかに大津波警報があればランク 4', () => {
    const hokkaidoMajor = makeInfo([{ ...baseArea, name: '北海道太平洋沿岸東部', grade: 'MajorWarning' }]);
    assert.equal(tsunamiAlertRank(hokkaidoMajor, 'watch', true), 4);
    assert.equal(tsunamiAlertRank(hokkaidoMajor, 'watch', false), 0);
  });

  it('解除は常に 0', () => {
    const cancelled = makeInfo(
      [{ ...baseArea, name: '宮崎県', grade: 'MajorWarning', isHome: true }],
      { cancelled: true },
    );
    assert.equal(tsunamiAlertRank(cancelled, 'watch', true), 0);
  });

  it('区が無い予報は 0', () => {
    const empty = makeInfo([]);
    assert.equal(tsunamiAlertRank(empty, 'forecast', false), 0);
  });

  it('info が null なら 0', () => {
    assert.equal(tsunamiAlertRank(null, 'forecast', true), 0);
  });

  it('参考: 展開済みの宮崎県の区 (九州地方東部含む) で警報が来ればランク 3', () => {
    const info = makeInfo(
      miyazakiAreas.map((name) => ({ ...baseArea, name, grade: 'Warning' })),
    );
    const marked = applyHomeAreas(info, miyazakiAreas);
    assert.equal(tsunamiAlertRank(marked, 'watch', false), 3);
  });
});
