import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {listInhibitors, classify, isRelevant} from './inhibitors.js';
import {readWakeCounts, diffWakeCounts, readSleepCycles, ResumeDetector} from './wakelog.js';
import {loadStore, saveStore, prune} from './store.js';
import {explain, processInfo, findPid} from './explain.js';
import {UpdateChecker} from './updater.js';

const LOGIND = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];
const OWN_WHO = 'wakebar';
const SAVE_EVERY_SEC = 60;
const UPDATE_CHECK_SEC = 6 * 3600;
const BAR_ROWS = 4;        // Zeilen je Protokoll-Kachel; der Rest liegt im Sidecar
const SIDECAR_ROWS = 30;

const WHAT = {sleep: 'Schlaf', idle: 'Leerlauf', shutdown: 'Herunterfahren', 'sleep:idle': 'Schlaf und Leerlauf'};
const MODE = {block: 'blockiert', 'block-weak': 'bremst', delay: 'verzögert'};

const fmtTime = sec => GLib.DateTime.new_from_unix_local(sec).format('%d.%m. %H:%M');
const fmtClock = sec => GLib.DateTime.new_from_unix_local(sec).format('%H:%M:%S');
const fmtDuration = sec => {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};
const iconFor = i => (i.mode === 'delay' || !/sleep|idle/.test(i.what)) ? 'computer-symbolic'
    : (/idle/.test(i.what) && !/sleep/.test(i.what)) ? 'video-display-symbolic' : 'weather-clear-night-symbolic';

export default class WakeBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._inhibitors = [];
        this._keepFd = null;
        this._cancellable = new Gio.Cancellable();
        this._store = loadStore();
        this._closeStaleBlockers();
        this._wakeCounts = readWakeCounts();
        this._resume = new ResumeDetector();
        this._lastSave = 0;
        this._lastCheck = Math.floor(Date.now() / 1000);
        this._signature = '';
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._schemeId = this._interfaceSettings.connect('changed::color-scheme', () => this._rebuildMenu(true));
        } catch (_e) {
            this._interfaceSettings = null;
        }

        this._updateChecker = new UpdateChecker(this.metadata.version || 1);
        this._updateInfo = null;
        this._buildPanel();
        this._checkUpdate();
        this._updateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UPDATE_CHECK_SEC, () => {
            this._checkUpdate();
            return GLib.SOURCE_CONTINUE;
        });
        this._importJournal().catch(e => console.error(`wakebar: Journal-Import fehlgeschlagen: ${e.message}`));
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_uint('refresh-interval'), () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._updateTimer) {
            GLib.source_remove(this._updateTimer);
            this._updateTimer = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._updateChecker?.destroy();
        this._updateChecker = null;
        this._stopKeepAwake();
        this._hideSidecar(true);
        this._hoverSidecar?.destroy();
        this._hoverSidecar = null;
        if (this._schemeId)
            this._interfaceSettings.disconnect(this._schemeId);
        this._schemeId = null;
        this._interfaceSettings = null;
        if (this._store)
            saveStore(this._store);
        this._button?.destroy();
        this._button = null;
        this._store = null;
        this._settings = null;
    }

    _buildPanel() {
        this._button = new PanelMenu.Button(0.5, 'wakebar', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._dot = new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER, style_class: 'wakebar-dot wakebar-green'});
        this._count = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'wakebar-count'});
        box.add_child(this._dot);
        box.add_child(this._count);
        this._button.add_child(box);
        this._button.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._rebuildMenu(true);
            else
                this._hideSidecar(true);
        });
        Main.panel.addToStatusArea('wakebar@johnlose.de', this._button, 0, this._settings.get_string('panel-position'));
        // Ein leeres PopupMenu öffnet sich nicht: von Anfang an befüllen, beim Öffnen erneuern
        this._rebuildMenu(true);
    }

    // ---- Datenerfassung -------------------------------------------------

    async _checkUpdate() {
        if (!this._settings?.get_boolean('update-check-enabled')) {
            this._updateInfo = null;
            return;
        }
        const info = await this._updateChecker?.checkForUpdates(this._cancellable);
        if (!this._button || !info)
            return;
        this._updateInfo = info;
        this._rebuildMenu(false);
    }

    async _refresh() {
        let list;
        try {
            list = await listInhibitors(this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`wakebar: Sperren nicht lesbar: ${e.message}`);
            return;
        }
        if (!this._button)
            return;

        const ignored = this._settings.get_strv('ignored-programs');
        this._inhibitors = list.filter(i => !ignored.includes(i.who));

        const resumed = this._resume.check();
        const counts = readWakeCounts();
        if (resumed)
            await this._recordWake(resumed, diffWakeCounts(this._wakeCounts, counts));
        this._wakeCounts = counts;
        if (!this._button)
            return;

        this._trackBlockers();
        this._lastCheck = Math.floor(Date.now() / 1000);
        this._render();
    }

    _key(i) {
        return `${i.who}|${i.why}|${i.what}|${i.mode}`;
    }

    // Blockierende Sperren mit Beginn und Ende protokollieren
    _trackBlockers() {
        const now = Math.floor(Date.now() / 1000);
        const live = this._inhibitors.filter(i => i.who !== OWN_WHO && isRelevant(i));
        const liveKeys = new Set(live.map(i => this._key(i)));
        let changed = false;

        for (const b of this._store.blockers) {
            if (b.end === null && !liveKeys.has(this._key(b))) {
                b.end = now;
                changed = true;
            }
        }
        const open = new Set(this._store.blockers.filter(b => b.end === null).map(b => this._key(b)));
        for (const i of live) {
            if (!open.has(this._key(i))) {
                this._store.blockers.push({who: i.who, why: i.why, what: i.what, mode: i.mode, start: now, end: null});
                changed = true;
            }
        }
        if (changed || now - this._lastSave >= SAVE_EVERY_SEC) {
            prune(this._store, this._settings.get_string('retention'));
            saveStore(this._store);
            this._lastSave = now;
        }
    }

    // Nach Neustart der Shell: Sperren, die beim letzten Speichern noch liefen, an diesem Zeitpunkt beenden
    _closeStaleBlockers() {
        for (const b of this._store.blockers) {
            if (b.end === null)
                b.end = this._store.savedAt || b.start;
        }
    }

    async _recordWake(resumed, sources) {
        let woke = resumed.to;
        let slept = resumed.from;
        try {
            const cycles = await readSleepCycles(resumed.from - 60);
            const last = cycles.at(-1);
            if (last && last.woke >= resumed.from - 5) {
                woke = last.woke;
                slept = last.slept;
            }
        } catch (e) {
            console.error(`wakebar: Journal nicht lesbar: ${e.message}`);
        }
        if (!this._store)
            return;
        this._addWake({slept, woke, source: sources.length ? sources.join(', ') : null});
    }

    _addWake(entry) {
        // Doppelte vermeiden (Journal-Import vs. Live-Erkennung)
        const dup = this._store.wakes.find(w => Math.abs(w.woke - entry.woke) <= 5);
        if (dup) {
            if (!dup.source && entry.source)
                dup.source = entry.source;
            return;
        }
        this._store.wakes.push(entry);
        this._store.wakes.sort((a, b) => a.woke - b.woke);
        prune(this._store, this._settings.get_string('retention'));
        saveStore(this._store);
    }

    // Frühere Schlafzyklen aus dem Journal nachtragen (Aufwecker dort unbekannt)
    async _importJournal() {
        const now = Math.floor(Date.now() / 1000);
        const retention = this._settings.get_string('retention');
        const days = retention === 'last-wake' ? 1 : parseInt(retention, 10) || 3;
        const since = Math.max(this._store.journalSync || 0, now - days * 86400);
        const cycles = await readSleepCycles(since);
        if (!this._store)
            return;
        for (const c of cycles)
            this._addWake({slept: c.slept, woke: c.woke, source: null});
        this._store.journalSync = now;
        saveStore(this._store);
        this._render();
    }

    // ---- Anzeige (Designstandard: 3-Zonen-Menü, Kacheln, Sidecar, Aktions-Footer) ----

    _isDark() {
        return this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
    }

    // KEINE 8-stelligen Hex-Farben: St ignoriert sie lautlos. Immer rgba().
    _pal() {
        const dark = this._isDark();
        return {
            dark,
            text: dark ? '#f6f6f6' : '#1a1a1a',
            dim: dark ? '#9a9996' : '#77767b',
            cardBorder: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.16)',
            cardBg: dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.035)',
            green: dark ? '#33d17a' : '#26a269',
            orange: dark ? '#ff7800' : '#e66100',
            red: dark ? '#f66151' : '#c01c28',
            blue: dark ? '#78aeed' : '#1c71d8',
            sideBg: dark ? '#242424' : '#ffffff',
            sideBorder: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)',
        };
    }

    _modeColor(pal, mode) {
        return mode === 'block' ? pal.red : mode === 'block-weak' ? pal.orange : pal.dim;
    }

    // Menü nur neu aufbauen, wenn es offen ist und sich Daten geändert haben (kein Flackern, Sidecar bleibt stehen)
    _render() {
        if (!this._button)
            return;
        const real = this._inhibitors.filter(i => i.who !== OWN_WHO);
        const {state, count} = classify(real, this._keepFd !== null);
        this._dot.style_class = `wakebar-dot wakebar-${state}`;
        this._count.text = count > 0 ? String(count) : '';
        this._state = state;
        if (this._button.menu.isOpen)
            this._rebuildMenu(false);
    }

    _rebuildMenu(force) {
        if (!this._button || !this._store)
            return;
        const real = this._inhibitors.filter(i => i.who !== OWN_WHO);
        const signature = JSON.stringify([real, this._store.blockers.length, this._store.wakes.at(-1), this._keepFd !== null, this._isDark(), this._updateInfo?.remoteVersion ?? 0]);
        if (!force && signature === this._signature)
            return;
        this._signature = signature;

        const menu = this._button.menu;
        menu.removeAll();
        const pal = this._pal();

        // Hinweis auf neue Version (nur wenn die Prüfung eine gefunden hat); Klick öffnet den Reiter „Updates“
        if (this._updateInfo?.updateAvailable) {
            const banner = new PopupMenu.PopupImageMenuItem(
                `Update v${this._updateInfo.remoteVersionName} verfügbar!`, 'software-update-available-symbolic');
            banner.connect('activate', () => this.openPreferences());
            menu.addMenuItem(banner);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Zone 1: Kopf-Kachel
        const wakes = this._store.wakes;
        const last = wakes.at(-1);
        const badge = {
            green: ['Kann schlafen', pal.green], yellow: ['Etwas grübelt', pal.orange],
            red: ['Wird wachgehalten', pal.red], blue: ['Wach halten aktiv', pal.blue],
        }[this._state ?? 'green'];
        const head = this._cardItem(pal);
        const titleRow = this._row(pal, 'computer-symbolic', GLib.get_host_name() || 'Rechner', null, 16);
        titleRow.add_child(new St.Label({text: `{${badge[0]}}`, style: `font-weight: 700; font-size: 11px; color: ${badge[1]};`}));
        head.card.add_child(titleRow);
        head.card.add_child(this._meta(pal, 'preferences-system-time-symbolic', `Letzte Prüfung: ${fmtClock(this._lastCheck)}`));
        head.card.add_child(this._meta(pal, 'weather-clear-symbolic', last
            ? `Zuletzt geweckt: ${fmtTime(last.woke)} – ${last.source ?? 'Ursache unbekannt'}`
            : 'Noch kein Aufwecken protokolliert'));
        menu.addMenuItem(head.item);

        // Zone 2a: Hält gerade wach
        const holding = real.filter(isRelevant);
        const system = real.filter(i => !isRelevant(i));
        const now = this._cardItem(pal);
        now.card.add_child(this._topic(pal, 'weather-clear-night-symbolic', 'Hält gerade wach',
            holding.length ? `{${holding.length}}` : '{Nichts}', holding.length ? this._modeColor(pal, holding[0].mode) : pal.green));
        if (holding.length === 0)
            now.card.add_child(this._plainLine(pal, 'Der Rechner darf schlafen.'));
        for (const i of holding) {
            const since = this._store.blockers.find(b => b.end === null && this._key(b) === this._key(i));
            const row = this._row(pal, iconFor(i), i.who, [`{${MODE[i.mode] ?? i.mode}}`, this._modeColor(pal, i.mode)]);
            this._hover(row, pal, () => this._sidecarInhibitor(pal, i, since?.start));
            now.card.add_child(row);
        }
        const sysRow = this._row(pal, 'computer-symbolic', 'Systemintern', [`{${system.length}}`, pal.dim]);
        this._hover(sysRow, pal, () => this._sidecarList(pal, 'computer-symbolic', 'Systemintern',
            'verzögern nur das Einschlafen oder betreffen Tasten und Deckel', system.map(i => ({
                icon: iconFor(i), title: i.who, tag: `{${MODE[i.mode] ?? i.mode}}`, color: this._modeColor(pal, i.mode),
                ...this._inhibitorLines(i)}))));
        now.card.add_child(sysRow);
        menu.addMenuItem(now.item);

        // Zone 2b: Hielt vom Schlafen ab
        const past = [...this._store.blockers].reverse();
        const pastCard = this._cardItem(pal);
        pastCard.card.add_child(this._topic(pal, 'view-list-symbolic', 'Hielt vom Schlafen ab', `{${past.length}}`, pal.dim));
        if (past.length === 0)
            pastCard.card.add_child(this._plainLine(pal, 'Keine Einträge im gewählten Zeitraum.'));
        const pastEntry = b => {
            const dur = fmtDuration((b.end ?? Math.floor(Date.now() / 1000)) - b.start);
            return {
                icon: iconFor(b), title: b.who, tag: b.end === null ? '{läuft noch}' : `{${dur}}`,
                color: b.end === null ? this._modeColor(pal, b.mode) : pal.dim,
                lines: [`Grund laut Programm: ${b.why}`, `${fmtTime(b.start)} ${b.end === null ? 'bis jetzt' : `bis ${fmtTime(b.end)}`} · ${WHAT[b.what] ?? b.what} · ${MODE[b.mode] ?? b.mode}`],
                notes: [explain(b.who, b.why, b.mode).why],
            };
        };
        for (const b of past.slice(0, BAR_ROWS)) {
            const e = pastEntry(b);
            const row = this._row(pal, e.icon, e.title, [e.tag, e.color]);
            this._hover(row, pal, () => this._sidecarList(pal, 'view-list-symbolic', 'Hielt vom Schlafen ab', e.title, [e]));
            pastCard.card.add_child(row);
        }
        if (past.length > BAR_ROWS) {
            const more = this._row(pal, 'view-more-symbolic', `Alle ${past.length} Einträge`, null);
            this._hover(more, pal, () => this._sidecarList(pal, 'view-list-symbolic', 'Hielt vom Schlafen ab',
                `${past.length} Einträge im gewählten Zeitraum`, past.slice(0, SIDECAR_ROWS).map(pastEntry)));
            pastCard.card.add_child(more);
        }
        menu.addMenuItem(pastCard.item);

        // Zone 2c: Aufwecker
        const wl = [...wakes].reverse();
        const wakeCard = this._cardItem(pal);
        wakeCard.card.add_child(this._topic(pal, 'weather-clear-symbolic', 'Aufwecker', `{${wl.length}}`, pal.dim));
        if (wl.length === 0)
            wakeCard.card.add_child(this._plainLine(pal, 'Keine Einträge im gewählten Zeitraum.'));
        const wakeEntry = w => ({
            icon: 'weather-clear-symbolic', title: w.source ?? 'Ursache unbekannt', tag: `{${fmtTime(w.woke)}}`, color: pal.dim,
            lines: [`Geweckt ${fmtTime(w.woke)}`, `Schlief ab ${fmtTime(w.slept)} · ${fmtDuration(w.woke - w.slept)}`],
        });
        for (const w of wl.slice(0, BAR_ROWS)) {
            const e = wakeEntry(w);
            const row = this._row(pal, e.icon, e.title, [e.tag, e.color]);
            this._hover(row, pal, () => this._sidecarList(pal, 'weather-clear-symbolic', 'Aufwecker', e.title, [e]));
            wakeCard.card.add_child(row);
        }
        if (wl.length > BAR_ROWS) {
            const more = this._row(pal, 'view-more-symbolic', `Alle ${wl.length} Einträge`, null);
            this._hover(more, pal, () => this._sidecarList(pal, 'weather-clear-symbolic', 'Aufwecker',
                `${wl.length} Einträge im gewählten Zeitraum`, wl.slice(0, SIDECAR_ROWS).map(wakeEntry)));
            wakeCard.card.add_child(more);
        }
        menu.addMenuItem(wakeCard.item);

        // Zone 3: Aktions-Footer (native Items, nie Buttons in Kacheln)
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const keepOn = this._keepFd !== null;
        const keepItem = new PopupMenu.PopupImageMenuItem(
            keepOn ? 'Schlaf wieder erlauben' : 'Wach halten', keepOn ? 'view-conceal-symbolic' : 'view-reveal-symbolic');
        keepItem.connect('activate', () => keepOn ? this._stopKeepAwake() : this._startKeepAwake());
        menu.addMenuItem(keepItem);
        const prefsItem = new PopupMenu.PopupImageMenuItem('Einstellungen...', 'preferences-system-symbolic');
        prefsItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(prefsItem);
    }

    // ---- Bausteine ---------------------------------------------------------

    _cardItem(pal) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'wakebar-card-item'});
        const card = new St.BoxLayout({
            style_class: 'wakebar-card-box', vertical: true, x_expand: true,
            style: `border: 1px solid ${pal.cardBorder}; background-color: ${pal.cardBg}; border-radius: 8px; padding: 10px 14px; margin: 4px 6px; min-width: 380px;`,
        });
        item.add_child(card);
        return {item, card};
    }

    _topic(pal, icon, title, badge, badgeColor) {
        const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 2px;'});
        row.add_child(new St.Icon({icon_name: icon, icon_size: 18, style: `margin-right: 8px; color: ${pal.text};`}));
        row.add_child(new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: `font-weight: 800; font-size: 13px; color: ${pal.text};`}));
        row.add_child(new St.Label({text: badge, y_align: Clutter.ActorAlign.CENTER,
            style: `font-weight: 700; font-size: 11px; font-feature-settings: "tnum"; color: ${badgeColor};`}));
        return row;
    }

    // Titelzeile ohne Hover (Kopf-Kachel)
    _row(pal, icon, text, badge, size = 14) {
        const row = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER, reactive: size !== 16, can_focus: false,
            track_hover: size !== 16, x_expand: true, style_class: size !== 16 ? 'wakebar-interactive-row' : '',
        });
        row.add_child(new St.Icon({icon_name: icon, icon_size: size, style: `margin-right: 6px; color: ${pal.text};`}));
        row.add_child(new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: `font-weight: ${size === 16 ? 800 : 600}; font-size: ${size === 16 ? 13 : 12}px; color: ${pal.text};`}));
        if (badge) {
            row.add_child(new St.Label({text: badge[0], y_align: Clutter.ActorAlign.CENTER,
                style: `font-weight: bold; font-size: 11px; font-feature-settings: "tnum"; color: ${badge[1]};`}));
        }
        return row;
    }

    _meta(pal, icon, text) {
        const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style: 'margin-left: 24px; margin-top: 2px;'});
        row.add_child(new St.Icon({icon_name: icon, icon_size: 12, style: `margin-right: 5px; color: ${pal.dim};`}));
        row.add_child(new St.Label({text, style: `font-size: 11px; color: ${pal.dim};`}));
        return row;
    }

    _plainLine(pal, text) {
        return new St.Label({text, style: `font-size: 11px; color: ${pal.dim}; margin-left: 6px; margin-top: 2px; margin-bottom: 2px;`});
    }

    _hover(row, pal, build) {
        row.reactive = true;
        row.track_hover = true;
        row.connect('enter-event', () => {
            this._showSidecar(build, pal, row);
            return Clutter.EVENT_PROPAGATE;
        });
        row.connect('leave-event', () => {
            this._hideSidecar();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ---- Flyover-Sidecar (Popout rechts/links neben dem Dropdown, auf Main.uiGroup) ----

    _getSidecar() {
        if (!this._hoverSidecar) {
            this._hoverSidecar = new St.BoxLayout({vertical: true, style_class: 'wakebar-sidecar', reactive: false, can_focus: false});
            Main.uiGroup.add_child(this._hoverSidecar);
            this._hoverSidecar.hide();
        }
        return this._hoverSidecar;
    }

    _hideSidecar(immediate = false) {
        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }
        if (immediate) {
            this._hoverSidecar?.hide();
            return;
        }
        this._sidecarHideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._hoverSidecar?.hide();
            this._sidecarHideTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _showSidecar(build, pal, target) {
        const menu = this._button?.menu;
        if (!menu?.isOpen)
            return;
        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }
        const sidecar = this._getSidecar();
        sidecar.destroy_all_children();
        sidecar.style = `background-color: ${pal.sideBg}; border: 1px solid ${pal.sideBorder}; border-radius: 12px; padding: 14px 16px; min-width: 400px; max-width: 460px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);`;
        build()(sidecar);
        sidecar.show();

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._hoverSidecar || !this._button?.menu.isOpen || !target.get_stage?.())
                return GLib.SOURCE_REMOVE;
            const [menuX] = menu.actor.get_transformed_position();
            const [menuW] = menu.actor.get_transformed_size();
            const [, targetY] = target.get_transformed_position();
            const monitor = Main.layoutManager.findMonitorForActor(menu.actor) || Main.layoutManager.primaryMonitor;
            const sideW = sidecar.width > 0 ? sidecar.width : 420;
            const sideH = sidecar.height > 0 ? sidecar.height : 240;

            let posX = menuX + menuW + 8;
            if (posX + sideW > monitor.x + monitor.width - 10)
                posX = menuX - sideW - 8;
            posX = Math.max(posX, monitor.x + 8);
            const minY = monitor.y + (Main.panel?.height ?? 32) + 8;
            const maxY = monitor.y + monitor.height - sideH - 12;
            const posY = Math.min(Math.max(targetY - 14, minY), Math.max(minY, maxY));
            sidecar.set_position(Math.round(posX), Math.round(posY));
            Main.uiGroup.set_child_above_sibling(sidecar, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sidecarHeader(sidecar, pal, icon, title, sub) {
        const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Icon({icon_name: icon, icon_size: 18, style: `margin-right: 8px; color: ${pal.text};`}));
        const col = new St.BoxLayout({vertical: true});
        col.add_child(new St.Label({text: title, style: `font-weight: 800; font-size: 13px; color: ${pal.text};`}));
        if (sub)
            col.add_child(new St.Label({text: sub, style: `font-size: 11px; color: ${pal.dim};`}));
        row.add_child(col);
        sidecar.add_child(row);
    }

    _wrapped(text, style) {
        const label = new St.Label({text, style});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = 0;
        return label;
    }

    _sidecarList(pal, icon, title, sub, entries) {
        return sidecar => {
            this._sidecarHeader(sidecar, pal, icon, title, sub);
            const list = new St.BoxLayout({vertical: true, style: 'margin-top: 8px;'});
            if (entries.length === 0)
                list.add_child(new St.Label({text: 'Keine Einträge.', style: `font-size: 11px; color: ${pal.dim};`}));
            for (const e of entries) {
                const head = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style: 'margin-top: 8px;'});
                head.add_child(new St.Icon({icon_name: e.icon, icon_size: 12, style: `margin-right: 6px; color: ${pal.text};`}));
                head.add_child(new St.Label({text: e.title, x_expand: true, style: `font-weight: bold; font-size: 11px; color: ${pal.text};`}));
                head.add_child(new St.Label({text: e.tag, style: `font-weight: bold; font-size: 11px; font-feature-settings: "tnum"; color: ${e.color};`}));
                list.add_child(head);
                for (const l of e.lines.filter(Boolean))
                    list.add_child(this._wrapped(l, `font-size: 11px; color: ${pal.dim}; margin-left: 18px;`));
                for (const n of (e.notes ?? []).filter(Boolean))
                    list.add_child(this._wrapped(n, `font-size: 11px; color: ${pal.text}; margin-left: 18px; margin-top: 3px;`));
            }
            sidecar.add_child(list);
        };
    }

    // Prozess- und Erklärungszeilen für eine Sperre (Programm, Grund laut Programm, Prozess, Bedeutung des Modus)
    _inhibitorLines(i, since) {
        const pid = i.pid || findPid(i.appId);
        const proc = processInfo(pid);
        const lines = [`Grund laut Programm: ${i.why}`, `Betrifft: ${WHAT[i.what] ?? i.what}`];
        if (pid) {
            lines.push(proc
                ? `Prozess: ${proc.cmd} (PID ${pid})${proc.started ? ` – läuft seit ${fmtTime(proc.started)}` : ''}`
                : `Prozess: PID ${pid} (beendet)`);
        }
        if (since)
            lines.push(`Sperre seit: ${fmtTime(since)} (${fmtDuration(Date.now() / 1000 - since)})`);
        const ex = explain(i.who, i.why, i.mode);
        return {lines, notes: [ex.why, ex.mode]};
    }

    _sidecarInhibitor(pal, i, since) {
        const {lines, notes} = this._inhibitorLines(i, since);
        const entry = {icon: iconFor(i), title: i.who, tag: `{${MODE[i.mode] ?? i.mode}}`, color: this._modeColor(pal, i.mode), lines, notes};
        return this._sidecarList(pal, 'weather-clear-night-symbolic', 'Warum hält das den Rechner wach?', null, [entry]);
    }

    // ---- Wach halten -------------------------------------------------------

    // Eigene Sperre: logind Inhibit() liefert einen Dateideskriptor; Schließen gibt die Sperre frei.
    _startKeepAwake() {
        if (this._keepFd !== null)
            return;
        Gio.DBus.system.call_with_unix_fd_list(...LOGIND, 'Inhibit',
            new GLib.Variant('(ssss)', ['sleep:idle', OWN_WHO, 'Wach halten (manuell)', 'block']),
            new GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, -1, null, this._cancellable, (conn, res) => {
                try {
                    const [, fdList] = conn.call_with_unix_fd_list_finish(res);
                    this._keepFd = fdList.get(0);
                    this._render();
                } catch (e) {
                    console.error(`wakebar: Inhibit fehlgeschlagen: ${e.message}`);
                }
            });
    }

    _stopKeepAwake() {
        if (this._keepFd === null)
            return;
        try {
            Gio.UnixInputStream.new(this._keepFd, true).close(null);
        } catch (e) {
            console.error(`wakebar: Freigabe fehlgeschlagen: ${e.message}`);
        }
        this._keepFd = null;
        this._render();
    }
}
