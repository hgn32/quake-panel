import { Agent, fetch } from 'undici';

import type { Config } from '../config.js';
import type { EewEvent } from '../eew/coordinator.js';
import { createLogger, describeError } from '../logger.js';

const log = createLogger('webhook');

/** POST する JSON の形。kind の意味は EewEventKind と同じ (new/update/cancel/expired)。 */
interface WebhookPayload {
  type: 'eew';
  kind: EewEvent['kind'];
  sentAt: string;
  eew: EewEvent['eew'];
}

/**
 * EEW イベントを設定された URL へ JSON で POST する汎用 webhook。
 *
 * `applyGlobalProxy` (proxy.ts) は undici の `setGlobalDispatcher` で
 * グローバル dispatcher をプロキシ経由に差し替えるため、何もしなければ
 * この webhook もプロキシを通ってしまう。webhook はローカルネットワーク宛てを
 * 想定しているので、リクエストごとに専用の `Agent` を明示指定して
 * グローバル設定に関係なく常に直接接続にする。
 */
export class WebhookNotifier {
  private readonly urls: string[];
  private readonly requestTimeoutMs: number;
  private readonly agent = new Agent();
  /** URL ごとの送信直列化。前の送信が終わってから次を投げる (順序保証)。 */
  private readonly tails = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(config: Config) {
    this.urls = config.eewWebhook.urls;
    this.requestTimeoutMs = config.eewWebhook.requestTimeoutMs;
  }

  /** coordinator の onEewEvent にそのまま渡す。fire-and-forget。 */
  handle(event: EewEvent): void {
    if (this.stopped) return;
    const payload: WebhookPayload = {
      type: 'eew',
      kind: event.kind,
      sentAt: new Date().toISOString(),
      eew: event.eew,
    };
    this.urls.forEach((url) => this.enqueue(url, payload));
  }

  /** 同一 URL への送信を直列化する。前の送信の成否によらず次を投げる。 */
  private enqueue(url: string, payload: WebhookPayload): void {
    const previous = this.tails.get(url) ?? Promise.resolve();
    const next = previous.then(() => this.send(url, payload));
    this.tails.set(url, next);
  }

  private send(url: string, payload: WebhookPayload): Promise<void> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      dispatcher: this.agent,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
      .then((res) => {
        if (!res.ok) {
          log.warn(`webhook ${url} responded ${res.status}`);
        }
      })
      .catch((error: Error) => {
        // リトライはしない。外部システムの不調で本体の動作を止めないため。
        log.warn(`webhook ${url} failed`, describeError(error));
      });
  }

  /** 多重呼び出し安全。以降の handle() は何もしなくなる。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // close() は Promise を返すが、終了処理として結果を待つ必要は無い。
    this.agent.close().catch(() => undefined);
  }
}
