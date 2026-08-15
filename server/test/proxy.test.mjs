import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyGlobalProxy, createWsProxyAgent, isProxyBypassed, resolveProxyUrl } from '../dist/proxy.js';

const PROXY = 'http://proxy.example.co.jp:3128/';

describe('NO_PROXY の判定', () => {
  it('完全一致で迂回する', () => {
    assert.equal(isProxyBypassed('supervisor', 'supervisor,localhost'), true);
  });

  it('サブドメインはサフィックス一致で迂回する', () => {
    assert.equal(isProxyBypassed('api.example.com', 'example.com'), true);
    assert.equal(isProxyBypassed('api.example.com', '.example.com'), true);
  });

  it('部分一致では迂回しない (notexample.com は example.com に当たらない)', () => {
    assert.equal(isProxyBypassed('notexample.com', 'example.com'), false);
  });

  it('* はすべて迂回する', () => {
    assert.equal(isProxyBypassed('api.p2pquake.net', '*'), true);
  });

  it('空文字は何にも当たらない', () => {
    assert.equal(isProxyBypassed('api.p2pquake.net', ''), false);
    assert.equal(isProxyBypassed('api.p2pquake.net', ' , '), false);
  });

  it('ポート付きの書き方も host 部で判定する', () => {
    assert.equal(isProxyBypassed('example.com', 'example.com:443'), true);
  });

  it('大文字小文字を無視する', () => {
    assert.equal(isProxyBypassed('API.Example.COM', 'example.com'), true);
  });
});

describe('プロキシ URL の解決', () => {
  it('https は HTTPS_PROXY を使う', () => {
    assert.equal(resolveProxyUrl('https://api.p2pquake.net/v2/history', { HTTPS_PROXY: PROXY }), PROXY);
  });

  it('wss も HTTPS_PROXY を使う', () => {
    assert.equal(resolveProxyUrl('wss://api.p2pquake.net/v2/ws', { HTTPS_PROXY: PROXY }), PROXY);
  });

  it('http は HTTP_PROXY を使う', () => {
    assert.equal(resolveProxyUrl('http://www.kmoni.bosai.go.jp/', { HTTP_PROXY: PROXY }), PROXY);
  });

  it('小文字の環境変数も読む', () => {
    assert.equal(resolveProxyUrl('https://api.p2pquake.net/', { https_proxy: PROXY }), PROXY);
  });

  it('環境変数が無ければ null (＝直接接続)', () => {
    assert.equal(resolveProxyUrl('https://api.p2pquake.net/', {}), null);
  });

  it('空文字の環境変数は未設定として扱う', () => {
    assert.equal(resolveProxyUrl('https://api.p2pquake.net/', { HTTPS_PROXY: '  ' }), null);
  });

  it('NO_PROXY に当たる宛先は null', () => {
    const env = { HTTP_PROXY: PROXY, NO_PROXY: 'supervisor,localhost' };
    assert.equal(resolveProxyUrl('http://supervisor/core/api', env), null);
  });

  it('https に HTTP_PROXY だけがあっても使わない (curl と同じ規則)', () => {
    assert.equal(resolveProxyUrl('https://api.p2pquake.net/', { HTTP_PROXY: PROXY }), null);
  });

  it('URL として壊れていれば null', () => {
    assert.equal(resolveProxyUrl('not a url', { HTTPS_PROXY: PROXY }), null);
  });
});

describe('WebSocket 用 agent', () => {
  it('プロキシ環境変数が無ければ agent を作らない', () => {
    assert.equal(createWsProxyAgent('wss://api.p2pquake.net/v2/ws', {}), null);
  });

  it('NO_PROXY に当たれば agent を作らない', () => {
    const env = { HTTPS_PROXY: PROXY, NO_PROXY: 'api.p2pquake.net' };
    assert.equal(createWsProxyAgent('wss://api.p2pquake.net/v2/ws', env), null);
  });

  it('プロキシ配下では agent を作る', () => {
    const agent = createWsProxyAgent('wss://api.p2pquake.net/v2/ws', { HTTPS_PROXY: PROXY });
    assert.notEqual(agent, null);
    assert.equal(agent.proxy.origin, 'http://proxy.example.co.jp:3128');
  });
});

describe('グローバル適用', () => {
  it('環境変数が無ければ何もせず null を返す (直接接続のまま)', () => {
    assert.equal(applyGlobalProxy({}), null);
  });

  it('空文字だけなら何もしない', () => {
    assert.equal(applyGlobalProxy({ HTTP_PROXY: '', HTTPS_PROXY: '  ' }), null);
  });
});
