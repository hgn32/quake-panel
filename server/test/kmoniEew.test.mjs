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

  /** 2026-07-29 22:19 の熊本の警報級 EEW について、発表時に実際に返ってきたレスポンス (実測、一字も変えていない) */
  const REAL_KUMAMOTO_WARNING = {
    result: { status: 'success', message: '', is_auth: true },
    report_time: '2026/07/29 22:19:44',
    region_code: '',
    request_time: '202607292219%s',
    region_name: '熊本県天草・芦北地方',
    longitude: '130.5',
    is_cancel: false,
    depth: '10km',
    calcintensity: '5弱',
    is_final: false,
    is_training: false,
    latitude: '32.4',
    origin_time: '20260729221936',
    security: {
      realm: '/kyoshin_monitor/static/jsondata/eew_est/',
      hash: 'b61e4d95a8c42e004665825c098a6de4',
    },
    magunitude: '4.5',
    report_num: '5',
    report_id: '20260729221939',
    alertflg: '警報',
  };

  it('発表時の実レスポンス (2026-07-29 熊本、実測) をそのまま読める', () => {
    const report = parseKmoniEew(REAL_KUMAMOTO_WARNING);
    assert.ok(report);
    // P2P 556 実電文の issue.eventId ('20260729221939') と完全一致する。
    // kmoni と P2P の同一地震統合はこの ID 一致で成立している。
    assert.equal(report.id, '20260729221939');
    assert.equal(report.alert, 'warning');
    assert.equal(report.reportNumber, 5);
    assert.equal(report.isCancel, false);
    assert.equal(report.isFinal, false);
    assert.equal(report.isTraining, false);
    assert.equal(report.hypocenter.name, '熊本県天草・芦北地方');
    assert.equal(report.hypocenter.lat, 32.4);
    assert.equal(report.hypocenter.lon, 130.5);
    assert.equal(report.hypocenter.depthKm, 10);
    assert.equal(report.hypocenter.magnitude, 4.5);
    assert.equal(report.maxIntensity, 45);
    assert.equal(report.originTime.toISOString(), '2026-07-29T13:19:36.000Z');
    assert.equal(report.announcedAt.toISOString(), '2026-07-29T13:19:44.000Z');
  });

  /** 2026-08-17 06:37 の福岡県福岡地方 M3.6 の予報について、実際に返ってきたレスポンス (実測、一字も変えていない) */
  const REAL_FUKUOKA_FORECAST = {
    result: { status: 'success', message: '', is_auth: true },
    report_time: '2026/08/17 06:37:26',
    region_code: '',
    request_time: '202608170637%s',
    region_name: '福岡県福岡地方',
    longitude: '130.2',
    is_cancel: false,
    depth: '10km',
    calcintensity: '3',
    is_final: false,
    is_training: false,
    latitude: '33.5',
    origin_time: '20260817063719',
    security: {
      realm: '/kyoshin_monitor/static/jsondata/eew_est/',
      hash: 'b61e4d95a8c42e004665825c098a6de4',
    },
    magunitude: '3.6',
    report_num: '1',
    report_id: '20260817063722',
    alertflg: '予報',
  };

  it('発表時の実レスポンス (2026-08-17 福岡県福岡地方、実測) をそのまま読める', () => {
    const report = parseKmoniEew(REAL_FUKUOKA_FORECAST);
    assert.ok(report);
    assert.equal(report.alert, 'forecast');
    assert.equal(report.id, '20260817063722');
    assert.equal(report.reportNumber, 1);
    assert.equal(report.maxIntensity, 30);
    assert.equal(report.hypocenter.name, '福岡県福岡地方');
    assert.equal(report.hypocenter.lat, 33.5);
    assert.equal(report.hypocenter.lon, 130.2);
    assert.equal(report.hypocenter.depthKm, 10);
    assert.equal(report.hypocenter.magnitude, 3.6);
    assert.equal(report.isCancel, false);
    assert.equal(report.isFinal, false);
    assert.equal(report.isTraining, false);
    assert.equal(report.originTime.toISOString(), '2026-08-16T21:37:19.000Z');
  });

  describe('キャンセル報 (実物の観測例が無いため、あり得る形をすべて受け入れる)', () => {
    it('alertflg が維持されたまま is_cancel が立つ形', () => {
      const cancelled = parseKmoniEew({ ...REAL_KUMAMOTO_WARNING, is_cancel: true });
      assert.ok(cancelled);
      assert.equal(cancelled.isCancel, true);
      assert.equal(cancelled.alert, 'warning');
    });

    it('alertflg が無く (undefined) is_cancel だけが立つ形', () => {
      const { alertflg, ...withoutFlag } = REAL_KUMAMOTO_WARNING;
      const cancelled = parseKmoniEew({ ...withoutFlag, is_cancel: true });
      assert.ok(cancelled);
      assert.equal(cancelled.isCancel, true);
    });

    it('alertflg が「キャンセル」という値になり is_cancel が文字列 "true" で来る形', () => {
      const cancelled = parseKmoniEew({
        ...REAL_KUMAMOTO_WARNING,
        alertflg: 'キャンセル',
        is_cancel: 'true',
      });
      assert.ok(cancelled);
      assert.equal(cancelled.isCancel, true);
    });

    it('平常時 (alertflg 無し・is_cancel が空文字/false) は発表として扱わない', () => {
      assert.equal(parseKmoniEew(QUIET), null);
      assert.equal(parseKmoniEew({ ...QUIET, is_cancel: false }), null);
    });
  });
});
