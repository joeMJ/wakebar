import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Kleiner JSON-Puffer unter ~/.local/state/wakebar/history.json (Sperren- und Aufwecker-Protokoll).
const EMPTY = () => ({version: 1, savedAt: 0, journalSync: 0, blockers: [], wakes: []});

export function statePath() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'wakebar', 'history.json']);
}

export function loadStore(path = statePath()) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return EMPTY();
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return {...EMPTY(), ...data};
    } catch (_e) {
        return EMPTY();
    }
}

export function saveStore(data, path = statePath()) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        data.savedAt = Math.floor(Date.now() / 1000);
        Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(JSON.stringify(data)), null, false, Gio.FileCreateFlags.PRIVATE, null);
    } catch (e) {
        console.error(`wakebar: Protokoll nicht gespeichert: ${e.message}`);
    }
}

// Aufbewahrung: 'last-wake' | '1d' | '3d' | '7d' | '14d' (+ feste Obergrenze)
export const MAX_ENTRIES = 500;

export function prune(data, retention, nowSec = Math.floor(Date.now() / 1000)) {
    let cutoff;
    if (retention === 'last-wake') {
        const last = data.wakes.reduce((m, w) => Math.max(m, w.woke), 0);
        cutoff = last || nowSec - 86400;
    } else {
        const days = parseInt(retention, 10) || 3;
        cutoff = nowSec - days * 86400;
    }
    data.blockers = data.blockers.filter(b => b.end === null || b.end >= cutoff).slice(-MAX_ENTRIES);
    data.wakes = data.wakes
        .filter(w => w.woke >= cutoff || (retention === 'last-wake' && w.woke === cutoff))
        .slice(-MAX_ENTRIES);
    return data;
}
