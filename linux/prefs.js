import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
    }

    _combo(settings, key, title, options) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
        row.selected = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
        row.connect('notify::selected', r => settings.set_string(key, options[r.selected][0]));
        return row;
    }
}
