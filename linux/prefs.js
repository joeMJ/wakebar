import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {UpdateChecker, INSTALL_COMMAND, REPO_URL, launchInTerminal} from './updater.js';

const RETENTION = [['last-wake', 'Seit letztem Aufwachen'], ['1d', '1 Tag'], ['3d', '3 Tage'], ['7d', '7 Tage'], ['14d', '14 Tage']];
const POSITIONS = [['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts']];

export default class WakeBarPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Allgemein', icon_name: 'preferences-system-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Anzeige und Protokoll'});

        group.add(this._combo(settings, 'retention', 'Aufbewahrung des Protokolls', RETENTION));
        group.add(this._combo(settings, 'panel-position', 'Position in der Leiste', POSITIONS));

        const interval = new Adw.SpinRow({
            title: 'Abfrageintervall (Sekunden)',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 60, step_increment: 1, value: settings.get_uint('refresh-interval')}),
        });
        interval.connect('notify::value', r => settings.set_uint('refresh-interval', r.value));
        group.add(interval);

        page.add(group);
        window.add(page);
        this._addUpdatePage(window, settings);
    }

    _addUpdatePage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Updates', icon_name: 'software-update-available-symbolic', name: 'updates'});
        window.add(page);
        const group = new Adw.PreferencesGroup({
            title: 'Aktualitätsprüfung',
            description: `Versionsabgleich über GitHub (${REPO_URL.replace('https://', '')})`,
        });
        page.add(group);

        const enableRow = new Adw.SwitchRow({
            title: 'Automatische Versionsprüfung',
            subtitle: 'Ruft regelmäßig die metadata.json auf GitHub ab und zeigt im Menü einen Hinweis bei neuer Version',
        });
        settings.bind('update-check-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enableRow);

        const installedVersion = Number(this.metadata.version) || 1;
        const installedName = this.metadata['version-name'] ?? String(installedVersion);
        const versionRow = new Adw.ActionRow({title: `Installierte Version: v${installedName}`, subtitle: 'Noch nicht geprüft'});
        const checkBtn = new Gtk.Button({label: 'Jetzt prüfen', valign: Gtk.Align.CENTER});
        versionRow.add_suffix(checkBtn);
        group.add(versionRow);

        const installRow = new Adw.ActionRow({title: 'Update installieren', subtitle: INSTALL_COMMAND, subtitle_selectable: true});
        const installBtn = new Gtk.Button({
            label: 'Jetzt aktualisieren', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'], sensitive: false,
        });
        installBtn.connect('clicked', () => {
            const error = launchInTerminal(
                `${INSTALL_COMMAND}; echo; read -r -p 'Fertig – danach ab- und wieder anmelden. Enter schließt das Fenster.'`);
            if (error)
                installRow.subtitle = `${error} – bitte manuell ausführen: ${INSTALL_COMMAND}`;
        });
        installRow.add_suffix(installBtn);
        group.add(installRow);

        const checker = new UpdateChecker(installedVersion);
        const run = async () => {
            checkBtn.sensitive = false;
            versionRow.subtitle = 'Prüfe …';
            const st = await checker.checkForUpdates(null);
            checkBtn.sensitive = true;
            installBtn.sensitive = st.updateAvailable;
            if (st.error)
                versionRow.subtitle = st.notPublished ? st.error : `Prüfung fehlgeschlagen: ${st.error}`;
            else if (st.updateAvailable)
                versionRow.subtitle = `Neue Version verfügbar: v${st.remoteVersionName}`;
            else
                versionRow.subtitle = `Aktuell (neueste Version: v${st.remoteVersionName})`;
        };
        checkBtn.connect('clicked', run);
        if (settings.get_boolean('update-check-enabled'))
            run();
        page.connect('unmap', () => checker.destroy());
    }

    _combo(settings, key, title, options) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
        row.selected = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
        row.connect('notify::selected', r => settings.set_string(key, options[r.selected][0]));
        return row;
    }
}
