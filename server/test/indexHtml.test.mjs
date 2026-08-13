import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingressBaseHref, injectBaseHref } from '../dist/http/indexHtml.js';

const req = (headers) => ({ headers });

describe('ingressBaseHref', () => {
  it('前置きパスが無ければ null (素で動かしているとき)', () => {
    assert.equal(ingressBaseHref(req({})), null);
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': '' })), null);
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': '/' })), null);
  });

  it('Supervisor が渡す形に末尾スラッシュを足す', () => {
    // 実際に届く値。末尾にスラッシュは付いてこない。
    assert.equal(
      ingressBaseHref(req({ 'x-ingress-path': '/api/hassio_ingress/dGVzdA' })),
      '/api/hassio_ingress/dGVzdA/',
    );
    assert.equal(
      ingressBaseHref(req({ 'x-ingress-path': '/api/hassio_ingress/dGVzdA/' })),
      '/api/hassio_ingress/dGVzdA/',
    );
  });

  it('直接ポートを開けている場合に備えて、怪しい値は無視する', () => {
    // プロトコル相対 URL。基準を別ホストにされる。
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': '//evil.example' })), null);
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': 'http://evil.example/' })), null);
    // 属性を抜け出す文字
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': '/a"><script>x</script>' })), null);
    // 相対パス (基準にならない)
    assert.equal(ingressBaseHref(req({ 'x-ingress-path': 'api/hassio_ingress/x' })), null);
  });
});

describe('injectBaseHref', () => {
  const html = '<!doctype html>\n<html lang="ja">\n  <head>\n    <meta charset="utf-8" />\n  </head>\n</html>';

  it('<head> の直後に入れる (最初の <base> だけが効くため)', () => {
    const out = injectBaseHref(html, '/api/hassio_ingress/dGVzdA/');
    assert.match(out, /<head>\s*<base href="\/api\/hassio_ingress\/dGVzdA\/">/);
    assert.ok(out.indexOf('<base') < out.indexOf('<meta'));
  });

  it('<head> が無ければ先頭に入れる', () => {
    const out = injectBaseHref('<p>hi</p>', '/x/');
    assert.equal(out, '<base href="/x/"><p>hi</p>');
  });
});
