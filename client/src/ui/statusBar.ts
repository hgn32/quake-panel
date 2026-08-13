import { formatJstClock, type HealthState } from '@quake-panel/shared';
import type { ConnectionState } from '../core/connection.js';

/** 上部の状態表示。無人運用なので、異常はここだけ見れば分かるようにする。 */
export class StatusBar {
  private connection: ConnectionState = 'connecting';
  private health: HealthState | null = null;

  constructor(
    private readonly link: HTMLElement,
    private readonly kmoni: HTMLElement,
    private readonly p2p: HTMLElement,
    private readonly frameTime: HTMLElement,
    private readonly notice: HTMLElement,
  ) {}

  setConnection(state: ConnectionState): void {
    this.connection = state;
    const label = state === 'open' ? '接続中' : state === 'connecting' ? '接続試行中' : '切断';
    setChip(this.link, label, state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'bad');
    this.renderNotice();
  }

  setHealth(health: HealthState): void {
    this.health = health;
    setChip(this.kmoni, '強震モニタ', health.kmoniImage.ok && health.kmoniEew.ok ? 'ok' : 'bad');
    setChip(this.p2p, 'P2P', health.p2p.ok ? 'ok' : 'bad');
    this.renderNotice();
  }

  setFrameTime(isoTime: string | null, latencyMs: number): void {
    if (!isoTime) {
      this.frameTime.textContent = '強震モニタ --:--:--';
      return;
    }
    const delay = latencyMs >= 4000 ? ` (${(latencyMs / 1000).toFixed(0)}秒遅延)` : '';
    this.frameTime.textContent = `強震モニタ ${formatJstClock(isoTime)}${delay}`;
  }

  /** 接続断のほうが重い異常なので、劣化モードの案内より優先して出す。 */
  private renderNotice(): void {
    let message: string | null = null;
    if (this.connection !== 'open') {
      message = 'サーバーに接続できません。再接続を試みています…';
    } else if (this.health?.degraded) {
      // 劣化モード: kmoni が止まっていても P2P の地震情報だけで継続する (§4)
      message = '強震モニタに接続できません。地震情報のみで表示を継続しています。';
    }
    if (message) {
      this.notice.textContent = message;
      this.notice.hidden = false;
    } else {
      this.notice.hidden = true;
    }
  }
}

function setChip(el: HTMLElement, label: string, level: 'ok' | 'warn' | 'bad'): void {
  el.textContent = label;
  el.className = `chip chip--${level}`;
}
