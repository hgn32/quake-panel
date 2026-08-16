import {
  KMONI_LAYER_LABELS,
  applyHomeAreas,
  formatJstClock,
  matchesQuakeFilter,
  tsunamiAreasForPrefecture,
  type KmoniLayer,
  type EewState,
  type HealthState,
  type QuakeInfo,
  type ServerEvent,
  type StateSnapshot,
  type TsunamiInfo,
} from '@quake-panel/shared';
import { AlertPresenter } from './core/alert.js';
import { ServerConnection, type ConnectionState } from './core/connection.js';
import { FrameStream } from './core/frameStream.js';
import { canUseBrowserLocation, requestBrowserLocation } from './core/homeLocation.js';
import {
  MapView,
  ZOOM_RANGE,
  fullMapView,
  homeMapView,
  liftPointColor,
  type MapViewState,
} from './core/mapView.js';
import { SettingsStore, type Settings } from './settings.js';
import { h, replaceChildren, requireElement } from './ui/dom.js';
import { EewPanel } from './ui/eewPanel.js';
import { QuakeList } from './ui/quakeList.js';
import { SettingsPanel } from './ui/settingsPanel.js';
import { Splitter } from './ui/splitter.js';
import { StatusBar } from './ui/statusBar.js';
import { TsunamiPanel } from './ui/tsunamiPanel.js';

/**
 * 地図に出ている色の凡例。
 *
 * 強震モニタのリアルタイム震度は、気象庁の震度階級 (1〜7 の段階) ではなく
 * 連続的な指標で、青 → 水色 → 緑 → 黄 → 赤 と変わる。段階の凡例を並べると
 * 「地図の色と違う」ことになるので、実際に配信されている色の並びを出す。
 *
 * 低い側は配信画像から実際に出ている色 (#0000cd〜#32f147)、
 * 高い側は同じ並びの延長。段階との対応は示さない (色から値は読まない §2(2))。
 */
const REALTIME_SCALE_COLORS = [
  '#0000cd',
  '#0040f5',
  '#0070d8',
  '#0099b7',
  '#00c296',
  '#32f147',
  '#e8e839',
  '#f2a13a',
  '#e8452e',
  '#c026a8',
];

/**
 * 画面全体の取りまとめ。
 *
 * 毎秒更新される描画は MapView / FrameStream が担い、ここは
 * 「たまにしか変わらない UI」だけを触る (§5 推奨構成)。
 */
export class App {
  private readonly store = new SettingsStore();
  private settings: Settings = this.store.current;
  private readonly alert: AlertPresenter;
  private readonly mapView: MapView;
  private readonly frames: FrameStream;
  private readonly connection: ServerConnection;
  private readonly statusBar: StatusBar;
  private readonly eewPanel: EewPanel;
  private readonly tsunamiPanel: TsunamiPanel;
  private readonly quakeList: QuakeList;
  private readonly settingsPanel: SettingsPanel;
  private readonly splitter: Splitter;

  private quakes: QuakeInfo[] = [];
  private tsunami: TsunamiInfo | null = null;
  private eew: EewState | null = null;
  private clockTimer: number | null = null;
  private cursorTimer: number | null = null;
  private testFlashTimer: number | null = null;
  private viewSaveTimer: number | null = null;
  private sideSaveTimer: number | null = null;

  constructor() {
    this.alert = new AlertPresenter(requireElement('flash'));
    this.alert.audio.setVolume(this.settings.volume);

    this.mapView = new MapView(
      requireElement<HTMLCanvasElement>('map'),
      {
        view: this.settings.view,
        interactive: !this.settings.locked,
        home: this.settings.home,
      },
      (view) => this.handleViewChange(view),
    );
    this.frames = new FrameStream((frame) => {
      this.mapView.setFrame(frame);
      this.statusBar.setFrameTime(frame.notice.isoTime, frame.notice.latencyMs);
    });

    this.statusBar = new StatusBar(
      requireElement('status-link'),
      requireElement('status-kmoni'),
      requireElement('status-p2p'),
      requireElement('map-notice'),
    );
    this.eewPanel = new EewPanel(requireElement('eew-panel'));
    this.tsunamiPanel = new TsunamiPanel(requireElement('tsunami-panel'));
    this.quakeList = new QuakeList(requireElement('quake-list'));
    this.settingsPanel = new SettingsPanel({
      modal: requireElement('settings'),
      form: requireElement('settings-form'),
      openButton: requireElement('settings-open'),
      closeButton: requireElement('settings-close'),
      cancelButton: requireElement('settings-cancel'),
      getSettings: () => this.settings,
      isFixedByUrl: (key) => this.store.isFixedByUrl(key),
      onChange: (patch) => this.applySettings(patch),
      onTest: () => this.runAlertTest(),
      onPickHome: () => this.startHomePick(),
      canUseCurrentLocation: () => canUseBrowserLocation(),
      requestCurrentLocation: () => requestBrowserLocation(),
      describeTsunamiAreas: () => {
        const areas = this.homeAreas();
        return areas.length > 0 ? areas.join('、') : '(利用地の県が分からないため無し)';
      },
      hiddenQuakeCount: () => this.quakes.length - this.visibleQuakes().length,
    });

    // 地図と地震情報の境目。動かした位置はその端末に保存する
    this.splitter = new Splitter({
      handle: requireElement('split'),
      container: requireElement('main'),
      getSize: () => ({ width: this.settings.sideWidth, height: this.settings.sideHeight }),
      onResize: (patch) => this.handleSideResize(patch),
    });

    this.connection = new ServerConnection({
      onEvent: (event) => this.handleEvent(event),
      onStateChange: (state) => this.handleConnectionState(state),
    });
  }

  start(): Promise<void> {
    this.renderLegend();
    this.alert.setFlashSeconds(this.settings.flashSeconds);
    this.alert.audio.setMaxSeconds(this.settings.soundSeconds);
    this.splitter.apply();
    this.splitter.setLocked(this.settings.locked);
    // 画面の回転や縮小で境目が画面外へ出ないよう、都度収め直す
    window.addEventListener('resize', () => this.splitter.apply());
    this.startClock();
    this.setupAudioGate();
    this.setupCursorAutoHide();
    this.setupMapControls();
    return this.mapView.init().then(() => {
      this.connection.start();

      // タブが再表示されたときは取りこぼしを疑って現況を取り直す
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.connection.requestResync();
      });
    });
  }

  private handleConnectionState(state: ConnectionState): void {
    this.statusBar.setConnection(state);
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        this.applySnapshot(event.snapshot);
        break;
      case 'frame':
        this.frames.accept(event.frame);
        break;
      case 'eew':
        this.applyEew(event.eew);
        break;
      case 'eewDetection':
        // 詳細不明の第一報。EEW 本体が来ていないときだけ短く鳴らす。
        if (!this.eew) this.alert.applyDetection(event.detection.id);
        break;
      case 'quake':
        this.quakes = [event.quake, ...this.quakes.filter((q) => q.id !== event.quake.id)];
        this.renderQuakes();
        break;
      case 'tsunami':
        this.applyTsunami(event.tsunami);
        break;
      case 'health':
        this.applyHealth(event.health);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private applySnapshot(snapshot: StateSnapshot): void {
    // hello の中で取り直しを頼むと堂々巡りになるので、ここでは反映だけ
    this.applyLayer(false);
    this.quakes = snapshot.quakes;
    this.renderQuakes();
    this.applyHealth(snapshot.health);
    this.applyTsunami(snapshot.tsunami);
    this.applyEew(snapshot.eew);
    if (snapshot.frame) this.frames.accept(snapshot.frame);
    else this.statusBar.setFrameTime(null, 0);
  }

  private applyHealth(health: HealthState): void {
    this.statusBar.setHealth(health);
  }

  private applyEew(eew: EewState | null): void {
    this.eew = eew;
    this.eewPanel.update(eew);
    this.mapView.setEew(eew);
    this.alert.applyEewSound(eew, this.settings.notifyForecast);
    this.refreshFlash();
  }

  private applyTsunami(info: TsunamiInfo | null): void {
    // どの予報区を自分ごとにするかは端末ごとの設定なので、ここで印を付ける
    const tsunami = info ? applyHomeAreas(info, this.homeAreas()) : null;
    this.tsunami = tsunami;
    this.tsunamiPanel.update(tsunami);
    this.mapView.setTsunami(tsunami);
    this.alert.applyTsunamiSound(tsunami);
    this.refreshFlash();
  }

  /**
   * 明滅の強さは EEW と津波の両方から決まるので、片方だけを見て切り替えない。
   * (EEW が消えたあとに津波の明滅へ戻す、といった遷移をここで一括して扱う)
   */
  private refreshFlash(): void {
    this.alert.applyFlash(this.eew, this.tsunami, this.settings.notifyForecast);
  }

  /** いま表示する指標 (端末の選択) */
  private currentLayer(): KmoniLayer {
    return this.settings.layer;
  }

  /** 指標を画面と取得先へ反映する */
  private applyLayer(requestFrame = true): void {
    const layer = this.currentLayer();
    if (this.frames.getLayer() !== layer) {
      this.frames.setLayer(layer);
      // 切り替えた瞬間から新しい指標で描くため、次の通知を待たずに取り直す
      if (requestFrame) this.connection.requestResync();
    }
    this.renderLegend();
  }

  /** 絞り込みを通した地震情報 */
  private visibleQuakes(): QuakeInfo[] {
    const prefecture = this.mapView.prefectureAt(this.settings.home.lat, this.settings.home.lon);
    return this.quakes.filter((quake) =>
      matchesQuakeFilter(quake, this.settings.quakeFilter, prefecture),
    );
  }

  private renderQuakes(): void {
    this.quakeList.update(this.visibleQuakes(), this.settings.historyCount);
  }

  private applySettings(patch: Partial<Settings>): void {
    const before = this.settings;
    this.settings = this.store.update(patch);
    this.alert.audio.setVolume(this.settings.volume);
    this.mapView.setOptions({
      view: this.settings.view,
      interactive: !this.settings.locked,
      home: this.settings.home,
    });
    this.updateMapControls();
    this.splitter.setLocked(this.settings.locked);
    this.alert.setFlashSeconds(this.settings.flashSeconds);
    this.alert.audio.setMaxSeconds(this.settings.soundSeconds);
    this.applyLayer();
    const homeMoved =
      before.home.lat !== this.settings.home.lat || before.home.lon !== this.settings.home.lon;
    if (homeMoved || before.tsunamiAreas !== this.settings.tsunamiAreas ||
        before.tsunamiMode !== this.settings.tsunamiMode) {
      // 印の付け直し (表示中の予報にも即座に効かせる)
      this.applyTsunami(this.tsunami);
    }
    this.refreshFlash();
    this.renderQuakes();
  }

  /**
   * 強調する津波予報区。
   * 自動のときは利用地の都道府県から決める (予報区名は県名と一致しないものがある)。
   */
  private homeAreas(): string[] {
    if (this.settings.tsunamiMode === 'manual') {
      return this.settings.tsunamiAreas.flatMap((area) => tsunamiAreasForPrefecture(area));
    }
    return tsunamiAreasForPrefecture(
      this.mapView.prefectureAt(this.settings.home.lat, this.settings.home.lon),
    );
  }

  /**
   * 地図の操作は地図の上に置く。設定画面に倍率の数字だけ置いても、
   * 何がどう動くのかが分からない。
   */
  private setupMapControls(): void {
    const zoomBy = (factor: number): void => {
      const view = this.settings.view;
      const zoom = Math.min(Math.max(view.zoom * factor, ZOOM_RANGE.min), ZOOM_RANGE.max);
      this.applySettings({ view: { ...view, zoom } });
    };
    requireElement('map-zoom-in').addEventListener('click', () => zoomBy(1.4));
    requireElement('map-zoom-out').addEventListener('click', () => zoomBy(1 / 1.4));
    requireElement('map-view-japan').addEventListener('click', () =>
      this.applySettings({ view: fullMapView() }),
    );
    requireElement('map-view-home').addEventListener('click', () =>
      this.applySettings({ view: homeMapView(this.settings.home) }),
    );
    this.updateMapControls();
  }

  private updateMapControls(): void {
    requireElement('map-zoom-value').textContent = `${this.settings.view.zoom.toFixed(1)}x`;
    // 固定中は操作しても動かないので、ボタン自体を隠す
    requireElement('map-controls').hidden = this.settings.locked;
  }

  private handleViewChange(view: MapViewState): void {
    this.settings = { ...this.settings, view };
    this.updateMapControls();
    this.saveViewLater(view);
  }

  /**
   * 地図から利用地を選ぶ。
   *
   * クリックしただけでは確定させず、地図の上の帯に候補を出して「決定」を待つ。
   * 押した瞬間に保存されると、選べたのか・選び直せるのかが分からない。
   */
  private startHomePick(): void {
    const bar = requireElement('map-pick');
    const value = requireElement('map-pick-value');
    const okButton = requireElement<HTMLButtonElement>('map-pick-ok');
    const cancelButton = requireElement('map-pick-cancel');
    const before = { ...this.settings.home };
    let picked: { lat: number; lon: number } | null = null;

    const finish = (): void => {
      this.mapView.cancelPick();
      bar.hidden = true;
      document.removeEventListener('keydown', onKey);
      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
    };
    const onOk = (): void => {
      if (!picked) return;
      finish();
      this.applySettings({ home: picked });
      this.statusBar.flashNotice(`利用地を保存しました (${picked.lat}, ${picked.lon})`);
    };
    const onCancel = (): void => {
      finish();
      // 仮表示で動かしたマーカーを元に戻す
      this.mapView.setOptions({ home: before });
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onCancel();
      if (ev.key === 'Enter') onOk();
    };

    value.textContent = '未選択';
    okButton.disabled = true;
    bar.hidden = false;
    document.addEventListener('keydown', onKey);
    okButton.addEventListener('click', onOk);
    cancelButton.addEventListener('click', onCancel);

    this.mapView.startPick((location) => {
      picked = { lat: round3(location.lat), lon: round3(location.lon) };
      value.textContent = `${picked.lat}, ${picked.lon}`;
      okButton.disabled = false;
      // マーカーを仮の位置へ動かして、どこを選んだか見えるようにする
      this.mapView.setOptions({ home: picked });
    });
  }

  /**
   * スクロール・拡大のたびに保存すると書き込みが多すぎるので、
   * 手が止まってからまとめて保存する。
   */
  /**
   * 境目のドラッグ。
   *
   * 動かしている間は画面へ反映するだけにして、止まってから保存する
   * (pointermove ごとに localStorage へ書くと重い)。
   */
  private handleSideResize(patch: { sideWidth?: number; sideHeight?: number }): void {
    this.settings = { ...this.settings, ...patch };
    if (this.sideSaveTimer !== null) window.clearTimeout(this.sideSaveTimer);
    this.sideSaveTimer = window.setTimeout(() => {
      this.sideSaveTimer = null;
      this.settings = this.store.update(patch);
    }, 400);
  }

  private saveViewLater(view: MapViewState): void {
    if (this.viewSaveTimer !== null) window.clearTimeout(this.viewSaveTimer);
    this.viewSaveTimer = window.setTimeout(() => {
      this.viewSaveTimer = null;
      this.settings = this.store.update({ view });
    }, 400);
  }

  private startClock(): void {
    const clock = requireElement('clock');
    const date = requireElement('clock-date');
    const tick = (): void => {
      const now = new Date();
      clock.textContent = formatJstClock(now);
      const jst = new Date(now.getTime() + 9 * 3600 * 1000);
      date.textContent = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(
        jst.getUTCDate(),
      ).padStart(2, '0')}`;
    };
    tick();
    this.clockTimer = window.setInterval(tick, 250);
  }

  /**
   * 設定画面のテスト。音だけでは「気づけるか」の確認にならないので、
   * 実際の警報と同じ明滅も一緒に出す。数秒で本来の状態へ戻す。
   */
  private runAlertTest(): void {
    this.alert.audio.test();
    if (this.testFlashTimer !== null) window.clearTimeout(this.testFlashTimer);
    this.alert.setFlash('warning');
    this.testFlashTimer = window.setTimeout(() => {
      this.testFlashTimer = null;
      // 実際に警報が出ていればそちらが勝つ (テストで消してしまわない)
      this.refreshFlash();
    }, 4000);
  }

  /**
   * 操作していない間はマウスカーソルを消す。
   *
   * 常時表示のパネルに矢印が残り続けるのは邪魔だが、最初から消えていると
   * 設定を開きたいときに困る。動かしたら出す、止まったら消す、にしておく。
   */
  private setupCursorAutoHide(): void {
    const HIDE_AFTER_MS = 3000;
    const show = (): void => {
      document.body.classList.remove('cursor-hidden');
      if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
      this.cursorTimer = window.setTimeout(() => {
        document.body.classList.add('cursor-hidden');
      }, HIDE_AFTER_MS);
    };
    document.addEventListener('pointermove', show);
    document.addEventListener('pointerdown', show);
    show();
  }

  /**
   * 自動再生制限の解除。Chromium キオスクなら起動フラグでも回避できるが、
   * 普通のブラウザで開いたときのために操作待ちの案内を出す (§4)。
   */
  private setupAudioGate(): void {
    const gate = requireElement('audio-gate');
    void this.alert.audio.unlock().then((ok) => {
      if (ok) return;
      gate.hidden = false;
      const dismiss = (): Promise<void> =>
        this.alert.audio.unlock().then((unlocked) => {
          if (!unlocked) return;
          gate.hidden = true;
          document.removeEventListener('pointerdown', handler);
          document.removeEventListener('keydown', handler);
        });
      const handler = (): void => void dismiss();
      document.addEventListener('pointerdown', handler);
      document.addEventListener('keydown', handler);
    });
  }

  private renderLegend(): void {
    const legend = requireElement('map-legend');
    const bar = h('span', { class: 'map-legend__bar' });
    // 地図の観測点と同じ明るさ調整を通しておく (凡例と地図の見え方を揃える)
    const colors = REALTIME_SCALE_COLORS.map((hex) => {
      const value = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = liftPointColor((value >> 16) & 255, (value >> 8) & 255, value & 255);
      return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    });
    bar.style.background = `linear-gradient(90deg, ${colors.join(', ')})`;
    const label = KMONI_LAYER_LABELS[this.currentLayer()];
    legend.title =
      `強震モニタの「${label}」の色。気象庁の震度階級 (履歴に出る 1〜7) とは別の指標です。`;
    replaceChildren(
      legend,
      // いま何を表示しているかは、地図の上に常に出しておく (設定を開かずに分かるように)
      h('span', { class: 'map-legend__title', text: label }),
      h('span', { class: 'map-legend__end', text: '弱' }),
      bar,
      h('span', { class: 'map-legend__end', text: '強' }),
    );
  }

  dispose(): void {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    if (this.testFlashTimer !== null) window.clearTimeout(this.testFlashTimer);
    if (this.viewSaveTimer !== null) window.clearTimeout(this.viewSaveTimer);
    this.connection.stop();
    this.frames.dispose();
    this.mapView.dispose();
    this.eewPanel.dispose();
  }
}

/** 緯度経度は 3 桁もあれば十分 (約 100m)。無駄に長い値を保存しない。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
