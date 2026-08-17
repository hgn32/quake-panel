import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';

describe('EEW_WEBHOOK_URL', () => {
  it('未設定なら urls は空配列 (webhook 無効)', () => {
    assert.deepEqual(loadConfig({}).eewWebhook.urls, []);
  });

  it('カンマ区切りで複数指定できる', () => {
    const config = loadConfig({
      EEW_WEBHOOK_URL: 'http://127.0.0.1:9001/hook,http://127.0.0.1:9002/hook',
    });
    assert.deepEqual(config.eewWebhook.urls, [
      'http://127.0.0.1:9001/hook',
      'http://127.0.0.1:9002/hook',
    ]);
  });

  it('前後の空白はトリムされる', () => {
    const config = loadConfig({ EEW_WEBHOOK_URL: ' http://127.0.0.1:9001/hook , http://127.0.0.1:9002/hook ' });
    assert.deepEqual(config.eewWebhook.urls, [
      'http://127.0.0.1:9001/hook',
      'http://127.0.0.1:9002/hook',
    ]);
  });

  it('空文字だけなら空配列', () => {
    assert.deepEqual(loadConfig({ EEW_WEBHOOK_URL: '' }).eewWebhook.urls, []);
    assert.deepEqual(loadConfig({ EEW_WEBHOOK_URL: '   ' }).eewWebhook.urls, []);
  });

  it('EEW_WEBHOOK_TIMEOUT_MS の既定は 5000', () => {
    assert.equal(loadConfig({}).eewWebhook.requestTimeoutMs, 5000);
  });

  it('EEW_WEBHOOK_TIMEOUT_MS を指定できる', () => {
    assert.equal(loadConfig({ EEW_WEBHOOK_TIMEOUT_MS: '3000' }).eewWebhook.requestTimeoutMs, 3000);
  });
});
