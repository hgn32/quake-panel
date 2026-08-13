import type { Settings, UrlKey } from '../settings.js';
import { h, replaceChildren } from './dom.js';

export interface SettingsPanelDeps {
  modal: HTMLElement;
  form: HTMLElement;
  openButton: HTMLElement;
  closeButton: HTMLElement;
  getSettings: () => Settings;
  /** URL で固定されている項目は編集させない */
  isFixedByUrl: (key: UrlKey) => boolean;
  onChange: (patch: Partial<Settings>) => void;
  /** 音と画面明滅の両方を出すテスト */
  onTest: () => void;
  /** 地図をクリックして利用地を選ぶモードに入る */
  onPickHome: () => void;
  /** 表示位置を決まった位置へ戻す */
  onResetView: (preset: 'japan' | 'home') => void;
}

/**
 * 端末ごとの設定 UI。
 * ここで決めるのは「この端末での鳴らし方・見せ方」だけで、サーバーの挙動は変えない (§3)。
 */
export class SettingsPanel {
  constructor(private readonly deps: SettingsPanelDeps) {
    deps.openButton.addEventListener('click', () => this.open());
    deps.closeButton.addEventListener('click', () => this.close());
    deps.modal.addEventListener('click', (ev) => {
      if (ev.target === deps.modal) this.close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.close();
    });
  }

  open(): void {
    this.render();
    this.deps.modal.hidden = false;
  }

  close(): void {
    this.deps.modal.hidden = true;
  }

  private render(): void {
    const settings = this.deps.getSettings();
    replaceChildren(
      this.deps.form,
      this.radioRow(
        'EEW の通知範囲',
        'この端末で音と明滅を出す範囲。サーバーは常に予報も警報も受信しています。',
        [
          { value: 'all', label: '予報から通知', checked: settings.notifyForecast },
          { value: 'warning', label: '警報のみ通知', checked: !settings.notifyForecast },
        ],
        (value) => this.deps.onChange({ notifyForecast: value === 'all' }),
      ),
      this.sliderRow(
        '音量',
        null,
        { value: settings.volume, min: 0, max: 1, step: 0.05 },
        (value) => `${Math.round(value * 100)}%`,
        (value) => this.deps.onChange({ volume: value }),
      ),
      this.row(
        'テスト',
        '実際の警報と同じ音と画面明滅を数秒だけ出します。',
        this.button('音と明滅をテスト', () => {
          // 明滅は画面全体に出るので、確認できるよう設定画面を閉じる
          this.close();
          this.deps.onTest();
        }),
      ),
      this.homeRow(settings),
      this.tsunamiRow(settings),
      this.viewRow(settings),
      this.checkboxRow(
        '表示位置を固定',
        'ホイールでの拡大縮小とドラッグでのスクロールを受け付けなくします。常時表示の端末で誤って動かさないため。',
        settings.locked,
        (checked) => this.deps.onChange({ locked: checked }),
      ),
      this.checkboxRow(
        '観測点を発光表示',
        '拡大時の粗さが目立たなくなります。動作が重い場合は切ってください。',
        settings.glow,
        (checked) => this.deps.onChange({ glow: checked }),
      ),
      this.checkboxRow(
        '配信画像の見出しを隠す',
        '強震モニタ画像の左上に焼き込まれた英字の見出しを描画しません (観測点は含まれない領域です)。',
        settings.hideCaption,
        (checked) => this.deps.onChange({ hideCaption: checked }),
      ),
      this.numberRow('履歴の表示件数', settings.historyCount, 3, 12, (value) =>
        this.deps.onChange({ historyCount: value }),
      ),
    );
  }

  /** 利用地。数値の直接入力と、地図から選ぶ方法の両方を用意する。 */
  private homeRow(settings: Settings): HTMLElement {
    const fixed = this.deps.isFixedByUrl('home');
    const lat = this.coordInput(settings.home.lat, -90, 90, fixed, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lat: value } }),
    );
    const lon = this.coordInput(settings.home.lon, -180, 180, fixed, (value) =>
      this.deps.onChange({ home: { ...this.deps.getSettings().home, lon: value } }),
    );
    const pick = this.button('地図から選ぶ', () => {
      this.close();
      this.deps.onPickHome();
    });
    if (fixed) pick.disabled = true;
    return this.row(
      '利用地',
      fixed
        ? 'URL で指定されているため変更できません。'
        : '地図の中心と、地震情報の履歴で自分の県を前に出すのに使います。',
      h(
        'div',
        { class: 'settings__options' },
        h('label', { class: 'settings__coord' }, h('span', { text: '緯度' }), lat),
        h('label', { class: 'settings__coord' }, h('span', { text: '経度' }), lon),
        pick,
      ),
    );
  }

  /** 津波予報区。カンマ区切りで持つ (予報区名は都道府県名とは限らない)。 */
  private tsunamiRow(settings: Settings): HTMLElement {
    const fixed = this.deps.isFixedByUrl('tsunamiAreas');
    const input = h('input', { type: 'text', class: 'settings__text' });
    input.value = settings.tsunamiAreas.join(', ');
    input.disabled = fixed;
    input.addEventListener('change', () => {
      const areas = input.value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      this.deps.onChange({ tsunamiAreas: areas });
    });
    return this.row(
      '強調する津波予報区',
      fixed
        ? 'URL で指定されているため変更できません。'
        : 'カンマ区切り。津波予報でこの予報区が対象になったとき強調します (例: 東京都, 千葉県)。',
      input,
    );
  }

  /** 表示位置。ふだんは地図を直接動かすので、ここには戻す手段だけ置く。 */
  private viewRow(settings: Settings): HTMLElement {
    return this.row(
      '地図の表示位置',
      `地図はホイールで拡大縮小、ドラッグでスクロールできます (現在 ${settings.view.zoom.toFixed(1)}倍)。`,
      h(
        'div',
        { class: 'settings__options' },
        this.button('日本全体', () => {
          this.deps.onResetView('japan');
          this.render();
        }),
        this.button('利用地周辺', () => {
          this.deps.onResetView('home');
          this.render();
        }),
      ),
    );
  }

  private coordInput(
    value: number,
    min: number,
    max: number,
    disabled: boolean,
    onChange: (value: number) => void,
  ): HTMLInputElement {
    const input = h('input', {
      type: 'number',
      class: 'settings__number',
      min: String(min),
      max: String(max),
      step: '0.001',
    });
    input.value = String(value);
    input.disabled = disabled;
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isFinite(next) || next < min || next > max) {
        input.value = String(value);
        return;
      }
      onChange(next);
    });
    return input;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = h('button', { class: 'button', type: 'button', text: label });
    button.addEventListener('click', onClick);
    return button;
  }

  private radioRow(
    label: string,
    hint: string | null,
    options: Array<{ value: string; label: string; checked: boolean }>,
    onSelect: (value: string) => void,
  ): HTMLElement {
    const name = `radio-${label}`;
    const group = h(
      'div',
      { class: 'settings__options' },
      ...options.map((option) => {
        const input = h('input', { type: 'radio', name, value: option.value });
        input.checked = option.checked;
        input.addEventListener('change', () => {
          if (input.checked) onSelect(option.value);
        });
        return h('label', { class: 'settings__option' }, input, h('span', { text: option.label }));
      }),
    );
    return this.row(label, hint, group);
  }

  private checkboxRow(
    label: string,
    hint: string | null,
    checked: boolean,
    onToggle: (checked: boolean) => void,
  ): HTMLElement {
    const input = h('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onToggle(input.checked));
    return this.row(label, hint, h('label', { class: 'settings__option' }, input));
  }

  private sliderRow(
    label: string,
    hint: string | null,
    range: { value: number; min: number; max: number; step: number },
    format: (value: number) => string,
    onInput: (value: number) => void,
  ): HTMLElement {
    const input = h('input', {
      type: 'range',
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
    });
    input.value = String(range.value);
    const readout = h('span', { class: 'settings__readout', text: format(range.value) });
    input.addEventListener('input', () => {
      const next = Number(input.value);
      readout.textContent = format(next);
      onInput(next);
    });
    return this.row(label, hint, h('div', { class: 'settings__options' }, input, readout));
  }

  private numberRow(
    label: string,
    value: number,
    min: number,
    max: number,
    onInput: (value: number) => void,
  ): HTMLElement {
    const input = h('input', { type: 'number', min: String(min), max: String(max) });
    input.value = String(value);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) onInput(Math.min(Math.max(next, min), max));
    });
    return this.row(label, null, input);
  }

  private row(label: string, hint: string | null, control: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'settings__row' },
      h(
        'div',
        { class: 'settings__label' },
        h('span', { text: label }),
        hint ? h('span', { class: 'settings__hint', text: hint }) : null,
      ),
      control,
    );
  }
}
