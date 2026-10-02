import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Verständliche Erklärungen, warum ein Programm den Schlaf sperrt – bekannte Fälle per Muster,
// sonst allgemeine Hinweise zum Modus. Reine Textlogik, keine Systemzugriffe.
const RULES = [
    [/claude/i, null, 'Claude Desktop (Electron-App) verhindert den Energiespar-Modus, solange eine Sitzung oder Aufgabe läuft. Die Sperre endet, wenn die App sie freigibt oder beendet wird.'],
    [/^mutter$/i, /idle/i, 'Der GNOME-Compositor sperrt den Leerlauf, wenn ein Programm es anfordert – etwa bei Vollbild, Präsentation oder Bildschirmfreigabe.'],
    [/firefox|chrom|thorium|brave|vivaldi|epiphany/i, /audio|ton|wiedergabe/i, 'Der Browser spielt gerade Ton ab. Das verhindert automatische Bildschirm-Abschaltung und automatischen Schlaf; manuelles Schlafenlegen bleibt möglich.'],
    [/firefox|chrom|thorium|brave|vivaldi|epiphany/i, /video/i, 'Der Browser spielt ein Video ab. Das verhindert automatische Bildschirm-Abschaltung und automatischen Schlaf, bis das Video pausiert oder der Tab geschlossen wird.'],
    [null, /external monitor attached/i, 'Beim Zuklappen des Deckels schläft der Rechner nicht ein, weil kürzlich ein externer Monitor angeschlossen oder verändert wurde. Betrifft nur den Deckel, nicht den normalen Schlaf.'],
    [null, /handling keypresses/i, 'GNOME wertet Netz-, Schlaf- und Ruhezustand-Tasten selbst aus. Das ist kein Wachhalter.'],
    [/networkmanager/i, null, 'Schaltet vor dem Schlaf die Netzwerke ordentlich ab. Verzögert den Schlaf nur Sekunden.'],
    [/modemmanager/i, null, 'Setzt Mobilfunk-Modems vor dem Schlaf zurück. Verzögert den Schlaf nur kurz.'],
    [/upower/i, null, 'Pausiert vor dem Schlaf die Geräteabfrage (Akku, Peripherie). Verzögert nur kurz.'],
    [/realtime kit|rtkit/i, null, 'Nimmt vor dem Schlaf Echtzeit-Prioritäten zurück. Verzögert nur kurz.'],
    [/unattended/i, null, 'Lässt laufende automatische Updates sauber zu Ende laufen, bevor heruntergefahren wird.'],
    [/gnome shell/i, /sperren|lock/i, 'GNOME sperrt vor dem Schlaf den Bildschirm. Verzögert nur, bis die Sperre steht.'],
    [/gnome shell/i, /bildschirmzeit|screen time/i, 'GNOME speichert vor dem Schlaf die Bildschirmzeit-Daten. Verzögert nur kurz.'],
    [null, /needs to lock the screen/i, 'GNOME sperrt vor dem Schlaf den Bildschirm. Verzögert nur, bis die Sperre steht.'],
];

const MODE_TEXT = {
    block: 'Blockiert: Der Rechner geht nicht schlafen, bis das Programm die Sperre freigibt.',
    'block-weak': 'Bremst: Verhindert nur den automatischen Schlaf und die Bildschirm-Abschaltung bei Inaktivität; manuelles Schlafenlegen bleibt möglich.',
    delay: 'Verzögert: Das Programm bekommt kurz Zeit zum Aufräumen, danach schläft der Rechner trotzdem ein.',
};

export function explain(who, why, mode) {
    for (const [wRe, yRe, text] of RULES) {
        if ((!wRe || wRe.test(who ?? '')) && (!yRe || yRe.test(why ?? '')))
            return {why: text, mode: MODE_TEXT[mode] ?? null};
    }
    return {why: null, mode: MODE_TEXT[mode] ?? null};
}

function read(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_e) {
        return '';
    }
}

// Prozessinfo aus /proc: Befehlszeile und Startzeit (Unix-Sekunden). Null, wenn der Prozess nicht (mehr) existiert.
export function processInfo(pid) {
    if (!pid)
        return null;
    const cmdline = read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' ');
    if (!cmdline)
        return null;
    let started = null;
    const stat = read(`/proc/${pid}/stat`);
    const btime = parseInt((read('/proc/stat').match(/^btime (\d+)/m) ?? [])[1], 10);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // ab Feld 3 (state)
    const ticks = parseInt(fields[19], 10);                            // Feld 22: starttime
    if (!Number.isNaN(ticks) && !Number.isNaN(btime))
        started = btime + Math.floor(ticks / 100);
    return {cmd: cmdline.length > 110 ? `${cmdline.slice(0, 107)}…` : cmdline, started};
}

// Sitzungs-Sperren melden oft keine PID: Prozess anhand der App-Kennung suchen (Pfad oder Programmname).
// Nur beim Überfahren aufgerufen, daher ist der /proc-Durchlauf unkritisch.
export function findPid(appId) {
    if (!appId)
        return 0;
    const wantPath = appId.startsWith('/') ? appId : null;
    const ALIAS = {mutter: 'gnome-shell'};   // der Compositor läuft im gnome-shell-Prozess
    let wantComm = (appId.split('/').pop() ?? '').replace(/\.desktop$/, '').split('.').pop().toLowerCase();
    wantComm = ALIAS[wantComm] ?? wantComm;
    let best = 0;
    try {
        const dir = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = dir.next_file(null)) !== null) {
            const pid = parseInt(info.get_name(), 10);
            if (!pid)
                continue;
            const first = read(`/proc/${pid}/cmdline`).split('\0')[0];
            const comm = read(`/proc/${pid}/comm`).trim().toLowerCase();
            const hit = (wantPath && first === wantPath) || (wantComm && comm === wantComm.slice(0, 15));
            if (hit && (best === 0 || pid < best))
                best = pid;
        }
    } catch (_e) { /* /proc nicht lesbar */ }
    return best;
}
