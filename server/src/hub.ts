import { EventEmitter } from 'node:events';
import type {
  EewDetection,
  EewState,
  FrameNotice,
  HealthState,
  QuakeInfo,
  ServerEvent,
  SourceStatus,
  StateSnapshot,
  TsunamiInfo,
} from '@quake-panel/shared';
import type { Config } from './config.js';

export type SourceName = 'kmoniImage' | 'kmoniEew' | 'p2p';

const freshStatus = (): SourceStatus => ({
  ok: false,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
});

/**
 * 取得系と配信系のあいだに立つ唯一の状態保持者。
 *
 * 取得ワーカーはここへ書き込むだけ、配信系はここを読むだけにして、
 * ワーカー同士が直接依存しないようにしている。
 */
export class Hub extends EventEmitter {
  readonly startedAt = new Date();

  private frame: FrameNotice | null = null;
  private eew: EewState | null = null;
  private quakes: QuakeInfo[] = [];
  private tsunami: TsunamiInfo | null = null;
  private clockOffsetMs = 0;
  private readonly status: Record<SourceName, SourceStatus> = {
    kmoniImage: freshStatus(),
    kmoniEew: freshStatus(),
    p2p: freshStatus(),
  };

  constructor(private readonly config: Config) {
    super();
    this.setMaxListeners(64);
  }

  override on(event: 'event', listener: (payload: ServerEvent) => void): this {
    return super.on(event, listener);
  }

  private publish(event: ServerEvent): void {
    this.emit('event', event);
  }

  // --- 取得系から呼ばれる ------------------------------------------------

  publishFrame(frame: FrameNotice): void {
    this.frame = frame;
    this.publish({ type: 'frame', frame });
  }

  /**
   * EEW の更新。`null` は表示終了 (保持期間切れ) を意味する。
   * 内容が実質的に変わっていないときは配信しない。
   */
  publishEew(eew: EewState | null): void {
    if (eew === null && this.eew === null) return;
    if (eew && this.eew && !hasEewChanged(this.eew, eew)) return;
    this.eew = eew;
    this.publish({ type: 'eew', eew });
  }

  publishEewDetection(detection: EewDetection): void {
    this.publish({ type: 'eewDetection', detection });
  }

  publishQuake(quake: QuakeInfo): void {
    this.quakes = [quake, ...this.quakes.filter((q) => q.id !== quake.id)].slice(
      0,
      this.config.quakeHistorySize,
    );
    this.publish({ type: 'quake', quake });
  }

  /** 起動時の履歴取り込み。イベント配信はせず現況にだけ積む。 */
  seedQuakes(quakes: QuakeInfo[]): void {
    const merged = [...this.quakes];
    for (const q of quakes) {
      if (!merged.some((m) => m.id === q.id)) merged.push(q);
    }
    merged.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''));
    this.quakes = merged.slice(0, this.config.quakeHistorySize);
  }

  publishTsunami(tsunami: TsunamiInfo): void {
    this.tsunami = tsunami.cancelled ? { ...tsunami, areas: [] } : tsunami;
    this.publish({ type: 'tsunami', tsunami: this.tsunami });
  }

  seedTsunami(tsunami: TsunamiInfo | null): void {
    if (tsunami && !tsunami.cancelled) this.tsunami = tsunami;
  }

  setClockOffset(offsetMs: number): void {
    if (Math.abs(offsetMs - this.clockOffsetMs) < 200) return;
    this.clockOffsetMs = offsetMs;
    this.publishHealth();
  }

  getClockOffset(): number {
    return this.clockOffsetMs;
  }

  markSuccess(source: SourceName): void {
    const s = this.status[source];
    const wasDegraded = this.isDegraded();
    const wasOk = s.ok;
    s.ok = true;
    s.consecutiveFailures = 0;
    s.lastSuccessAt = new Date().toISOString();
    if (!wasOk || wasDegraded !== this.isDegraded()) this.publishHealth();
  }

  markFailure(source: SourceName, error: string): void {
    const s = this.status[source];
    const wasDegraded = this.isDegraded();
    const wasOk = s.ok;
    s.consecutiveFailures += 1;
    s.lastErrorAt = new Date().toISOString();
    s.lastError = error;
    if (s.consecutiveFailures >= this.config.kmoni.degradeAfterFailures) s.ok = false;
    if (wasOk !== s.ok || wasDegraded !== this.isDegraded()) this.publishHealth();
  }

  // --- 配信系から呼ばれる ------------------------------------------------

  /** kmoni 側が落ちていて P2P だけで継続している状態 (§4 劣化モード) */
  isDegraded(): boolean {
    return !this.status.kmoniImage.ok || !this.status.kmoniEew.ok;
  }

  getHealth(): HealthState {
    return {
      kmoniImage: { ...this.status.kmoniImage },
      kmoniEew: { ...this.status.kmoniEew },
      p2p: { ...this.status.p2p },
      degraded: this.isDegraded(),
      clockOffsetMs: this.clockOffsetMs,
      serverStartedAt: this.startedAt.toISOString(),
    };
  }

  getSnapshot(): StateSnapshot {
    return {
      serverTime: new Date().toISOString(),
      health: this.getHealth(),
      frame: this.frame,
      eew: this.eew,
      quakes: this.quakes,
      tsunami: this.tsunami,
      home: this.config.home,
    };
  }

  getEew(): EewState | null {
    return this.eew;
  }

  private publishHealth(): void {
    this.publish({ type: 'health', health: this.getHealth() });
  }
}

/** 続報として意味のある差があるか (毎秒同じ内容を配らないため) */
function hasEewChanged(a: EewState, b: EewState): boolean {
  return (
    a.id !== b.id ||
    a.reportNumber !== b.reportNumber ||
    a.isCancel !== b.isCancel ||
    a.isFinal !== b.isFinal ||
    a.alert !== b.alert ||
    a.maxIntensity !== b.maxIntensity ||
    a.source !== b.source ||
    a.hypocenter.name !== b.hypocenter.name ||
    a.hypocenter.lat !== b.hypocenter.lat ||
    a.hypocenter.lon !== b.hypocenter.lon ||
    a.hypocenter.depthKm !== b.hypocenter.depthKm ||
    a.hypocenter.magnitude !== b.hypocenter.magnitude ||
    a.regions.length !== b.regions.length
  );
}
