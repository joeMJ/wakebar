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

const LOGIND = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];
const OWN_WHO = 'wakebar';
const SAVE_EVERY_SEC = 60;

const WHAT = {sleep: 'Schlaf', idle: 'Leerlauf', shutdown: 'Herunterfahren', 'sleep:idle': 'Schlaf und Leerlauf'};
const MODE = {block: 'blockiert', 'block-weak': 'bremst', delay: 'verzögert'};
const MODE_COLOR = {block: '#e01b24', 'block-weak': '#f5c211', delay: '#77767b'};
const iconFor = i => (i.mode === 'delay' || !/sleep|idle/.test(i.what)) ? 'computer-symbolic'
    : /idle/.test(i.what) && !/sleep/.test(i.what) ? 'video-display-symbolic' : 'system-suspend-symbolic';

const fmtTime = sec => GLib.DateTime.new_from_unix_local(sec).format('%d.%m. %H:%M');
const fmtDuration = sec => {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

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
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._schemeId = this._interfaceSettings.connect('changed::color-scheme', () => this._render());
        } catch (_e) {
            this._interfaceSettings = null;
        }

        this._buildPanel();
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
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stopKeepAwake();
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

        const menu = this._button.menu;
        this._keepItem = new PopupMenu.PopupSwitchMenuItem('Wach halten', false);
        this._keepItem.connect('toggled', (_i, on) => on ? this._startKeepAwake() : this._stopKeepAwake());
        menu.addMenuItem(this._keepItem);
        this._lastWakeItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._lastWakeItem.label.style = 'font-size: 0.9em;';
        menu.addMenuItem(this._lastWakeItem);
        this._nowSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._nowSection);
        this._systemMenu = new PopupMenu.PopupSubMenuMenuItem('Systemintern');
        menu.addMenuItem(this._systemMenu);
        this._pastMenu = new PopupMenu.PopupSubMenuMenuItem('Hielt vom Schlafen ab');
        menu.addMenuItem(this._pastMenu);
        this._wakeMenu = new PopupMenu.PopupSubMenuMenuItem('Aufwecker');
        menu.addMenuItem(this._wakeMenu);

        Main.panel.addToStatusArea('wakebar@johnlose.de', this._button, 0, this._settings.get_string('panel-position'));
    }

    // ---- Datenerfassung -------------------------------------------------

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

    // ---- Anzeige -----------------------------------------------------------

    // Farben nach Designstandard (snmpbar): Hell/Dunkel über GNOME-Interface-Einstellung
    _palette() {
        const dark = this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
        return dark
            ? {text: '#f6f6f6', dim: '#9a9996', border: '#ffffff25', bg: '#00000000'}
            : {text: '#1a1a1a', dim: '#77767b', border: '#5e5c64ff', bg: '#00000000'};
    }

    _render() {
        if (!this._button)
            return;
        const {state, count} = classify(this._inhibitors.filter(i => i.who !== OWN_WHO), this._keepFd !== null);
        this._dot.style_class = `wakebar-dot wakebar-${state}`;
        this._count.text = count > 0 ? String(count) : '';

        const pal = this._palette();
        const others = this._inhibitors.filter(i => i.who !== OWN_WHO);
        const wakes = this._store.wakes;
        const last = wakes.at(-1);
        this._lastWakeItem.label.text = last
            ? `Zuletzt geweckt: ${fmtTime(last.woke)} – ${last.source ?? 'Ursache unbekannt'}`
            : 'Noch kein Aufwecken protokolliert';

        // Aktuell: nur Sperren auf Schlaf/Leerlauf halten wach; der Rest ist Systemintern
        this._nowSection.removeAll();
        const holding = others.filter(isRelevant);
        const system = others.filter(i => !isRelevant(i));
        this._nowSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Hält gerade wach'));
        if (holding.length === 0)
            this._nowSection.addMenuItem(this._plain('Nichts hält den Rechner wach.', pal));
        for (const i of holding)
            this._nowSection.addMenuItem(this._card(i.who, i.why, this._detail(i), pal, {tag: i.mode, icon: iconFor(i)}));

        this._systemMenu.label.text = `Systemintern (${system.length})`;
        this._systemMenu.menu.removeAll();
        for (const i of system)
            this._systemMenu.menu.addMenuItem(this._card(i.who, i.why, this._detail(i), pal, {tag: i.mode, icon: iconFor(i)}));

        // Protokoll: Sperren
        const past = [...this._store.blockers].reverse();
        this._pastMenu.label.text = `Hielt vom Schlafen ab (${past.length})`;
        this._pastMenu.menu.removeAll();
        if (past.length === 0)
            this._pastMenu.menu.addMenuItem(this._plain('Keine Einträge', pal));
        for (const b of past.slice(0, 50)) {
            const until = b.end === null ? 'läuft noch' : `bis ${fmtTime(b.end)}`;
            const dur = fmtDuration((b.end ?? Math.floor(Date.now() / 1000)) - b.start);
            this._pastMenu.menu.addMenuItem(this._card(b.who, b.why,
                `${fmtTime(b.start)} ${until} · ${dur} · ${WHAT[b.what] ?? b.what}`, pal, {tag: b.mode, icon: iconFor(b)}));
        }

        // Protokoll: Aufwecker
        const wl = [...wakes].reverse();
        this._wakeMenu.label.text = `Aufwecker (${wl.length})`;
        this._wakeMenu.menu.removeAll();
        if (wl.length === 0)
            this._wakeMenu.menu.addMenuItem(this._plain('Keine Einträge', pal));
        for (const w of wl.slice(0, 50)) {
            this._wakeMenu.menu.addMenuItem(this._card(
                w.source ?? 'Ursache unbekannt', `Geweckt ${fmtTime(w.woke)}`,
                `Schlief ab ${fmtTime(w.slept)} · ${fmtDuration(w.woke - w.slept)}`, pal,
                {icon: 'preferences-system-time-symbolic'}));
        }
    }

    _detail(i) {
        return `${WHAT[i.what] ?? i.what}${i.pid ? ` · PID ${i.pid}` : ''}`;
    }

    _plain(text, pal) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(new St.Label({text, style: `color: ${pal.dim}; font-size: 0.9em;`}));
        return item;
    }

    // Karte im snmpbar-Look: 8 px Radius, 1 px Rand, Titel 700, Zusatzzeilen gedimmt, Status in {geschweiften Klammern}
    _card(title, detail, extra, pal, {tag = null, icon = null} = {}) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.style = 'padding: 0; min-height: 0;';
        const card = new St.BoxLayout({
            style_class: 'wakebar-card', vertical: true, x_expand: true,
            style: `border: 1px solid ${pal.border}; background-color: ${pal.bg};`,
        });
        const row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        if (icon)
            row.add_child(new St.Icon({icon_name: icon, icon_size: 16, style: `margin-right: 8px; color: ${pal.text};`}));
        row.add_child(new St.Label({text: title, x_expand: true, style: `font-weight: 700; font-size: 0.95em; color: ${pal.text};`}));
        if (tag) {
            row.add_child(new St.Label({
                text: `{${MODE[tag] ?? tag}}`, y_align: Clutter.ActorAlign.CENTER,
                style: `font-weight: 600; font-size: 0.85em; color: ${MODE_COLOR[tag] ?? pal.dim};`,
            }));
        }
        card.add_child(row);
        for (const line of [detail, extra]) {
            if (line) {
                card.add_child(new St.Label({
                    text: line,
                    style: `font-size: 0.82em; color: ${pal.dim}; font-feature-settings: "tnum"; margin-left: ${icon ? 24 : 0}px;`,
                }));
            }
        }
        item.add_child(card);
        return item;
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
                    this._keepItem?.setToggleState(false);
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
        this._keepItem?.setToggleState(false);
        this._render();
    }
}
