import type { HealthState } from '@quake-panel/shared';
import type { ConnectionState } from '../core/connection.js';

/**
 * 上部の状態表示。無人運用なので、異常はここだけ見れば分かるようにする。
 *
 * チップは「何の状態か」と「どうなっているか」を必ず一緒に出す。
 * 名前だけを出しても、色を覚えていない人には読み取れない。
 */
export class StatusBar {
  private connection: ConnectionState = 'connecting';
  private health: HealthState | null = null;
  private frameLatencyMs = 0;
  private hasFrame = false;

  constructor(
    private readonly link: HTMLElement,
    private readonly kmoni: HTMLElement,
    private readonly p2p: HTMLElement,
    private readonly notice: HTMLElement,
  ) {
    this.link.title = 'このパネルを配信しているサーバーとの接続';
    this.kmoni.title = '強震モニタ (防災科学技術研究所) からのリアルタイム震度画像と緊急地震速報の取得状況';
    this.p2p.title = 'P2P地震情報からの地震情報・津波予報・緊急地震速報の受信状況';
  }

  setConnection(state: ConnectionState): void {
    this.connection = state;
    const label = state === 'open' ? '接続中' : state === 'connecting' ? '接続試行中' : '切断';
    setChip(this.link, 'サーバー', label, state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'bad');
    this.renderNotice();
  }

  setHealth(health: HealthState): void {
    this.health = health;
    this.renderKmoni();
    setChip(this.p2p, '地震情報', health.p2p.ok ? '受信中' : '切断', health.p2p.ok ? 'ok' : 'bad');
    this.renderNotice();
  }

  /**
   * フレームの時刻そのものは出さない (毎秒動く数字は情報量の割に目障り)。
   * 遅れが実用に響く大きさになったときだけ、強震モニタのチップで知らせる。
   */
  setFrameTime(isoTime: string | null, latencyMs: number): void {
    this.hasFrame = isoTime !== null;
    this.frameLatencyMs = latencyMs;
    this.renderKmoni();
  }

  private renderKmoni(): void {
    const health = this.health;
    if (!health) return;
    const ok = health.kmoniImage.ok && health.kmoniEew.ok;
    if (!ok) {
      setChip(this.kmoni, '強震モニタ', '不通', 'bad');
      return;
    }
    if (this.hasFrame && this.frameLatencyMs >= 4000) {
      setChip(this.kmoni, '強震モニタ', `${Math.round(this.frameLatencyMs / 1000)}秒遅延`, 'warn');
      return;
    }
    setChip(this.kmoni, '強震モニタ', '受信中', 'ok');
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

function setChip(el: HTMLElement, name: string, state: string, level: 'ok' | 'warn' | 'bad'): void {
  el.textContent = `${name} ${state}`;
  el.className = `chip chip--${level}`;
}
