import {
  formatJstClock,
  intensityColor,
  intensityLabel,
  intensityTextColor,
  type EewRelevance,
  type EewState,
} from '@quake-panel/shared';
import { h, replaceChildren } from './dom.js';

/**
 * 緊急地震速報の詳細表示。
 *
 * 表示するのは配信された値そのものだけ。到達予測時刻は気象庁が配信した値
 * (P2P 556 の areas[].arrivalTime) をそのまま出し、こちらで距離や速度から
 * 計算することはしない (§2(3) 気象業務法)。
 * 経過秒は「発震時刻からの経過」であって予測ではない。
 */
export class EewPanel {
  private timer: number | null = null;
  private current: EewState | null = null;
  /** この EEW の利用地にとってのランク。'none' なら音・明滅を出していない */
  private relevance: EewRelevance = 'none';

  constructor(private readonly root: HTMLElement) {}

  update(eew: EewState | null, relevance: EewRelevance): void {
    this.current = eew;
    this.relevance = relevance;
    if (!eew) {
      this.root.hidden = true;
      this.stopTicker();
      replaceChildren(this.root);
      return;
    }
    this.root.hidden = false;
    this.render();
    this.startTicker();
  }

  dispose(): void {
    this.stopTicker();
  }

  private startTicker(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.renderElapsed(), 200);
  }

  private stopTicker(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private render(): void {
    const eew = this.current;
    if (!eew) return;

    this.root.dataset['alert'] = eew.isCancel ? 'cancel' : eew.alert;
    const label = intensityLabel(eew.maxIntensity);

    const badge = h(
      'div',
      { class: 'eew__intensity' },
      h('span', { class: 'eew__intensity-label', text: '予想最大震度' }),
      h('span', { class: 'eew__intensity-value', text: label ?? '不明' }),
    );
    badge.style.setProperty('--intensity-color', intensityColor(eew.maxIntensity));
    badge.style.setProperty('--intensity-text', intensityTextColor(eew.maxIntensity));

    const tags = [
      eew.isCancel ? 'キャンセル報' : eew.alert === 'warning' ? '警報' : '予報',
      eew.isTraining ? '訓練' : null,
      eew.isAssumption ? '仮定震源' : null,
      eew.isFinal ? '最終報' : eew.reportNumber > 0 ? `第${eew.reportNumber}報` : null,
      eew.source === 'both' ? '強震モニタ+P2P' : eew.source === 'p2p' ? 'P2P' : '強震モニタ',
      // 音・明滅を出していない理由が画面で分かるように (全国モードでは常に none 以外)
      this.relevance === 'none' ? '利用地対象外' : null,
    ].filter((t): t is string => t !== null);

    replaceChildren(
      this.root,
      h(
        'div',
        { class: 'eew__head' },
        h('h2', { class: 'panel__title', text: '緊急地震速報' }),
        h(
          'div',
          { class: 'eew__tags' },
          ...tags.map((t) => h('span', { class: 'tag', text: t })),
        ),
      ),
      h(
        'div',
        { class: 'eew__main' },
        badge,
        h(
          'div',
          { class: 'eew__facts' },
          h('div', { class: 'eew__place', text: eew.hypocenter.name }),
          h(
            'div',
            { class: 'eew__numbers' },
            fact('規模', eew.hypocenter.magnitude != null ? `M${eew.hypocenter.magnitude.toFixed(1)}` : '--'),
            fact('深さ', eew.hypocenter.depthKm != null ? `${eew.hypocenter.depthKm}km` : '--'),
            fact('発震', eew.originTime ? formatJstClock(eew.originTime) : '--'),
          ),
          h('div', { class: 'eew__elapsed' }, h('span', { id: 'eew-elapsed', text: '--' })),
        ),
      ),
      eew.regions.length > 0 ? this.renderRegions(eew) : null,
      eew.isCancel
        ? h('p', { class: 'eew__note', text: 'この緊急地震速報は取り消されました。' })
        : null,
    );
    this.renderElapsed();
  }

  private renderRegions(eew: EewState): HTMLElement {
    // 予想震度の大きい順。到達予測時刻は気象庁の配信値をそのまま出す。
    const sorted = [...eew.regions].sort(
      (a, b) => (b.scaleTo ?? b.scaleFrom ?? 0) - (a.scaleTo ?? a.scaleFrom ?? 0),
    );
    return h(
      'div',
      { class: 'eew__regions' },
      h('div', { class: 'eew__regions-title', text: '警報対象地域 (気象庁発表)' }),
      h(
        'ul',
        { class: 'region-list' },
        ...sorted.slice(0, 8).map((region) => {
          const scale = region.scaleTo ?? region.scaleFrom;
          const chip = h('span', {
            class: 'region-list__scale',
            text: intensityLabel(scale) ?? '?',
          });
          chip.style.background = intensityColor(scale);
          chip.style.color = intensityTextColor(scale);
          return h(
            'li',
            { class: 'region-list__item' },
            chip,
            h('span', { class: 'region-list__name', text: region.name }),
            h('span', {
              class: 'region-list__time',
              text: region.arrivalTime ? `${formatJstClock(region.arrivalTime)} 到達予測` : '',
            }),
          );
        }),
      ),
    );
  }

  /** 発震からの経過秒。予測ではなく実時間の経過。 */
  private renderElapsed(): void {
    const eew = this.current;
    const target = this.root.querySelector<HTMLElement>('#eew-elapsed');
    if (!eew || !target) return;
    if (!eew.originTime) {
      target.textContent = '';
      return;
    }
    const seconds = (Date.now() - new Date(eew.originTime).getTime()) / 1000;
    target.textContent = seconds >= 0 ? `発震から ${seconds.toFixed(1)} 秒` : '';
  }
}

function fact(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'fact' },
    h('span', { class: 'fact__label', text: label }),
    h('span', { class: 'fact__value', text: value }),
  );
}
