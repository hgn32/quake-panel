import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseKmoniEew } from '../dist/sources/kmoniEew.js';

/** 2026-08-13 に実際に返ってきた平常時のレスポンス (docs/kmoni-endpoints.md) */
const QUIET = {
  result: { status: 'success', message: 'データがありません', is_auth: true },
  report_time: '',
  region_code: '',
  request_time: '20260813111003',
  region_name: '',
  longitude: '',
  is_cancel: '',
  depth: '',
  calcintensity: '',
  is_final: '',
  is_training: '',
  latitude: '',
  origin_time: '',
  magunitude: '',
  report_num: '',
  request_hypo_type: 'eew',
  report_id: '',
};

const FORECAST = {
  result: { status: 'success', message: '', is_auth: true },
  report_time: '2026/08/13 11:10:05',
  region_code: '',
  request_time: '20260813111005',
  region_name: '日向灘',
  longitude: '131.9',
  is_cancel: 'false',
  depth: '30km',
  calcintensity: '4',
  is_final: 'false',
  is_training: 'false',
  latitude: '32.3',
  origin_time: '20260813111000',
  magunitude: '5.2',
  report_num: '3',
  request_hypo_type: 'eew',
  report_id: '20260813111000',
  alertflg: '予報',
};

describe('kmoni EEW JSON の解釈', () => {
  it('平常時は発表なしとして扱う (alertflg キー自体が無い)', () => {
    assert.equal(parseKmoniEew(QUIET), null);
  });

  it('予報を読み取る', () => {
    const report = parseKmoniEew(FORECAST);
    assert.ok(report);
    assert.equal(report.alert, 'forecast');
    assert.equal(report.reportNumber, 3);
    assert.equal(report.maxIntensity, 40);
    assert.equal(report.hypocenter.name, '日向灘');
    assert.equal(report.hypocenter.lat, 32.3);
    assert.equal(report.hypocenter.lon, 131.9);
    // "30km" のように単位が付いた値でも数値を取り出せる
    assert.equal(report.hypocenter.depthKm, 30);
    // kmoni 側のキー名は magunitude (綴りはそのまま)
    assert.equal(report.hypocenter.magnitude, 5.2);
    assert.equal(report.originTime.toISOString(), '2026-08-13T02:10:00.000Z');
    assert.equal(report.announcedAt.toISOString(), '2026-08-13T02:10:05.000Z');
    assert.equal(report.isCancel, false);
    assert.equal(report.isTraining, false);
  });

  it('警報とキャンセル報・訓練報を区別する', () => {
    const warning = parseKmoniEew({ ...FORECAST, alertflg: '警報', calcintensity: '5弱' });
    assert.equal(warning.alert, 'warning');
    assert.equal(warning.maxIntensity, 45);

    const cancelled = parseKmoniEew({ ...FORECAST, is_cancel: 'true' });
    assert.equal(cancelled.isCancel, true);

    // 真偽値がそのまま来る場合もある
    const training = parseKmoniEew({ ...FORECAST, is_training: true });
    assert.equal(training.isTraining, true);
  });

  it('未知の alertflg は発表として扱わない', () => {
    assert.equal(parseKmoniEew({ ...FORECAST, alertflg: '' }), null);
    assert.equal(parseKmoniEew({ ...FORECAST, alertflg: 'なにか' }), null);
  });

  it('report_id が無ければ発表として扱わない', () => {
    assert.equal(parseKmoniEew({ ...FORECAST, report_id: '' }), null);
  });
});
