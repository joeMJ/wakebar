#!/usr/bin/env bash
# Baut das Popup-Menü außerhalb der GNOME Shell (Platzhalter für St/Clutter/Main/PopupMenu) gegen die echten
# gespeicherten Daten und meldet Laufzeitfehler (z. B. fehlende Methoden), die eine Syntaxprüfung nicht findet.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; L="${HERE}/../linux"
T="$(mktemp -d)"; trap 'rm -rf "${T}"' EXIT
cp "${L}"/{inhibitors,wakelog,store,explain,updater}.js "${HERE}/stub.js" "${T}/"
sed -e "s#import Clutter from 'gi://Clutter';#import {Clutter} from './stub.js';#" -e "s#import St from 'gi://St';#import {St} from './stub.js';#" \
    -e "s#import {Extension} from 'resource:[^']*';#import {Extension} from './stub.js';#" \
    -e "s#import \* as Main from 'resource:[^']*';#import {Main} from './stub.js';#" \
    -e "s#import \* as PanelMenu from 'resource:[^']*';#import {PanelMenu} from './stub.js';#" \
    -e "s#import \* as PopupMenu from 'resource:[^']*';#import {PopupMenu} from './stub.js';#" "${L}/extension.js" > "${T}/ext.js"
cat > "${T}/run.mjs" <<'JS'
import Ext from './ext.js';
import {menu} from './stub.js';
import {loadStore} from './store.js';
let rc = 0;
try {
    const e = new Ext();
    e._settings = e.getSettings(); e._store = loadStore(); e._interfaceSettings = null; e._lastCheck = Math.floor(Date.now() / 1000); e._keepFd = null;
    e._inhibitors = [{who: '/usr/bin/example', why: 'Test', what: 'sleep', mode: 'block', pid: 0, appId: '/usr/bin/example'},
                     {who: 'NetworkManager', why: 'turn off', what: 'sleep', mode: 'delay', pid: 1}];
    e._updateInfo = {updateAvailable: true, remoteVersionName: '9.9', remoteVersion: 9};
    e._button = {menu, destroy() {}}; e._dot = {}; e._count = {}; e._idleIcon = {}; e._state = 'red'; e._signature = '';
    e._rebuildMenu(true); e._render();
    print(`OK: Menü gebaut (${menu.items.length} Einträge)`);
} catch (err) { print(`FEHLER: ${err.message}\n${err.stack}`); rc = 1; }
imports.system.exit(rc);
JS
gjs -m "${T}/run.mjs"
