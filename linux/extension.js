import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const LOGIND = {name: 'org.freedesktop.login1', path: '/org/freedesktop/login1', iface: 'org.freedesktop.login1.Manager'};
const OWN_WHO = 'wakebar';

// Ampel-Zustand aus der logind-Inhibitor-Liste ableiten.
// rot: blockierende Sperre auf sleep/idle; gelb: block-weak auf sleep/idle;
// delay-Sperren (NetworkManager, ModemManager, …) sind normal und zählen nicht.
function classify(inhibitors, keepAwake) {
    const relevant = i => /(^|:)(sleep|idle)(:|$)/.test(i.what);
    const red = inhibitors.filter(i => relevant(i) && i.mode === 'block');
    const yellow = inhibitors.filter(i => relevant(i) && i.mode === 'block-weak');
    if (keepAwake)
        return {state: 'blue', count: red.length + 1};
    if (red.length)
        return {state: 'red', count: red.length};
    if (yellow.length)
        return {state: 'yellow', count: yellow.length};
    return {state: 'green', count: 0};
}

export default class WakeBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._inhibitors = [];
        this._keepFd = null;
        this._cancellable = new Gio.Cancellable();

        this._button = new PanelMenu.Button(0.5, 'wakebar', false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._dot = new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER, style_class: 'wakebar-dot wakebar-green'});
        this._count = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'wakebar-count'});
        box.add_child(this._dot);
        box.add_child(this._count);
        this._button.add_child(box);

        this._keepItem = new PopupMenu.PopupSwitchMenuItem('Wach halten', false);
        this._keepItem.connect('toggled', (_i, on) => on ? this._startKeepAwake() : this._stopKeepAwake());
        this._button.menu.addMenuItem(this._keepItem);
        this._listSection = new PopupMenu.PopupMenuSection();
        this._button.menu.addMenuItem(this._listSection);

        const pos = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea('wakebar@johnlose.de', this._button, 0, pos);

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
        this._button?.destroy();
        this._button = null;
        this._settings = null;
    }

    _bus() {
        return Gio.DBus.system;
    }

    // logind ListInhibitors → a(ssssuu) = (what, who, why, mode, uid, pid) – asynchron, blockiert die Shell nie
    _refresh() {
        this._bus().call(LOGIND.name, LOGIND.path, LOGIND.iface, 'ListInhibitors', null,
            new GLib.VariantType('(a(ssssuu))'), Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [rows] = conn.call_finish(res).deepUnpack();
                    const ignored = this._settings.get_strv('ignored-programs');
                    this._inhibitors = rows
                        .map(([what, who, why, mode, uid, pid]) => ({what, who, why, mode, uid, pid}))
                        .filter(i => !ignored.includes(i.who));
                    this._render();
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`wakebar: ListInhibitors fehlgeschlagen: ${e.message}`);
                }
            });
    }

    _render() {
        if (!this._button)
            return;
        const others = this._inhibitors.filter(i => i.who !== OWN_WHO);
        const {state, count} = classify(this._inhibitors, this._keepFd !== null);
        this._dot.style_class = `wakebar-dot wakebar-${state}`;
        this._count.text = count > 0 ? String(count) : '';

        this._listSection.removeAll();
        const blocking = others.filter(i => i.mode !== 'delay');
        const delaying = others.filter(i => i.mode === 'delay');
        this._addGroup('Hält wach', blocking, 'Nichts hält den Rechner wach.');
        this._addGroup('Verzögert nur das Einschlafen', delaying, null);
    }

    _addGroup(title, items, emptyText) {
        if (items.length === 0 && !emptyText)
            return;
        this._listSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
        if (items.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(emptyText, {reactive: false}));
            return;
        }
        for (const i of items) {
            const card = new St.BoxLayout({vertical: true, style_class: 'wakebar-card'});
            card.add_child(new St.Label({text: i.who, style_class: 'wakebar-card-title'}));
            card.add_child(new St.Label({text: `${i.why}`, style_class: 'wakebar-card-detail'}));
            card.add_child(new St.Label({text: `${i.what} · ${i.mode} · PID ${i.pid}`, style_class: 'wakebar-card-detail'}));
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            item.add_child(card);
            this._listSection.addMenuItem(item);
        }
    }

    // Eigene Sperre: logind Inhibit() liefert einen Dateideskriptor; Schließen gibt die Sperre frei.
    _startKeepAwake() {
        if (this._keepFd !== null)
            return;
        this._bus().call_with_unix_fd_list(LOGIND.name, LOGIND.path, LOGIND.iface, 'Inhibit',
            new GLib.Variant('(ssss)', ['sleep:idle', OWN_WHO, 'Wach halten (manuell)', 'block']),
            new GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, -1, null, this._cancellable, (conn, res) => {
                try {
                    const [, fdList] = conn.call_with_unix_fd_list_finish(res);
                    this._keepFd = fdList.get(0);
                    this._render();
                    this._refresh();
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
        this._refresh();
    }
}
