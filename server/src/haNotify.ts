import {
  intensityLabel,
  type EewState,
  type QuakeInfo,
  type ServerEvent,
  type TsunamiInfo,
} from '@quake-panel/shared';
import type { Config } from './config.js';
import type { Hub } from './hub.js';
import { createLogger, describeError } from './logger.js';

const log = createLogger('ha');

/** HA へ渡す 1 エンティティぶんの状態 */
export interface EntityState {
  entityId: string;
  state: string;
  attributes: Record<string, unknown>;
}

/**
 * Home Assistant への通知。
 *
 * このパネルは画面を見ていないと気づけないので、HA 側で「EEW が出たら
 * ダッシュボードを切り替える」といった自動化ができるように、
 * イベントとセンサーを流す。
 *
 * 経路は Supervisor 経由のコア API (`http://supervisor/core/api`)。
 * MQTT ブローカーを別途立てる必要がないのを優先した。ただし States API で
 * 作った状態は HA を再起動すると消えるため、一定間隔で入れ直す。
 *
 * 通知が失敗してもパネル本体の表示は続ける (通知はあくまで付加機能)。
 */
export class HomeAssistantNotifier {
  private timer: NodeJS.Timeout | null = null;
  private eew: EewState | null = null;
  private tsunami: TsunamiInfo | null = null;
  private quake: QuakeInfo | null = null;
  /** 同じ内容で何度もイベントを流さないための記録 */
  private lastEventKey = { eew: '', tsunami: '', quake: '' };
  /** 失敗のたびにログを埋めないよう、状態が変わったときだけ出す */
  private failing = false;
  /** 送信を 1 本にまとめるための状態 (並行に流すと古い値が後着しうる) */
  private pushing = false;
  private pushDirty = false;

  constructor(
    private readonly config: Config,
    private readonly hub: Hub,
  ) {}

  get enabled(): boolean {
    return this.config.homeAssistant.apiUrl !== '' && this.config.homeAssistant.token !== '';
  }

  start(): void {
    if (!this.enabled) return;
    this.hub.on('event', (event) => this.handle(event));
    // States API で作った状態は HA の再起動で消えるので、定期的に入れ直す
    this.timer = setInterval(() => void this.pushStates(), this.config.homeAssistant.refreshMs);
    this.timer.unref();
    void this.pushStates();
    log.info(`Home Assistant への通知を有効にしました (${this.config.homeAssistant.apiUrl})`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'eew': {
        this.eew = event.eew;
        const key = eewEventKey(event.eew);
        if (key !== this.lastEventKey.eew) {
          this.lastEventKey.eew = key;
          void this.fire('quake_panel_eew', eewEventData(event.eew));
        }
        void this.pushStates();
        break;
      }
      case 'tsunami': {
        this.tsunami = event.tsunami;
        const key = event.tsunami ? `${event.tsunami.id}:${event.tsunami.cancelled}` : 'none';
        if (key !== this.lastEventKey.tsunami) {
          this.lastEventKey.tsunami = key;
          void this.fire('quake_panel_tsunami', tsunamiEventData(event.tsunami));
        }
        void this.pushStates();
        break;
      }
      case 'quake': {
        this.quake = event.quake;
        if (event.quake.id !== this.lastEventKey.quake) {
          this.lastEventKey.quake = event.quake.id;
          void this.fire('quake_panel_quake', quakeEventData(event.quake));
        }
        void this.pushStates();
        break;
      }
      default:
        break;
    }
  }

  /**
   * センサーの入れ直し。
   *
   * 送信中にまた状態が変わったら、終わってからもう一度だけ流す。
   * 並行に投げると古い状態が後から届いて、EEW が終わっていないのに
   * 「発表なし」で上書きされることがある。
   */
  private async pushStates(): Promise<void> {
    if (this.pushing) {
      this.pushDirty = true;
      return;
    }
    this.pushing = true;
    try {
      do {
        this.pushDirty = false;
        for (const entity of buildEntities(this.eew, this.tsunami, this.quake)) {
          await this.post(`/states/${entity.entityId}`, {
            state: entity.state,
            attributes: entity.attributes,
          });
        }
      } while (this.pushDirty);
    } finally {
      this.pushing = false;
    }
  }

  private async fire(eventType: string, data: Record<string, unknown>): Promise<void> {
    await this.post(`/events/${eventType}`, data);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const url = `${this.config.homeAssistant.apiUrl.replace(/\/$/, '')}${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.homeAssistant.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.homeAssistant.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.failing) {
        this.failing = false;
        log.info('Home Assistant への通知が復帰しました');
      }
    } catch (error) {
      // 通知が届かなくてもパネルの表示は続ける
      if (!this.failing) {
        this.failing = true;
        log.warn(`Home Assistant へ通知できません (${path}): ${describeError(error)}`);
      }
    }
  }
}

/** 続報のたびに流すと騒がしいので、意味が変わったときだけ流す */
export function eewEventKey(eew: EewState | null): string {
  if (!eew) return 'none';
  return [eew.id, eew.alert, eew.maxIntensity ?? '-', eew.isCancel, eew.isFinal].join(':');
}

export function eewEventData(eew: EewState | null): Record<string, unknown> {
  if (!eew) return { active: false };
  return {
    active: !eew.isCancel,
    id: eew.id,
    alert: eew.alert,
    is_warning: eew.alert === 'warning',
    is_cancel: eew.isCancel,
    is_training: eew.isTraining,
    is_final: eew.isFinal,
    report_number: eew.reportNumber,
    max_intensity: intensityLabel(eew.maxIntensity),
    hypocenter: eew.hypocenter.name,
    magnitude: eew.hypocenter.magnitude,
    depth_km: eew.hypocenter.depthKm,
    origin_time: eew.originTime,
  };
}

export function tsunamiEventData(tsunami: TsunamiInfo | null): Record<string, unknown> {
  if (!tsunami) return { active: false };
  return {
    active: !tsunami.cancelled && tsunami.areas.length > 0,
    id: tsunami.id,
    cancelled: tsunami.cancelled,
    areas: tsunami.areas.map((area) => area.name),
    grades: [...new Set(tsunami.areas.map((area) => area.grade))],
  };
}

export function quakeEventData(quake: QuakeInfo): Record<string, unknown> {
  return {
    id: quake.id,
    max_intensity: intensityLabel(quake.maxIntensity),
    hypocenter: quake.hypocenter.name,
    magnitude: quake.hypocenter.magnitude,
    depth_km: quake.hypocenter.depthKm,
    occurred_at: quake.occurredAt,
    issue_type: quake.issueType,
    domestic_tsunami: quake.domesticTsunami,
  };
}

/**
 * HA に見せるセンサー。
 *
 * 訓練報とキャンセル報では「発表中」にしない。自動化でダッシュボードを
 * 切り替える用途で、訓練で切り替わると困るため (画面側の明滅と同じ扱い)。
 */
export function buildEntities(
  eew: EewState | null,
  tsunami: TsunamiInfo | null,
  quake: QuakeInfo | null,
): EntityState[] {
  const eewActive = eew !== null && !eew.isCancel && !eew.isTraining;
  const tsunamiActive = tsunami !== null && !tsunami.cancelled && tsunami.areas.length > 0;
  return [
    {
      entityId: 'binary_sensor.quake_panel_eew',
      state: eewActive ? 'on' : 'off',
      attributes: {
        friendly_name: '緊急地震速報',
        icon: 'mdi:alert-octagon',
        ...(eew ? eewEventData(eew) : {}),
      },
    },
    {
      entityId: 'sensor.quake_panel_eew_intensity',
      state: (eewActive && intensityLabel(eew.maxIntensity)) || 'unknown',
      attributes: {
        friendly_name: '緊急地震速報の予想最大震度',
        icon: 'mdi:earth',
      },
    },
    {
      entityId: 'binary_sensor.quake_panel_tsunami',
      state: tsunamiActive ? 'on' : 'off',
      attributes: {
        friendly_name: '津波予報',
        icon: 'mdi:waves',
        ...(tsunami ? tsunamiEventData(tsunami) : {}),
      },
    },
    {
      entityId: 'sensor.quake_panel_last_quake',
      state: (quake && intensityLabel(quake.maxIntensity)) || 'unknown',
      attributes: {
        friendly_name: '最新の地震情報',
        icon: 'mdi:pulse',
        ...(quake ? quakeEventData(quake) : {}),
      },
    },
  ];
}
