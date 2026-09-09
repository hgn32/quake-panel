import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { EventLog } from '../dist/notify/eventLog.js';

/**
 * 地震イベントの事実記録 (server/src/notify/eventLog.ts)。
 *
 * 平常時は何も書かず、実機で何が起きたかをあとから追えるようにするための
 * JSONL ログ。ここでは書き込みの形・直列化・無効化・保持期間だけを確認する
 * (上流には一切依存しない純粋な fs 操作なのでモック不要)。
 */

/** 一時ディレクトリを 1 つ作る (テストごとに隔離する) */
const makeTempDir = () => mkdtemp(path.join(tmpdir(), 'quake-panel-event-log-'));

const makeConfig = (dir, retentionDays = '30') =>
  loadConfig({ EVENT_LOG_DIR: dir, EVENT_LOG_RETENTION_DAYS: retentionDays });

describe('EventLog', () => {
  it('write() で JSONL が 1 行ずつ追記され、at/type/data が入っている', () =>
    makeTempDir().then((dir) => {
      const eventLog = new EventLog(makeConfig(dir));
      eventLog.write('quake', { id: 'x1', maxIntensity: 50 });
      return eventLog
        .flush()
        .then(() => readdir(dir))
        .then((names) => {
          assert.equal(names.length, 1, 'quake-YYYYMMDD.jsonl が 1 つ作られているはず');
          return readFile(path.join(dir, names[0]), 'utf8');
        })
        .then((content) => {
          const lines = content.split('\n').filter((line) => line !== '');
          assert.equal(lines.length, 1);
          const entry = JSON.parse(lines[0]);
          assert.equal(typeof entry.at, 'string');
          assert.equal(Number.isNaN(new Date(entry.at).getTime()), false, 'at は ISO 時刻のはず');
          assert.equal(entry.type, 'quake');
          assert.deepEqual(entry.data, { id: 'x1', maxIntensity: 50 });
        });
    }));

  it('連続で呼んでも直列化されて行が壊れない (10 件書いて 10 行になる)', () =>
    makeTempDir().then((dir) => {
      const eventLog = new EventLog(makeConfig(dir));
      const count = 10;
      Array.from({ length: count }).forEach((_, i) => {
        eventLog.write('webhook', { i });
      });
      return eventLog
        .flush()
        .then(() => readdir(dir))
        .then((names) => readFile(path.join(dir, names[0]), 'utf8'))
        .then((content) => {
          const lines = content.split('\n').filter((line) => line !== '');
          assert.equal(lines.length, count, '直列化されず行が欠けた/混ざった疑い');
          // 壊れていれば JSON.parse がここで例外を投げる
          const parsed = lines.map((line) => JSON.parse(line));
          assert.deepEqual(
            parsed.map((entry) => entry.data.i),
            Array.from({ length: count }, (_, i) => i),
            '書いた順番のまま並んでいないはず',
          );
        });
    }));

  it('dir が空文字列なら何も書かない (完全に無効)', () =>
    makeTempDir().then((dir) => {
      const nested = path.join(dir, 'unused');
      const eventLog = new EventLog(makeConfig(''));
      eventLog.write('quake', { id: 'x1' });
      return eventLog
        .flush()
        .then(() => readdir(dir))
        .then((names) => {
          assert.deepEqual(names, [], '空文字列指定なのにディレクトリへ書き込みが発生している');
          return readdir(nested).catch(() => 'ENOENT');
        })
        .then((result) => {
          assert.equal(result, 'ENOENT', '無効時に無関係なディレクトリまで作られている');
        });
    }));

  it('保持期間より古いファイルが消える (起動時に prune される)', () =>
    makeTempDir().then((dir) => {
      const oldFile = path.join(dir, 'quake-20200101.jsonl');
      const recentFile = path.join(dir, 'quake-20991231.jsonl');
      const unrelated = path.join(dir, 'not-a-log.txt');
      return Promise.all([
        writeFile(oldFile, '{}\n', 'utf8'),
        writeFile(recentFile, '{}\n', 'utf8'),
        writeFile(unrelated, 'hello', 'utf8'),
      ]).then(() => {
        // retentionDays=1 で、2020-01-01 は明らかに古い。
        const eventLog = new EventLog(makeConfig(dir, '1'));
        return eventLog
          .flush()
          .then(() => readdir(dir))
          .then((names) => {
            assert.equal(names.includes('quake-20200101.jsonl'), false, '古いファイルが残っている');
            assert.equal(names.includes('quake-20991231.jsonl'), true, '未来日付のファイルまで消えている');
            assert.equal(names.includes('not-a-log.txt'), true, '無関係なファイルまで消えている');
          });
      });
    }));
});
