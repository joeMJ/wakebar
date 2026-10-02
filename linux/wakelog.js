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

export function diffWakeCounts(before, after) {
    const hits = [];
    for (const [id, cur] of after) {
        const prev = before.get(id);
        if (prev && cur.count > prev.count && !hits.includes(cur.label))
            hits.push(cur.label);
    }
    return hits;
}

// Schlaf-/Aufwachzeiten aus dem Kernel-Journal (asynchron, blockiert die Shell nicht).
// Liefert [{slept, woke}] in Unix-Sekunden, für Zeiten ab sinceSec.
export async function readSleepCycles(sinceSec) {
    const proc = Gio.Subprocess.new(
        ['journalctl', '_TRANSPORT=kernel', '-o', 'json', '--no-pager', '--since', `@${Math.max(0, Math.floor(sinceSec))}`,
            '-g', 'PM: suspend (entry|exit)'],
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
    const cycles = [];
    let slept = null;
    for (const line of stdout.split('\n')) {
        if (!line)
            continue;
        let e;
        try {
            e = JSON.parse(line);
        } catch (_err) {
            continue;
        }
        const msg = typeof e.MESSAGE === 'string' ? e.MESSAGE : '';
        const ts = Math.floor(Number(e.__REALTIME_TIMESTAMP) / 1e6);
        if (/PM: suspend entry/.test(msg)) {
            slept = ts;
        } else if (/PM: suspend exit/.test(msg)) {
            cycles.push({slept: slept ?? ts, woke: ts});
            slept = null;
        }
    }
    return cycles;
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
