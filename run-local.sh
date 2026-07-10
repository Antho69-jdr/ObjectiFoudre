#!/bin/sh
# Lance ObjectiFoudre en local avec toutes les fonctionnalités actives + ouvre le navigateur.
# Usage : ./run-local.sh   (Ctrl-C pour arrêter)
cd "$(dirname "$0")" || exit 1

# Clés EUMETSAT (foudre MTG-LI / satellite) depuis .env
set -a; [ -f .env ] && . ./.env; set +a

# Clés Météo-France (fichiers gitignored)
export METEOFRANCE_API_KEY="$(cat 'Clef API.txt')"
export METEOFRANCE_AROME_PI_API_KEY="$(cat 'Clef API AROME PI.txt')"
export METEOFRANCE_ARPEGE_API_KEY="$(cat 'Clef API ARPEGE.txt')"

# Préchargement AROME au démarrage (J0 → J+2 ; J-1 servi à la demande depuis l'archive)
export OBJECTIFOUDRE_AUTO_PRELOAD=1
export OBJECTIFOUDRE_AUTO_PRELOAD_DAYS="today,tomorrow,day_after_tomorrow"
# Matérialise les 24 créneaux d'un jour en parallèle sur 6 processus (forkserver) :
# vrai parallélisme malgré le GIL → préchauffage nettement plus rapide (12 cœurs dispo).
export OBJECTIFOUDRE_PRELOAD_WORKERS=6

PORT="${PORT:-8000}"
URL="http://127.0.0.1:$PORT/"

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
  else
    PYTHON_BIN="$(command -v python3 || command -v python || true)"
  fi
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "Python introuvable. Installe Python 3 puis relance ce script." >&2
  exit 1
fi

# Les roues binaires numpy/h5py cherchent libstdc++.so.6 au chargement. Sur NixOS
# (ce poste, GLF-OS) elle n'est pas sur le chemin du chargeur : nix-ld l'expose via
# NIX_LD_LIBRARY_PATH. On ajoute le bon dossier a LD_LIBRARY_PATH tant que numpy ne
# s'importe pas, en essayant plusieurs sources (nix-ld, gcc, /nix/store).
prepend_libpath() {
  [ -n "$1" ] || return 1
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$1:"*) ;;
    *) export LD_LIBRARY_PATH="$1${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
}
numpy_ok() { "$PYTHON_BIN" -c "import numpy" >/dev/null 2>&1; }

if ! numpy_ok; then
  # 1) nix-ld (NixOS) : chemin deja prepare avec libstdc++ & co.
  prepend_libpath "${NIX_LD_LIBRARY_PATH:-}"
  [ -d /run/current-system/sw/share/nix-ld/lib ] && prepend_libpath /run/current-system/sw/share/nix-ld/lib
fi
if ! numpy_ok && command -v gcc >/dev/null 2>&1; then
  # 2) distributions classiques : on demande a gcc ou se trouve libstdc++.
  p="$(gcc -print-file-name=libstdc++.so.6 2>/dev/null || true)"
  [ -n "$p" ] && [ -f "$p" ] && prepend_libpath "$(dirname "$p")"
fi
if ! numpy_ok; then
  # 3) dernier recours : un gcc-lib quelconque du store nix.
  for d in /nix/store/*-gcc-*-lib/lib64 /nix/store/*-gcc-*-lib/lib; do
    [ -e "$d/libstdc++.so.6" ] && { prepend_libpath "$d"; numpy_ok && break; }
  done
fi

if ! "$PYTHON_BIN" -c "import uvicorn, h5py, numpy" >/tmp/objectifoudre-python-check.log 2>&1; then
  echo "Dependances Python incompletes pour ObjectiFoudre." >&2
  echo "Python utilise : $PYTHON_BIN" >&2
  echo "Details :" >&2
  sed 's/^/  /' /tmp/objectifoudre-python-check.log >&2
  echo "" >&2
  echo "Reinstalle les dependances dans le dossier storm_chase_hosted :" >&2
  echo "  python3 -m venv .venv" >&2
  echo "  . .venv/bin/activate" >&2
  echo "  python -m pip install -r requirements.txt" >&2
  exit 1
fi

# Ouvre le navigateur dès que le serveur répond
( until curl -sf "$URL" >/dev/null 2>&1; do sleep 1; done; xdg-open "$URL" >/dev/null 2>&1 ) &

exec "$PYTHON_BIN" -m uvicorn app:app --host 0.0.0.0 --port "$PORT"
