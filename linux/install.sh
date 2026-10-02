#!/usr/bin/env bash
# ==============================================================================
# linux/install.sh - Installer & Manager für die wakebar GNOME Shell Extension
# Führt alle Schritte im reinen Anwenderkontext (ohne sudo) aus.
# Aufruf normalerweise über das Root-Skript ./install.sh bzw. per curl (siehe README).
# ==============================================================================

set -e

EXTENSION_UUID="wakebar@johnlose.de"
EXTENSIONS_DIR="${HOME}/.local/share/gnome-shell/extensions"
TARGET_DIR="${EXTENSIONS_DIR}/${EXTENSION_UUID}"
DCONF_PATH="/org/gnome/shell/extensions/wakebar/"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

print_info()    { echo -e "\033[1;34m[INFO]\033[0m $1"; }
print_success() { echo -e "\033[1;32m[OK]\033[0m $1"; }
print_error()   { echo -e "\033[1;31m[FEHLER]\033[0m $1"; }

show_help() {
    echo "Verwendung: $0 [OPTION]"
    echo ""
    echo "Optionen:"
    echo "  --install     (Standard) Installiert und aktiviert die Extension im User-Verzeichnis"
    echo "  --update      Im Git-Klon: git pull + Installation; sonst Installation des geladenen Stands"
    echo "  --uninstall   Entfernt Extension, Einstellungen (dconf) und Protokoll"
    echo "  --help        Zeigt diese Hilfe an"
    exit 0
}

# Extension deaktivieren, aus enabled-extensions austragen und Verzeichnis löschen
remove_extension() {
    local uuid="$1"
    local dir="${EXTENSIONS_DIR}/${uuid}"

    if command -v gnome-extensions &>/dev/null; then
        gnome-extensions disable "${uuid}" 2>/dev/null || true
    fi

    if command -v gsettings &>/dev/null; then
        local current updated
        current=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "[]")
        if [[ "${current}" == *"'${uuid}'"* ]]; then
            updated=$(echo "${current}" | sed -E "s/, '${uuid}'|'${uuid}', |'${uuid}'//g")
            gsettings set org.gnome.shell enabled-extensions "${updated}" 2>/dev/null || true
        fi
    fi

    if [ -d "${dir}" ]; then
        print_info "Entferne Verzeichnis: ${dir}..."
        rm -rf "${dir}"
    fi
}

do_uninstall() {
    print_info "Starte rückstandslose Deinstallation von ${EXTENSION_UUID}..."

    remove_extension "${EXTENSION_UUID}"

    # Einstellungen direkt per dconf löschen – das Schema liegt nur im Extension-Verzeichnis,
    # gsettings reset-recursively würde es nicht finden.
    if command -v dconf &>/dev/null; then
        print_info "Lösche Einstellungen (${DCONF_PATH})..."
        dconf reset -f "${DCONF_PATH}" 2>/dev/null || true
    fi

    # Eigenes Protokoll (Wach-/Schlafhistorie)
    rm -rf "${XDG_STATE_HOME:-${HOME}/.local/state}/wakebar" 2>/dev/null || true

    print_success "Deinstallation abgeschlossen! Extension, Einstellungen und Protokoll wurden entfernt."
    exit 0
}

do_update() {
    print_info "Prüfe auf Updates via Git..."
    if [ -d "${REPO_DIR}/.git" ]; then
        git -C "${REPO_DIR}" pull || {
            print_error "Git Pull fehlgeschlagen. Bitte Netzwerkverbindung oder Remote prüfen."
            exit 1
        }
    else
        print_info "Kein Git-Klon – installiere den heruntergeladenen Stand."
    fi
    do_install
    print_success "Update erfolgreich abgeschlossen!"
    exit 0
}

do_install() {
    print_info "Installiere ${EXTENSION_UUID} für Benutzer: ${USER:-$(id -un)}..."

    # Voraussetzungen prüfen
    if ! command -v glib-compile-schemas &>/dev/null; then
        print_error "glib-compile-schemas ist nicht installiert. (apt install libglib2.0-bin)"
        exit 1
    fi
    # Laufende Extension vor dem Überschreiben deaktivieren (verhindert Shell-Abstürze durch
    # gleichzeitiges Schema-Kompilieren bei geladener Extension)
    if command -v gnome-extensions &>/dev/null; then
        gnome-extensions disable "${EXTENSION_UUID}" 2>/dev/null || true
        sleep 0.5
    fi

    print_info "Kompiliere GSettings-Schemas..."
    glib-compile-schemas "${SCRIPT_DIR}/schemas/"

    mkdir -p "${TARGET_DIR}"
    print_info "Kopiere Extension-Dateien nach ${TARGET_DIR}..."
    local item name
    for item in "${SCRIPT_DIR}"/*; do
        name="$(basename "${item}")"
        case "${name}" in
            install.sh|__pycache__) continue ;;
        esac
        cp -r "${item}" "${TARGET_DIR}/"
    done

    # Schemas im Zielordner sicherstellen
    glib-compile-schemas "${TARGET_DIR}/schemas/"

    # Extension in enabled-extensions aufnehmen
    if command -v gsettings &>/dev/null; then
        local current updated
        current=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "[]")
        if [[ "${current}" != *"'${EXTENSION_UUID}'"* ]]; then
            if [ "${current}" = "@as []" ] || [ "${current}" = "[]" ]; then
                gsettings set org.gnome.shell enabled-extensions "['${EXTENSION_UUID}']" 2>/dev/null || true
            else
                updated=$(echo "${current}" | sed "s/]$/, '${EXTENSION_UUID}']/")
                gsettings set org.gnome.shell enabled-extensions "${updated}" 2>/dev/null || true
            fi
        fi
    fi

    if command -v gnome-extensions &>/dev/null; then
        print_info "Aktiviere Extension in GNOME Shell..."
        gnome-extensions enable "${EXTENSION_UUID}" 2>/dev/null || true
    fi

    print_success "Installation erfolgreich abgeschlossen!"
    print_info "WICHTIGER HINWEIS (GNOME Wayland):"
    print_info "  GNOME Shell lädt neue oder geänderte Extension-Dateien auf Wayland erst beim Sitzungsstart."
    print_info "  Bitte einmal ABMELDEN und wieder ANMELDEN (oder System neu starten)!"
}

case "${1:-}" in
    --uninstall|-u) do_uninstall ;;
    --update)       do_update ;;
    --help|-h)      show_help ;;
    --install|"")   do_install ;;
    *)
        print_error "Unbekannte Option: $1"
        show_help
        ;;
esac
