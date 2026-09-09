import { mkdir, readdir, unlink, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fromKmoniTimestamp, kmoniDatePart, toKmoniTimestamp, type JsonValue } from '@quake-panel/shared';
import type { Config } from '../config.js';
import { createLogger, describeError } from '../logger.js';

const log = createLogger('event-log');

/** 1 日 1 ファイルの命名規則。日付部分だけ取り出すのに使う。 */
const FILE_PATTERN = /^quake-(\d{8})\.jsonl$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ログ 1 行。JSONL で 1 イベント 1 行。 */
export interface EventLogEntry {
  /** 記録時刻 (ISO) */
  at: string;
  /** 何の記録か */
  type: string;
  /** 内容 (type ごとに異なる。JSON にできる値だけ) */
  data: Record<string, JsonValue>;
}

/**
 * 地震イベントの事実記録 (JSONL)。
 *
 * 目的は「実機で何が起きたかを、あとから事実で追えるようにする」ことだけで、
 * 平常時は何も書かない。EEW・地震情報・津波・webhook 送信・描画経路などを
 * `write()` で 1 行ずつ追記する。書き込みは `WebhookNotifier` の `tails` と
 * 同じ考え方で直列化し、失敗しても本体の動作は止めない (§4-3)。
 *
 * `config.eventLog.dir` が空文字列なら完全に無効 (何もしない)。
 */
export class EventLog {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly enabled: boolean;
  /** 直列化した書き込みの末尾。write() のたびにここへ .then() で継ぎ足す。 */
  private tail: Promise<void>;
  /** 書き込み失敗の warn は 1 回だけ出す。 */
  private warned = false;
  /** 一度書き込みに失敗したら、以後は試みずに黙って捨てる。 */
  private broken = false;
  /** 直前に書き込んだ日付 (JST, YYYYMMDD)。変わったら prune() を効かせる。 */
  private currentDate: string | null = null;
  private stopped = false;

  constructor(config: Config) {
    this.dir = config.eventLog.dir;
    this.retentionDays = config.eventLog.retentionDays;
    this.enabled = this.dir !== '';
    // 起動時にもディレクトリを整え、期限切れのファイルを片付けておく。
    this.tail = this.enabled ? this.prepare() : Promise.resolve();
  }

  /** 1 行追記する。fire-and-forget。失敗しても本体は止めない。 */
  write(type: string, data: Record<string, JsonValue>): void {
    if (!this.enabled || this.stopped) return;
    const entry: EventLogEntry = { at: new Date().toISOString(), type, data };
    const line = `${JSON.stringify(entry)}\n`;
    // 直列化: 前の書き込みが終わってから次を投げる (WebhookNotifier の tails と同じ考え方)。
    this.tail = this.tail.then(() => this.append(line));
  }

  /** 直列化した書き込みが片付くまで待つ (終了処理・テスト用)。 */
  flush(): Promise<void> {
    return this.tail;
  }

  stop(): void {
    this.stopped = true;
  }

  private prepare(): Promise<void> {
    return mkdir(this.dir, { recursive: true })
      .then(() => this.pruneOld())
      .catch((error: Error) => this.warnOnce(error));
  }

  private append(line: string): Promise<void> {
    if (this.broken) return Promise.resolve();
    const date = kmoniDatePart(toKmoniTimestamp(new Date()));
    const rolledOver = this.currentDate !== null && this.currentDate !== date;
    this.currentDate = date;
    return mkdir(this.dir, { recursive: true })
      .then(() => appendFile(this.filePath(date), line, 'utf8'))
      .then(() => (rolledOver ? this.pruneOld() : undefined))
      .catch((error: Error) => this.warnOnce(error));
  }

  private filePath(date: string): string {
    return path.join(this.dir, `quake-${date}.jsonl`);
  }

  /** 保持期間より古い quake-*.jsonl を削除する。失敗しても無視する。 */
  private pruneOld(): Promise<void> {
    const cutoffMs = Date.now() - this.retentionDays * MS_PER_DAY;
    return readdir(this.dir)
      .then((names) =>
        Promise.all(
          names
            .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
            .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
            .filter(({ match }) => {
              const dateOnly = fromKmoniTimestamp(`${match[1]}000000`);
              return dateOnly !== null && dateOnly.getTime() < cutoffMs;
            })
            .map(({ name }) => unlink(path.join(this.dir, name)).catch(() => undefined)),
        ),
      )
      .then(() => undefined)
      .catch(() => undefined);
  }

  private warnOnce(error: Error): void {
    this.broken = true;
    if (this.warned) return;
    this.warned = true;
    log.warn(`event log の書き込みに失敗しました。以後このプロセスでは記録を諦めます: ${describeError(error)}`);
  }
}
