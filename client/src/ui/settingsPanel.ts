import { ZOOM_RANGE, type Settings } from '../settings.js';
import { h, replaceChildren } from './dom.js';

export interface SettingsPanelDeps {
  modal: HTMLElement;
  form: HTMLElement;
  openButton: HTMLElement;
  closeButton: HTMLElement;
  getSettings: () => Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** 音と画面明滅の両方を出すテスト */
  onTest: () => void;
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
        h('button', { class: 'button', type: 'button', text: '音と明滅をテスト' }),
      ),
      this.radioRow(
        '地図の表示範囲',
        null,
        [
          { value: 'japan', label: '日本全体', checked: settings.mapMode === 'japan' },
          { value: 'home', label: '利用地周辺', checked: settings.mapMode === 'home' },
        ],
        (value) => this.deps.onChange({ mapMode: value === 'home' ? 'home' : 'japan' }),
      ),
      this.sliderRow(
        '拡大',
        '選んだ表示範囲をさらに拡大します。はみ出した分は上下左右が切れます。',
        {
          value: settings.zoom,
          min: ZOOM_RANGE.min,
          max: ZOOM_RANGE.max,
          step: ZOOM_RANGE.step,
        },
        (value) => `${value.toFixed(1)}倍`,
        (value) => this.deps.onChange({ zoom: value }),
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

    const testButton = this.deps.form.querySelector('button');
    testButton?.addEventListener('click', () => {
      // 明滅は画面全体に出るので、確認できるよう設定画面を閉じる
      this.close();
      this.deps.onTest();
    });
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
