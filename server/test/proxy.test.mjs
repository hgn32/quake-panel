import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UPSTREAM_PROXY_ENV,
  applyGlobalProxy,
  buildProxyAgentOptions,
  createWsProxyAgent,
  resolveProxyUrl,
} from '../dist/proxy.js';

const PROXY = 'http://proxy.example.com:3128/';

describe('プロキシ URL の決定', () => {
  it('設定されていればその値を使う', () => {
    assert.equal(resolveProxyUrl({ [UPSTREAM_PROXY_ENV]: PROXY }), PROXY);
  });

  it('未設定なら null (直接接続)', () => {
    assert.equal(resolveProxyUrl({}), null);
  });

  it('空白だけなら未設定と同じ', () => {
    assert.equal(resolveProxyUrl({ [UPSTREAM_PROXY_ENV]: '  ' }), null);
  });

  it('前後の空白は落とす', () => {
    assert.equal(resolveProxyUrl({ [UPSTREAM_PROXY_ENV]: ` ${PROXY} ` }), PROXY);
  });

  it('標準のプロキシ環境変数は見ない (名前を取り違えたまま動かさない)', () => {
    assert.equal(resolveProxyUrl({ HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY }), null);
  });
});

describe('WebSocket 用の agent', () => {
  it('未設定なら agent を作らない', () => {
    assert.equal(createWsProxyAgent({}), null);
  });

  it('設定されていれば agent を作る', () => {
    const agent = createWsProxyAgent({ [UPSTREAM_PROXY_ENV]: PROXY });
    assert.notEqual(agent, null);
    assert.equal(String(agent?.proxy), PROXY);
  });

  it('URL として壊れていれば起動時にエラーにする (黙って直接接続にしない)', () => {
    assert.throws(() => createWsProxyAgent({ [UPSTREAM_PROXY_ENV]: 'not a url' }));
  });
});

describe('プロキシ agent のオプション組み立て', () => {
  it('平文 http 宛に CONNECT トンネルを張らせない (Squid が :80 への CONNECT を拒否するため proxyTunnel は false)', () => {
    assert.equal(buildProxyAgentOptions(PROXY).proxyTunnel, false);
  });

  it('http/https どちらも同じプロキシ URL を使う', () => {
    const options = buildProxyAgentOptions(PROXY);
    assert.equal(options.httpProxy, PROXY);
    assert.equal(options.httpsProxy, PROXY);
  });

  it('noProxy は空文字にして周囲の環境変数の影響を受けない', () => {
    assert.equal(buildProxyAgentOptions(PROXY).noProxy, '');
  });
});

describe('fetch 全体への適用', () => {
  it('未設定なら何もしない', () => {
    assert.equal(applyGlobalProxy({}), null);
  });

  it('空白だけなら何もしない', () => {
    assert.equal(applyGlobalProxy({ [UPSTREAM_PROXY_ENV]: '  ' }), null);
  });
});
