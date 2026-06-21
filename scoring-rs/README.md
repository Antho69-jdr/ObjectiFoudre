# scoring_rs — noyau de scoring en Rust (parallèle, pour test)

Implémentation Rust du scoring, **à côté** du Python (`weather_logic.py`) — jamais en
remplacement tant que la parité + le benchmark ne sont pas validés. On compare les deux
avec `../bench_scoring.py`.

Périmètre du POC : `clamp`, `piecewise_score` et les 5 scorers-feuilles
(cape / dewpoint / humidité / vpd / wetbulb) + une API batch. Le portage complet de
`compute_initiation` (portes + modificateurs + fusion 4-blocs) est l'étape suivante, à faire
en itérant contre le harnais de parité.

## 1. Installer le toolchain Rust (absent de ce poste)

NixOS / GLF-OS — le plus simple, un shell éphémère avec Rust + maturin :

```sh
nix-shell -p cargo rustc maturin
```

(ou, si tu préfères, `rustup` via nix, ou un flake dédié. `maturin` peut aussi s'installer
dans le venv : `pip install maturin`.)

## 2. Construire le module dans le venv du projet

Active le venv du projet (le même que `run-local.sh`, pour que `LD_LIBRARY_PATH` pointe vers
nix-ld), puis :

```sh
cd scoring-rs
maturin develop --release      # compile et installe `scoring_rs` dans le venv actif
```

## 3. Lancer parité + benchmark

```sh
cd ..                          # retour dans storm_chase_hosted
python bench_scoring.py
```

Le harnais :
- **Parité** : balaye finement chaque scorer et vérifie que Rust == Python sur tout
  (y compris les cas d'arrondi à `.5`, où Python utilise l'arrondi *banquier* —
  répliqué côté Rust par `round_ties_even()`).
- **Benchmark** : 300 000 cellules, boucle Python par cellule vs appel batch Rust unique,
  affiche l'accélération.

Tant que la parité n'est pas **OK ✓**, on ne touche pas au chemin de production.
