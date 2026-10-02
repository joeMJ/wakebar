# wakebar - Was hält den Rechner wach? In der GNOME-Leiste

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Rechte & Eingriff:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. Sie liest Sperren (Inhibitoren) von systemd-logind und GNOME-Sitzungsverwaltung sowie das Systemjournal, und der Knopf „Wach halten“ legt eine eigene Schlafsperre an. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Was hält meinen Rechner wach, was hat ihn am Schlafen gehindert und was hat ihn zuletzt aufgeweckt – auf einen Blick in der GNOME-Shell-Leiste**

---

## Plattform-Übersicht

| Plattform | Status | Verzeichnis | Tech Stack |
| :--- | :--- | :--- | :--- |
| **Linux (GNOME Shell)** | Konzeptphase, noch nicht lauffähig | `linux/` | GNOME Shell 46–50 ESM, GTK4/Adw, D-Bus (logind, SessionManager), systemd-Journal |

---

## Funktionen (geplant)

* **Ampel in der Statusleiste:**
  * **Grün** – der Rechner kann schlafen.
  * **Gelb** – etwas „grübelt“: kurzzeitige oder nur verzögernde Sperren.
  * **Rot** – etwas hält ihn fest: aktive Schlaf- oder Leerlaufsperre.
  * **Blau** – „Wach halten“ ist eingeschaltet.
  * Dazu eine Zahl mit der Anzahl der aktiven Sperren.

* **Aktuell wach gehalten (Popup):** Eine Karte je Sperre: Programm, Art (Schlaf, Leerlauf, Herunterfahren, …), Modus (blockieren / verzögern), angegebener Grund, Benutzer und Dauer.

* **Vergangenheit – was am Schlafen gehindert hat:** Protokoll früherer Sperren und gescheiterter Schlafversuche.

* **Letzter Aufwecker:** Protokoll der Aufwachvorgänge mit der ermittelten Ursache (z. B. Gerät, Zeitgeber, Tastatur/Netzwerk), soweit der Kern sie meldet.

* **Aufbewahrungsdauer einstellbar:** von „bis zum letzten Aufwachen“ über mehrere Tage bis zu einer festen Obergrenze.

* **Wach halten:** Ein Knopf im Popup schaltet eine eigene Schlafsperre ein und aus.

* **Aussehen:** Wie die Schwester-Extensions (snmpbar, monbar) – Karten im Libadwaita-Stil, monochrome Symbol-Icons, helles und dunkles Design.

---

## Installation Linux (Ubuntu / GNOME)

> [!NOTE]
> Noch nicht lauffähig – die Befehle zeigen das geplante Vorgehen, analog zu monbar.

**Voraussetzungen:** Ubuntu 24.04 – 26.04 (GNOME 46–50), `curl`, `tar` und `glib-compile-schemas` (Paket `libglib2.0-bin`, auf Ubuntu vorinstalliert). Kein `sudo` nötig – alles läuft im eigenen Benutzerkonto.

### Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh | bash
```

> [!NOTE]
> Unter Wayland lädt GNOME Shell neue oder aktualisierte Extensions erst nach dem **Ab- und wieder Anmelden**.

### Aktualisieren

Denselben Befehl erneut ausführen oder in den Einstellungen unter *Updates* auf **Jetzt aktualisieren** klicken.

### Deinstallieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/wakebar/main/install.sh | bash -s -- --uninstall
```

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

## Lizenz

[Apache License 2.0](LICENSE)
