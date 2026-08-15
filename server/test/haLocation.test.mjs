import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { fetchHomeLocation } from '../dist/haLocation.js';

const config = (env) =>
  loadConfig({ HA_API_URL: 'http://supervisor/core/api', SUPERVISOR_TOKEN: 'token', ...env });

/** 呼ばれた URL とヘッダーを覚える偽 fetch */
function stubFetch(handler) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

const jsonResponse = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('Home Assistant の自宅位置', () => {
  it('コア API の /config から緯度経度を取り出す', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ latitude: 35.681, longitude: 139.767, location_name: 'Home' }),
    );
    const home = await fetchHomeLocation(config(), impl);
    assert.deepEqual(home, { lat: 35.681, lon: 139.767 });
    assert.equal(calls[0].url, 'http://supervisor/core/api/config');
    assert.equal(calls[0].init.headers.authorization, 'Bearer token');
  });

  it('通知を無効にしていても取得できる (位置は通知とは別の機能)', async () => {
    const { impl } = stubFetch(() => jsonResponse({ latitude: 43.062, longitude: 141.354 }));
    const home = await fetchHomeLocation(config({ HA_NOTIFY: 'false' }), impl);
    assert.deepEqual(home, { lat: 43.062, lon: 141.354 });
  });

  it('アドオンでない (API の場所が無い) ときは呼びに行かない', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ latitude: 1, longitude: 1 }));
    const home = await fetchHomeLocation(loadConfig({}), impl);
    assert.equal(home, null);
    assert.equal(calls.length, 0);
  });

  it('HA がエラーを返しても落ちず null になる', async () => {
    const { impl } = stubFetch(() => jsonResponse({ message: 'unauthorized' }, 401));
    assert.equal(await fetchHomeLocation(config(), impl), null);
  });

  it('通信そのものが失敗しても落ちず null になる', async () => {
    const { impl } = stubFetch(() => Promise.reject(new Error('network down')));
    assert.equal(await fetchHomeLocation(config(), impl), null);
  });

  it('HA に位置が入っていない (0,0) なら null', async () => {
    const { impl } = stubFetch(() => jsonResponse({ latitude: 0, longitude: 0 }));
    assert.equal(await fetchHomeLocation(config(), impl), null);
  });
});
