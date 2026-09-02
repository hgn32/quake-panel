import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';

import { resolveStaticRoot } from '../dist/http/static.js';

// `resolveStaticRoot` はリポジトリルート基準の絶対パスを返す必要がある。
// 起点は `moduleUrl` (呼び出し元モジュールの `import.meta.url`) であって
// `process.cwd()` ではないので、テストでは cwd を変えても結果が変わらない
// ことまで確認する。

describe('resolveStaticRoot', () => {
  it('ビルド後 (dist) のモジュール位置から STATIC_DIR を解決する', () => {
    const moduleUrl = 'file:///workspaces/server/dist/http/server.js';
    assert.equal(resolveStaticRoot(moduleUrl, 'client/dist'), '/workspaces/client/dist');
  });

  it('ソース (src) のモジュール位置からでも同じ結果になる (dev)', () => {
    const moduleUrl = 'file:///workspaces/server/src/http/server.ts';
    assert.equal(resolveStaticRoot(moduleUrl, 'client/dist'), '/workspaces/client/dist');
  });

  it('STATIC_DIR 既定値 (public) でも解決できる', () => {
    const moduleUrl = 'file:///workspaces/server/dist/http/server.js';
    assert.equal(resolveStaticRoot(moduleUrl, 'public'), '/workspaces/public');
  });

  it('process.cwd() に依存しない (dev の cwd は server/ になるが影響しない)', () => {
    const moduleUrl = 'file:///workspaces/server/dist/http/server.js';
    const originalCwd = process.cwd();
    // 実在するディレクトリへ移る。以前は moduleUrl と同じ /workspaces/server へ
    // 移していたが、そのパスが無い環境ではテスト自体が ENOENT で落ちていた。
    // ここで確かめたいのは「cwd がどこであっても結果が変わらない」ことなので、
    // 移る先はリポジトリと無関係な場所であるほどよい。
    process.chdir(tmpdir());
    try {
      assert.equal(resolveStaticRoot(moduleUrl, 'client/dist'), '/workspaces/client/dist');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
