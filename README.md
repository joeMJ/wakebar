# wakebar - Was hält den Rechner wach? In der GNOME-Leiste

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Rechte & Eingriff:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. Sie liest Sperren (Inhibitoren) von systemd-logind und der GNOME-Sitzungsverwaltung, das Systemjournal (`journalctl`) und Aufweck-Zähler unter `/sys/class/wakeup`, schreibt ein lokales Protokoll nach `~/.local/state/wakebar/`, und der Knopf „Wach halten“ legt eine eigene Schlafsperre an. Für die Update-Prüfung ruft sie regelmäßig die `metadata.json` von GitHub ab. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Was hält meinen Rechner wach, was hat ihn am Schlafen gehindert und was hat ihn zuletzt aufgeweckt – auf einen Blick in der GNOME-Shell-Leiste**

---

## Plattform-Übersicht

| Plattform | Status | Verzeichnis | Tech Stack |
| :--- | :--- | :--- | :--- |
| **Linux (GNOME Shell)** | v1.2 | [`linux/`](linux/) | GNOME Shell 46–50 ESM, GTK4/Adw, D-Bus (logind, SessionManager), systemd-Journal, libsoup 3 |

---

## Funktionen

* **Ampel in der Statusleiste:**
  * **Weißes Ein/Aus-Symbol** (Kreis mit Strich, Farbe der Leiste) – nichts hält den Rechner wach, er kann schlafen.
  * **Gelb** – etwas „grübelt“: nur der automatische Schlaf bzw. die Bildschirm-Abschaltung wird gebremst (z. B. Ton- oder Videowiedergabe im Browser).
  * **Rot** – etwas hält ihn fest: eine blockierende Schlafsperre.
  * **Blau** – „Wach halten“ ist eingeschaltet.
  * Dazu eine Zahl mit der Anzahl der aktiven Sperren. Position links, in der Mitte oder rechts.

* **Popup (bei Klick auf die Ampel):**
  * **Kopf-Kachel:** Rechnername, Gesamtstatus, letzte Prüfung, letzter Aufwecker.
  * **Hält gerade wach:** eine Zeile je Programm mit Status `{blockiert}` / `{bremst}`. Die Sperren stammen von systemd-logind und der GNOME-Sitzung (Browser, Videoplayer, …). Rein systeminterne Sperren, die nur kurz verzögern, sind separat gelistet und färben die Ampel nicht.
  * **Hielt vom Schlafen ab:** Protokoll früherer Sperren mit Beginn, Ende und Dauer; kurz aufeinanderfolgende gleiche Sperren sind zu einem Eintrag („Name (N×)“) zusammengefasst.
  * **Aufwecker:** Protokoll der Aufwachvorgänge mit Zeitpunkt, Schlafdauer und Ursache, ermittelt aus Zählern des Kernels (`/sys/class/wakeup`, ACPI) und dem Journal: `Tastatur/Maus (USB)` (belegt, beide lassen sich nicht trennen), `Netzschalter` bzw. `Netzschalter (per Ausschluss)`, Gehäusedeckel oder – wenn nichts erkennbar ist – eine ausdrücklich gekennzeichnete Vermutung. Im Sidecar stehen die gemessenen Zähler.
  * **Flyover-Sidecar:** Fährt man über eine Zeile, erscheint neben dem Menü ein Detailfenster mit Erklärung, warum das Programm den Rechner wach hält, dem Grund laut Programm, Prozess, Laufzeit und der Bedeutung des Modus.
  * **Wach halten:** schaltet eine eigene Schlafsperre ein und aus.

* **Läuft auch bei gesperrtem Bildschirm** (die Extension wird beim Sperren nicht deaktiviert), damit Schlaf und Aufwachen lückenlos protokolliert werden.

* **Aufbewahrung einstellbar:** „seit letztem Aufwachen“ oder 1, 3, 7, 14 Tage (mit fester Obergrenze). Das Protokoll liegt lokal unter `~/.local/state/wakebar/`.

* **Updates:** Im Reiter *Updates* der Einstellungen wird die Version mit der `metadata.json` auf GitHub verglichen. Bei einer neuen Version zeigt das Menü einen Hinweis, **Jetzt aktualisieren** startet den Installer im Terminal.

* **Aussehen:** Wie die Schwester-Extensions (snmpbar, monbar) – Kacheln im Libadwaita-Stil, monochrome Symbol-Icons, helles und dunkles Design.

---

## Installation Linux (Ubuntu / GNOME)

**Voraussetzungen:** Ubuntu 24.04 – 26.04 (GNOME 46–50), `curl`, `tar` und `glib-compile-schemas` (Paket `libglib2.0-bin`, auf Ubuntu vorinstalliert). Kein `sudo` nötig – alles läuft im eigenen Benutzerkonto.

### Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh | bash
```

> [!NOTE]
> Unter Wayland lädt GNOME Shell neue oder aktualisierte Extensions erst nach dem **Ab- und wieder Anmelden**.

### Aktualisieren

Denselben Befehl erneut ausführen oder in den Einstellungen unter *Updates* auf **Jetzt aktualisieren** klicken – Einstellungen und Protokoll bleiben erhalten. Liegt eine neue Version vor, zeigt das Popup einen Hinweis.

### Deinstallieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh | bash -s -- --uninstall
```

Entfernt die Extension, alle Einstellungen und das lokale Protokoll.

### Erst ansehen, dann ausführen

```bash
curl -fsSLO https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh
less install.sh
bash install.sh
```

### Einstellungen

Über das Zahnrad im Popup oder:

```bash
gnome-extensions prefs wakebar@johnlose.de
```

### Alternative: Git-Klon (für Entwicklung)

```bash
git clone https://github.com/joeMJ/wakebar.git
cd wakebar
./install.sh
```

Update mit `./update.sh` (führt `git pull` aus), Deinstallation mit `./uninstall.sh`.

---

## Tests

Der Menüaufbau lässt sich ohne laufende GNOME Shell prüfen (Platzhalter für die Shell-Bausteine, gespeicherte Daten werden gelesen):

```bash
./tests/run-menu-test.sh
```

---

## Lizenz

[Apache License 2.0](LICENSE)
