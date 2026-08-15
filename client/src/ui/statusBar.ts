import type { HealthState } from '@quake-panel/shared';
import type { ConnectionState } from '../core/connection.js';

/**
 * 上部の状態表示。無人運用なので、異常はここだけ見れば分かるようにする。
 *
 * チップは平常時は名前だけ (緑) にして、異常なときだけ何が起きたかを添える。
 * 常時点けっぱなしの画面なので、平常時ほど文字が少ない方が異常に気付きやすい。
 */
export class StatusBar {
  private connection: ConnectionState = 'connecting';
  private health: HealthState | null = null;
  private frameLatencyMs = 0;
  private hasFrame = false;
  private manualNotice: string | null = null;
  private noticeTimer: number | null = null;

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

  /**
   * サーバーとの接続は、切れているときだけ出す。
   * つながっていれば強震モニタと地震情報のチップが緑になっていること自体が
   * 接続の証拠になるので、平常時に並べる意味がない。
   */
  setConnection(state: ConnectionState): void {
    this.connection = state;
    if (state === 'open') {
      this.link.hidden = true;
    } else {
      this.link.hidden = false;
      setChip(this.link, 'サーバー', state === 'connecting' ? '接続試行中' : '切断', state === 'connecting' ? 'warn' : 'bad');
    }
    this.renderNotice();
  }

  setHealth(health: HealthState): void {
    this.health = health;
    this.renderKmoni();
    setChip(this.p2p, '地震情報', health.p2p.ok ? null : '切断', health.p2p.ok ? 'ok' : 'bad');
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
    setChip(this.kmoni, '強震モニタ', null, 'ok');
  }

  /**
   * 操作の案内など、状態とは関係なく出したいメッセージ。
   * null に戻すと通常の状態表示へ戻る。
   */
  setNotice(message: string | null): void {
    this.manualNotice = message;
    this.renderNotice();
  }

  /** 操作の結果を数秒だけ出す (保存できたことを画面で分かるように) */
  flashNotice(message: string, durationMs = 2500): void {
    this.setNotice(message);
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      this.setNotice(null);
    }, durationMs);
  }

  /** 接続断のほうが重い異常なので、劣化モードの案内より優先して出す。 */
  private renderNotice(): void {
    let message: string | null = this.manualNotice;
    if (message === null && this.connection !== 'open') {
      message = 'サーバーに接続できません。再接続を試みています…';
    } else if (message === null && this.health?.degraded) {
      // 劣化モード: kmoni が止まっていても P2P の地震情報だけで継続する (§4)
      message = '強震モニタに接続できません。地震情報のみで表示を継続しています。';
    }
    if (message) {
      this.notice.textContent = message;
      this.notice.classList.toggle('map-notice--info', message === this.manualNotice);
      this.notice.hidden = false;
    } else {
      this.notice.hidden = true;
    }
  }
}

/**
 * 状態チップの描画。
 *
 * 正常時は名前だけにする。「受信中」は緑の枠で分かるうえ、常時表示の画面では
 * 平常時ほど文字が減っていた方が異常に気付きやすい。異常なとき (不通・切断・
 * 遅延) は色だけでは何が起きたか分からないので、必ず文言を添える。
 */
function setChip(
  el: HTMLElement,
  name: string,
  state: string | null,
  level: 'ok' | 'warn' | 'bad',
): void {
  el.textContent = state === null ? name : `${name} ${state}`;
  el.className = `chip chip--${level}`;
}
