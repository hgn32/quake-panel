import {
  formatJstDateTime,
  intensityColor,
  intensityLabel,
  intensityTextColor,
  type QuakeInfo,
} from '@quake-panel/shared';
import { h, replaceChildren } from './dom.js';

const ISSUE_LABEL: Record<string, string> = {
  ScalePrompt: '震度速報',
  Destination: '震源に関する情報',
  ScaleAndDestination: '震源・震度情報',
  DetailScale: '各地の震度',
  Foreign: '遠地地震',
  Other: 'その他',
};

/**
 * 地震情報の履歴。
 *
 * 利用地付近の震度は、ここに出る気象庁発表の実測値で確認する。
 * 強震モニタ画像の色から震度を推定する処理は規約上行わない (§2(2), Phase 4 除外)。
 */
export class QuakeList {
  /** homeHints は利用地の手掛かり (例: ["東京都"])。前にあるものほど優先。 */
  constructor(
    private readonly root: HTMLElement,
    private homeHints: readonly string[],
  ) {}

  /** 利用地はサーバーの現況一括で分かるので、接続後に差し替える */
  setHomeHints(hints: readonly string[]): void {
    this.homeHints = hints;
  }

  update(quakes: QuakeInfo[], limit: number): void {
    if (quakes.length === 0) {
      replaceChildren(this.root, h('li', { class: 'quake-list__empty', text: '地震情報はありません' }));
      return;
    }
    replaceChildren(this.root, ...quakes.slice(0, limit).map((q) => this.renderItem(q)));
  }

  private renderItem(quake: QuakeInfo): HTMLElement {
    const chip = h('span', {
      class: 'quake-list__scale',
      text: intensityLabel(quake.maxIntensity) ?? '-',
    });
    chip.style.background = intensityColor(quake.maxIntensity);
    chip.style.color = intensityTextColor(quake.maxIntensity);

    const homePoint = this.findHomePoint(quake);

    return h(
      'li',
      { class: 'quake-list__item' },
      chip,
      h(
        'div',
        { class: 'quake-list__body' },
        h('div', {
          class: 'quake-list__place',
          // 震度速報では震源が未確定。「不明」と出すより発表種別で見せたほうが分かりやすい。
          text: quake.hypocenter.name !== '不明' ? quake.hypocenter.name : '震源調査中',
        }),
        h(
          'div',
          { class: 'quake-list__meta' },
          h('span', { text: formatJstDateTime(quake.occurredAt ?? quake.issuedAt) }),
          h('span', {
            text: quake.hypocenter.magnitude != null ? `M${quake.hypocenter.magnitude.toFixed(1)}` : 'M--',
          }),
          h('span', {
            text: quake.hypocenter.depthKm != null ? `深さ${quake.hypocenter.depthKm}km` : '深さ--',
          }),
          h('span', { class: 'quake-list__type', text: ISSUE_LABEL[quake.issueType] ?? quake.issueType }),
        ),
        homePoint
          ? h('div', {
              class: 'quake-list__home',
              text: `${homePoint.addr} 震度${intensityLabel(homePoint.scale) ?? '-'}`,
            })
          : null,
        quake.domesticTsunami === 'Warning' || quake.domesticTsunami === 'Watch'
          ? h('div', { class: 'quake-list__tsunami', text: '津波情報あり' })
          : null,
      ),
    );
  }

  /**
   * 利用地の観測点があれば拾って前に出す。手掛かりの並び順で優先度が決まる。
   *
   * 手掛かりは県名までしか無く (地名は設定させない)、観測点に座標も付いて
   * こないため、同じ県内で複数該当したときは最も揺れた点を採る。
   */
  private findHomePoint(quake: QuakeInfo): { addr: string; scale: number | null } | null {
    for (const hint of this.homeHints) {
      let best: { addr: string; scale: number | null } | null = null;
      for (const point of quake.points) {
        if (point.isArea) continue;
        if (!point.addr.includes(hint) && !point.pref.includes(hint)) continue;
        if (!best || (point.scale ?? -1) > (best.scale ?? -1)) {
          best = { addr: point.addr, scale: point.scale };
        }
      }
      if (best) return best;
    }
    return null;
  }
}
