"""Migre l'historique local (history/) vers une instance distante d'ObjectiFoudre.

Usage :
    python3 tools/migrate_history.py https://mon-app.up.railway.app SECRET

- Compare l'inventaire distant (GET /api/history/inventory) au contenu local ;
- n'envoie QUE les fichiers manquants ou de taille différente (POST /api/history/import) ;
- idempotent et REPRENABLE : relancer après une coupure ne renvoie pas ce qui est déjà là.

Prérequis côté distant : OBJECTIFOUDRE_PRELOAD_SECRET défini (le même que SECRET),
et OBJECTIFOUDRE_HISTORY_DIR pointé sur le volume persistant.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
HISTORY = HERE / "history"
# User-Agent explicite : l'empreinte par défaut de python-urllib est bloquée par le
# Bot Fight Mode de Cloudflare (error 1010) quand le domaine passe par son proxy.
UA = {"User-Agent": "ObjectiFoudre-Migration/1.0 (Mozilla/5.0 compatible)"}


def get_json(url: str, timeout: int = 60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    base = sys.argv[1].rstrip("/")
    secret = sys.argv[2]

    local = {str(p.relative_to(HISTORY)): p.stat().st_size
             for p in HISTORY.rglob("*") if p.is_file() and not p.name.endswith(".tmp")}
    print(f"local : {len(local)} fichiers, {sum(local.values()) / 1e6:.0f} Mo")

    q = urllib.parse.urlencode({"secret": secret})
    remote = get_json(f"{base}/api/history/inventory?{q}")["files"]
    print(f"distant : {len(remote)} fichiers")

    # n'envoie que les fichiers ABSENTS du distant : un fichier présent là-bas peut être
    # PLUS FRAIS (l'instance distante archive en continu ses propres journées) — l'écraser
    # serait une régression ; le serveur skippe de toute façon sans overwrite.
    todo = [rel for rel in sorted(local) if rel not in remote]
    print(f"à envoyer : {len(todo)} fichiers")

    sent = errors = 0
    t0 = time.time()
    for i, rel in enumerate(todo, 1):
        data = (HISTORY / rel).read_bytes()
        qq = urllib.parse.urlencode({"secret": secret, "path": rel})
        req = urllib.request.Request(f"{base}/api/history/import?{qq}", data=data, method="POST",
                                     headers={"Content-Type": "application/octet-stream", **UA})
        for attempt in (1, 2, 3):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    json.load(r)
                sent += 1
                break
            except Exception as exc:
                if attempt == 3:
                    errors += 1
                    print(f"  ÉCHEC {rel} : {exc}")
                else:
                    time.sleep(2 * attempt)
        if i % 50 == 0 or i == len(todo):
            rate = sent / max(1.0, time.time() - t0)
            print(f"  {i}/{len(todo)} envoyés ({rate:.1f} fichiers/s)")

    print(f"\nterminé : {sent} envoyés, {errors} échecs")
    after = get_json(f"{base}/api/history/inventory?{q}")
    print(f"distant après : {after['count']} fichiers, {after['total_bytes'] / 1e6:.0f} Mo")
    missing = [rel for rel in local if rel not in after["files"]]
    print("✅ MIGRATION COMPLÈTE" if not missing else f"⚠ encore absents du distant : {len(missing)}")


if __name__ == "__main__":
    main()
