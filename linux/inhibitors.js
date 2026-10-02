import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LOGIND = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];
const SESSION = ['org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager'];
const SESSION_INHIBITOR = 'org.gnome.SessionManager.Inhibitor';
const AGGREGATE_WHY = 'user session inhibited';   // Sammelsperre von gnome-session, ersetzt durch die einzelnen Programme

const FLAG_SUSPEND = 4;
const FLAG_IDLE = 8;

function call(bus, [name, path, iface], method, params, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params, replyType, Gio.DBusCallFlags.NONE, 5000, cancellable, (c, res) => {
            try {
                resolve(c.call_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Anzeigenamen installierter Programme (Gio.AppInfo, einmal gelesen und zwischengespeichert)
let appNames = null;

function appName(appId) {
    if (!appNames) {
        appNames = new Map();
        for (const a of Gio.AppInfo.get_all())
            appNames.set(a.get_id(), a.get_name());
    }
    return appNames.get(appId.endsWith('.desktop') ? appId : `${appId}.desktop`) || appId || 'Unbekannt';
}

// Sperren der GNOME-Sitzung (Browser, Videoplayer, …): [{who, why, what, mode, uid, pid, source}]
async function sessionInhibitors(cancellable) {
    const bus = Gio.DBus.session;
    const [paths] = (await call(bus, SESSION, 'GetInhibitors', null, new GLib.VariantType('(ao)'), cancellable)).deepUnpack();
    const out = [];
    for (const path of paths) {
        try {
            const target = [SESSION[0], path, SESSION_INHIBITOR];
            const [appId] = (await call(bus, target, 'GetAppId', null, new GLib.VariantType('(s)'), cancellable)).deepUnpack();
            const [why] = (await call(bus, target, 'GetReason', null, new GLib.VariantType('(s)'), cancellable)).deepUnpack();
            const [flags] = (await call(bus, target, 'GetFlags', null, new GLib.VariantType('(u)'), cancellable)).deepUnpack();
            let pid = 0;
            try {
                const [clientPath] = (await call(bus, target, 'GetClientId', null, new GLib.VariantType('(o)'), cancellable)).deepUnpack();
                if (clientPath && clientPath !== '/') {
                    const client = [SESSION[0], clientPath, 'org.gnome.SessionManager.Client'];
                    [pid] = (await call(bus, client, 'GetUnixProcessId', null, new GLib.VariantType('(u)'), cancellable)).deepUnpack();
                }
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
            if (!(flags & (FLAG_SUSPEND | FLAG_IDLE)))
                continue;   // nur Logout/Benutzerwechsel/Automount: für Schlaf unerheblich
            out.push({
                who: appName(appId), why: why || '–',
                what: (flags & FLAG_SUSPEND) ? 'sleep' : 'idle',
                mode: (flags & FLAG_SUSPEND) ? 'block' : 'block-weak',
                uid: 0, pid, appId, source: 'session',
            });
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
    }
    return out;
}

// Alle Sperren: logind (System) + GNOME-Sitzung (einzelne Programme). Wirft bei Abbruch (Cancellable).
export async function listInhibitors(cancellable) {
    const reply = await call(Gio.DBus.system, LOGIND, 'ListInhibitors', null, new GLib.VariantType('(a(ssssuu))'), cancellable);
    const [rows] = reply.deepUnpack();
    const list = rows
        .map(([what, who, why, mode, uid, pid]) => ({what, who, why, mode, uid, pid, source: 'logind'}))
        .filter(i => i.why !== AGGREGATE_WHY);
    try {
        list.push(...await sessionInhibitors(cancellable));
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        // SessionManager nicht erreichbar: Sammelsperre wieder einblenden, damit nichts verloren geht
        list.push(...rows
            .filter(r => r[2] === AGGREGATE_WHY)
            .map(([what, who, why, mode, uid, pid]) => ({what, who, why, mode, uid, pid, source: 'logind'})));
    }
    return list;
}

// Ampel: rot = blockierende Sperre auf sleep/idle (flags suspend), gelb = nur Leerlauf/block-weak,
// delay-Sperren (NetworkManager, ModemManager, …) sind normal und zählen nicht.
export const isRelevant = i => /(^|:)(sleep|idle)(:|$)/.test(i.what) && (i.mode === 'block' || i.mode === 'block-weak');

export function classify(inhibitors, keepAwake) {
    const red = inhibitors.filter(i => isRelevant(i) && i.mode === 'block');
    const yellow = inhibitors.filter(i => isRelevant(i) && i.mode === 'block-weak');
    if (keepAwake)
        return {state: 'blue', count: red.length + 1};
    if (red.length)
        return {state: 'red', count: red.length};
    if (yellow.length)
        return {state: 'yellow', count: yellow.length};
    return {state: 'green', count: 0};
}
