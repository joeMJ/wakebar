import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const WAKEUP_DIR = '/sys/class/wakeup';

// Verständliche Namen für häufige ACPI-/Plattform-Quellen
const FRIENDLY = {
    'PNP0C0C': 'Netzschalter', 'LNXPWRBN': 'Netzschalter',
    'PNP0C0D': 'Gehäusedeckel', 'PNP0C0E': 'Ruhezustand-Taste',
    'PNP0C0A': 'Akku', 'PNP0A08': 'PCI-Bus',
    'LNXTHERM': 'Temperatursensor', 'LNXVIDEO': 'Grafik',
};

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch (_e) {
        return '';
    }
}

function friendlyLabel(dir, name) {
    const id = name.split(':')[0];
    if (FRIENDLY[id])
        return FRIENDLY[id];
    // USB-/PCI-Geräte: Produktname aus dem Gerätebaum, sonst der rohe Name
    for (const rel of ['device/product', 'device/../product', 'device/device/product']) {
        const p = readText(`${dir}/${rel}`);
        if (p)
            return p;
    }
    return name;
}

// Zählerstände aller Aufwachquellen: Map<Quellen-ID, {count, label}>.
// Zwischen zwei Abfragen gestiegene Zähler verraten, wer den Rechner geweckt hat.
export function readWakeCounts() {
    const out = new Map();
    let dir;
    try {
        dir = Gio.File.new_for_path(WAKEUP_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return out;
    }
    let info;
    while ((info = dir.next_file(null)) !== null) {
        const id = info.get_name();
        const base = `${WAKEUP_DIR}/${id}`;
        const name = readText(`${base}/name`);
        const count = parseInt(readText(`${base}/event_count`), 10);
        if (!name || Number.isNaN(count))
            continue;
        out.set(id, {count, label: friendlyLabel(base, name)});
    }
    return out;
}

// Messprotokoll: alle Zähler, die sich verändert haben („PNP0C0C:00 [Netzschalter] 3→4“), für die Fehlersuche im Sidecar
export function describeDiff(before, after, btnBefore, btnAfter) {
    const out = [];
    for (const [id, cur] of after) {
        const prev = before.get(id);
        if (prev && cur.count !== prev.count)
            out.push(`${id} ${cur.label}: ${prev.count}→${cur.count}`);
    }
    if (btnBefore !== null && btnAfter !== null && btnBefore !== btnAfter)
        out.push(`ACPI ff_pwr_btn: ${btnBefore}→${btnAfter}`);
    return out;
}

// ACPI-Festereignis „Netzschalter“: zählt jeden Druck, auch den, der den Rechner aus S3 weckt
export function readPowerButtonCount() {
    const n = parseInt(readText('/sys/firmware/acpi/interrupts/ff_pwr_btn'), 10);
    return Number.isNaN(n) ? null : n;
}

export function diffWakeCounts(before, after) {
    const hits = [];
    for (const [id, cur] of after) {
        const prev = before.get(id);
        if (prev && cur.count > prev.count && !hits.includes(cur.label))
            hits.push(cur.label);
    }
    return hits;
}

// journalctl asynchron als Unterprozess (blockiert die Shell nie); liefert die JSON-Zeilen als Objekte
async function runJournal(args) {
    const proc = Gio.Subprocess.new(['journalctl', '-o', 'json', '--no-pager', ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const stdout = await new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                resolve(p.communicate_utf8_finish(res)[1] ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
    const out = [];
    for (const line of stdout.split('\n')) {
        if (!line)
            continue;
        try {
            out.push(JSON.parse(line));
        } catch (_e) { /* defekte Zeile überspringen */ }
    }
    return out;
}

const msgOf = e => (typeof e.MESSAGE === 'string' ? e.MESSAGE : '');
const tsOf = e => Math.floor(Number(e.__REALTIME_TIMESTAMP) / 1e6);

// Schlaf-/Aufwachzeiten aus dem Kernel-Journal (alle Boots).
// Liefert [{slept, woke}] in Unix-Sekunden, für Zeiten ab sinceSec.
export async function readSleepCycles(sinceSec) {
    const entries = await runJournal(['_TRANSPORT=kernel', '--since', `@${Math.max(0, Math.floor(sinceSec))}`,
        '-g', 'PM: suspend (entry|exit)']);
    const cycles = [];
    let slept = null;
    for (const e of entries) {
        const msg = msgOf(e);
        const ts = tsOf(e);
        if (/PM: suspend entry/.test(msg)) {
            slept = ts;
        } else if (/PM: suspend exit/.test(msg)) {
            cycles.push({slept: slept ?? ts, woke: ts});
            slept = null;
        }
    }
    return cycles;
}

// Kernel meldet auf vielen Rechnern (auch hier) keine Aufweckquelle. Darum in zwei Stufen:
//  1. Belegt: logind meldet kurz nach dem Aufwachen Netzschalter bzw. Deckel.
//  2. Vermutet: kein solches Ereignis → ein Eingabegerät (Tastatur/Maus per USB) hat geweckt.
// (Die xHCI-Meldung „error in resume … Reinit“ taucht bei jedem S3-Aufwachen auf und sagt nichts über die Ursache.)
export const INFERRED_SOURCE = 'Tastatur/Maus (vermutet)';

export async function inferWakeCause(wokeSec) {
    const entries = await runJournal(['--since', `@${wokeSec - 2}`, '--until', `@${wokeSec + 6}`, '-g', 'Power key|Lid (opened|closed)|Suspend key|Hibernate key']);
    for (const e of entries) {
        const msg = msgOf(e);
        if (/Lid opened/.test(msg))
            return {source: 'Gehäusedeckel', inferred: false};
        if (/(Power|Suspend|Hibernate) key pressed/.test(msg))
            return {source: 'Netzschalter', inferred: false};
    }
    return {source: INFERRED_SOURCE, inferred: true};
}

// Merkt sich zwischen zwei Abfragen, ob der Rechner geschlafen hat:
// CLOCK_REALTIME läuft im Schlaf weiter, CLOCK_MONOTONIC nicht.
export class ResumeDetector {
    constructor() {
        this._wall = Date.now() / 1000;
        this._mono = GLib.get_monotonic_time() / 1e6;
    }

    // true, wenn seit dem letzten Aufruf geschlafen wurde; liefert {from, to} in Unix-Sekunden
    check() {
        const wall = Date.now() / 1000;
        const mono = GLib.get_monotonic_time() / 1e6;
        const slept = (wall - this._wall) - (mono - this._mono);
        const from = this._wall;
        this._wall = wall;
        this._mono = mono;
        return slept > 20 ? {from: Math.floor(from), to: Math.floor(wall), seconds: Math.round(slept)} : null;
    }
}
