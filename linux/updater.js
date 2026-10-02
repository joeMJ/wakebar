/**
 * updater.js - Versionsabgleich gegen die metadata.json auf GitHub und Update-Start im Terminal.
 * Prüfung nach dem Muster von dwdbar/snmpbar; wird von extension.js (Hinweis im Menü) und prefs.js (Reiter „Updates“) genutzt.
 */
import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const REPO_URL = 'https://github.com/joeMJ/wakebar';
export const RAW_METADATA_URL = 'https://raw.githubusercontent.com/joeMJ/wakebar/main/linux/metadata.json';
export const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh | bash';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (_e) {
    // bereits promisified
}

export class UpdateChecker {
    constructor(currentVersion = 1) {
        this._currentVersion = Number(currentVersion) || 1;
        this._session = new Soup.Session({timeout: 8});
    }

    destroy() {
        try {
            this._session?.abort();
        } catch (_e) { /* ignorieren */ }
        this._session = null;
    }

    /**
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<{updateAvailable: boolean, currentVersion: number, remoteVersion: number|null,
     *                    remoteVersionName?: string, notPublished?: boolean, error: string|null}>}
     */
    async checkForUpdates(cancellable = null) {
        const fail = (error, extra = {}) => ({
            updateAvailable: false, currentVersion: this._currentVersion, remoteVersion: null, error, ...extra,
        });
        try {
            const message = Soup.Message.new('GET', RAW_METADATA_URL);
            message.request_headers.append('Cache-Control', 'no-cache');

            const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            const status = message.get_status();
            if (status === Soup.Status.NOT_FOUND)
                return fail('Noch keine veröffentlichte Version auf GitHub', {notPublished: true});
            if (status !== Soup.Status.OK)
                return fail(`HTTP ${status}`);

            const remote = JSON.parse(new TextDecoder('utf-8').decode(bytes.toArray()));
            const remoteVersion = Number(remote.version || 0);
            return {
                updateAvailable: remoteVersion > this._currentVersion,
                currentVersion: this._currentVersion,
                remoteVersion,
                remoteVersionName: String(remote['version-name'] || remoteVersion),
                error: null,
            };
        } catch (e) {
            if (!cancellable || !cancellable.is_cancelled())
                console.warn(`[wakebar] Update-Prüfung fehlgeschlagen: ${e.message}`);
            return fail(e.message);
        }
    }
}

/**
 * Startet einen Befehl in einem Terminalfenster (bevorzugt das Standard-Terminal
 * über xdg-terminal-exec, sonst Ptyxis, GNOME Terminal, x-terminal-emulator).
 * @param {string} command - Shell-Befehl für bash -c
 * @returns {string|null} Fehlermeldung oder null bei Erfolg
 */
export function launchInTerminal(command) {
    const candidates = [
        ['xdg-terminal-exec', []],
        ['ptyxis', ['--']],
        ['gnome-terminal', ['--']],
        ['x-terminal-emulator', ['-e']],
    ];
    for (const [program, prefix] of candidates) {
        const path = GLib.find_program_in_path(program);
        if (!path)
            continue;
        try {
            Gio.Subprocess.new([path, ...prefix, 'bash', '-c', command], Gio.SubprocessFlags.NONE);
            return null;
        } catch (e) {
            console.warn(`[wakebar] ${program} konnte nicht gestartet werden: ${e.message}`);
        }
    }
    return 'Kein Terminal gefunden';
}
