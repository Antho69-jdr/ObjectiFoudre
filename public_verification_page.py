"""public_verification_page.py — Rendu HTML de la page publique « prévu contre observé ».

Une seule entrée : `render(report) -> str`, où `report` est le dictionnaire produit par
app._build_public_verification_report(). Le HTML est ÉCRIT UNE FOIS à la fin du cycle de
vérification puis servi tel quel : aucun calcul à la visite, aucun JavaScript, aucune
requête vers une API, aucun traceur. La page doit rester lisible même si tout le reste de
l'application est éteint.

Les mini-cartes sont dessinées ici, en SVG, à partir des seuls contours départementaux :
pas de tuiles, donc pas de fond de carte à créditer ni de requête tierce depuis le
navigateur du lecteur.

RÈGLE ABSOLUE DE CE MODULE : une valeur absente s'affiche comme absente. Aucun `or 0`,
aucune estimation, aucun arrondi flatteur — `None` devient « non calculé » avec la raison.
"""

from __future__ import annotations

import html
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence

HERE = Path(__file__).resolve().parent
_GEOJSON_PATH = HERE / "data" / "departements_fr.geojson"

# ── Projection des mini-cartes ───────────────────────────────────────────────
# Équirectangulaire sur la bbox France métropolitaine (mêmes bornes que la grille de
# prévision, cf. FRANCE_LIGHTNING_BBOX). Le cosinus de la latitude moyenne redresse les
# longitudes : sans lui, la France est étirée d'un tiers en largeur.
LON0, LON1 = -5.55, 9.75
LAT0, LAT1 = 41.05, 51.45
_COSLAT = math.cos(math.radians((LAT0 + LAT1) / 2.0))
MAP_H = 300.0
_SCALE = MAP_H / (LAT1 - LAT0)
MAP_W = round((LON1 - LON0) * _COSLAT * _SCALE, 1)
# Taille d'une cellule de la grille, en degrés (défauts de verification._cell_bounds).
CELL_W_DEG, CELL_H_DEG = 0.18, 0.135
_CELL_W = round(CELL_W_DEG * _COSLAT * _SCALE, 2)
_CELL_H = round(CELL_H_DEG * _SCALE, 2)
# Décimation du contour : 1 point sur 10 suffit à reconnaître la France à 300 px de haut,
# et divise par neuf le poids du tracé (183 ko → 20 ko), payé UNE fois pour toutes les
# cartes de la page via <use>.
OUTLINE_STEP = 10

LOW_SIGNAL_CELLS = 5   # même seuil que verification.low_signal : en dessous, le CSI est du bruit
STRIP_MAX_DAYS = 90    # la frise journalière montre au plus 90 journées, les plus récentes


def _project(lon: float, lat: float) -> tuple[float, float]:
    return ((float(lon) - LON0) * _COSLAT * _SCALE, (LAT1 - float(lat)) * _SCALE)


# ── Contour de la France (chargé une fois, décimé) ───────────────────────────
_outline_cache: str | None = None


def france_outline_path() -> str:
    """Tracé SVG des limites départementales, décimé. Rendu vide si le fichier manque :
    les cartes perdent leur fond mais la page tient debout."""
    global _outline_cache
    if _outline_cache is not None:
        return _outline_cache
    parts: list[str] = []
    try:
        data = json.loads(_GEOJSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        _outline_cache = ""
        return _outline_cache
    for feature in data.get("features", []):
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        polys = [coords] if geom.get("type") == "Polygon" else coords
        for poly in polys:
            for ring in poly:
                points = list(ring)[::OUTLINE_STEP]
                if len(points) < 4:
                    continue
                bits = []
                for i, point in enumerate(points):
                    x, y = _project(point[0], point[1])
                    bits.append(f"{'M' if i == 0 else 'L'}{x:.1f} {y:.1f}")
                parts.append("".join(bits) + "Z")
    _outline_cache = "".join(parts)
    return _outline_cache


def cells_path(points: Iterable[Sequence[float]]) -> str:
    """Un SEUL <path> pour toutes les cellules d'une couche : ~25 caractères par cellule
    au lieu de ~55 pour autant de <rect>."""
    bits: list[str] = []
    for point in points:
        try:
            x, y = _project(point[1], point[0])
        except (IndexError, TypeError, ValueError):
            continue
        bits.append(f"M{x - _CELL_W / 2:.1f} {y - _CELL_H / 2:.1f}"
                    f"h{_CELL_W:.2f}v{_CELL_H:.2f}h-{_CELL_W:.2f}z")
    return "".join(bits)


# ── Formatage : une valeur absente reste absente ─────────────────────────────

def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def num(value: Any, decimals: int = 3) -> str:
    """Nombre à la française (virgule décimale) ou « — » si la valeur n'existe pas."""
    if value is None:
        return "—"
    try:
        return f"{float(value):.{decimals}f}".replace(".", ",")
    except (TypeError, ValueError):
        return "—"


def integer(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"{int(value):,}".replace(",", " ")   # espace fine insécable
    except (TypeError, ValueError):
        return "—"


_MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
         "août", "septembre", "octobre", "novembre", "décembre")


def date_fr(iso: Any) -> str:
    text = str(iso or "")
    if len(text) < 10:
        return "—"
    try:
        year, month, day = int(text[0:4]), int(text[5:7]), int(text[8:10])
        return f"{day} {_MOIS[month - 1]} {year}"
    except (ValueError, IndexError):
        return text[:10]


def datetime_fr(iso: Any) -> str:
    text = str(iso or "")
    if len(text) < 16:
        return date_fr(text)
    return f"{date_fr(text)} à {text[11:13]} h {text[14:16]}"


# ── Fragments ────────────────────────────────────────────────────────────────

def _window_card(window: dict[str, Any]) -> str:
    scores = window.get("scores") or {}
    significant = bool(window.get("significant"))
    body = (
        f'<div class="big">{num(scores.get("csi"), 3)}</div>'
        f'<div class="sub">CSI — indice de succès critique</div>'
        f'<dl class="mini">'
        f'<div><dt>POD</dt><dd>{num(scores.get("pod"), 3)}</dd></div>'
        f'<div><dt>FAR</dt><dd>{num(scores.get("far"), 3)}</dd></div>'
        f'<div><dt>HSS</dt><dd>{num(scores.get("hss"), 3)}</dd></div>'
        f'</dl>'
    ) if significant else (
        f'<div class="big none">non calculé</div>'
        f'<div class="sub">effectif insuffisant : moins de '
        f'{integer(window.get("min_positives"))} cellules-jours foudroyées</div>'
    )
    contingency = window.get("contingency") or {}
    return f"""<article class="card">
      <h3>{esc(window.get('label'))}</h3>
      <p class="range">{date_fr(window.get('start'))} → {date_fr(window.get('end'))}
         · {integer(window.get('days'))} journée(s) vérifiée(s)</p>
      {body}
      <p class="n"><strong>n = {integer(window.get('positives'))}</strong> cellules-jours
         réellement foudroyées · {integer(contingency.get('hits'))} réussites,
         {integer(contingency.get('misses'))} manquées,
         {integer(contingency.get('false_alarms'))} fausses alertes</p>
    </article>"""


def _daily_strip(daily: Sequence[dict[str, Any]]) -> str:
    """Frise du CSI journalier : c'est là que les ratés se voient."""
    days = list(daily)[-STRIP_MAX_DAYS:]
    if not days:
        return '<p class="empty">Aucune journée vérifiée pour l’instant.</p>'
    width, height = 960.0, 260.0
    top, bottom, left, right = 20.0, 210.0, 54.0, 940.0
    span = max(1, len(days))
    slot = (right - left) / span
    bar_w = max(1.6, min(14.0, slot * 0.68))

    def y_of(value: float) -> float:
        return bottom - max(0.0, min(1.0, value)) * (bottom - top)

    bars: list[str] = []
    total = {"hits": 0, "misses": 0, "false_alarms": 0}
    for i, day in enumerate(days):
        c = day.get("contingency") or {}
        hits = int(c.get("hits") or 0)
        misses = int(c.get("misses") or 0)
        fa = int(c.get("false_alarms") or 0)
        for key, value in (("hits", hits), ("misses", misses), ("false_alarms", fa)):
            total[key] += value
        denom = hits + misses + fa
        csi = (hits / denom) if denom else 0.0
        observed = int(day.get("observed_cells") or 0)
        weak = observed < LOW_SIGNAL_CELLS
        x = left + i * slot + (slot - bar_w) / 2
        y = y_of(csi)
        # Talon de 2 px : une journée à CSI nul EXISTE, elle ne doit pas disparaître.
        h = max(2.0, bottom - y)
        cls = "bar weak" if weak else "bar"
        bars.append(f'<rect class="{cls}" x="{x:.1f}" y="{bottom - h:.1f}" '
                    f'width="{bar_w:.1f}" height="{h:.1f}"><title>'
                    f'{esc(day.get("date"))} — CSI {num(csi, 3)}, {integer(observed)} cellules foudroyées'
                    f'</title></rect>')

    denom_all = total["hits"] + total["misses"] + total["false_alarms"]
    pooled = (total["hits"] / denom_all) if denom_all else None
    pooled_line = ""
    if pooled is not None:
        y = y_of(pooled)
        pooled_line = (f'<line class="pooled" x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}"></line>'
                       f'<text class="pooled-label start" x="{left + 4}" y="{y - 6:.1f}">'
                       f'score groupé de la période : {num(pooled, 3)}</text>')
    grid = "".join(
        f'<line class="grid" x1="{left}" y1="{y_of(v):.1f}" x2="{right}" y2="{y_of(v):.1f}"></line>'
        f'<text class="tick" x="{left - 8}" y="{y_of(v) + 4:.1f}">{num(v, 2)}</text>'
        for v in (0.0, 0.25, 0.5, 0.75, 1.0))
    first, last = days[0].get("date"), days[-1].get("date")
    return f"""<figure class="chart">
      <svg viewBox="0 0 {width:.0f} {height:.0f}" role="img"
           aria-label="CSI journalier sur les {len(days)} dernières journées vérifiées">
        {grid}
        {''.join(bars)}
        {pooled_line}
        <line class="axis" x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}"></line>
        <text class="tick start" x="{left}" y="{bottom + 20:.0f}">{esc(first)}</text>
        <text class="tick" x="{right}" y="{bottom + 20:.0f}">{esc(last)}</text>
        <text class="tick start" x="{left}" y="{bottom + 40:.0f}">1 barre = 1 journée vérifiée · hauteur = CSI du jour</text>
      </svg>
      <figcaption>Chaque journée est là, y compris les mauvaises. Les barres pâles comptent
        moins de {LOW_SIGNAL_CELLS} cellules foudroyées : leur CSI n’a pas de sens et
        n’entre dans aucun score affiché ailleurs qu’ici.</figcaption>
    </figure>"""


def _reliability_chart(rows: Sequence[dict[str, Any]]) -> str:
    usable = [r for r in rows if r.get("significant") and r.get("observed_nearby") is not None]
    if not usable:
        return '<p class="empty">Pas encore assez de cellules pour tracer la courbe.</p>'
    width, height = 700.0, 372.0
    left, right, top, bottom = 66.0, 660.0, 30.0, 300.0

    def x_of(score: float) -> float:
        return left + (right - left) * max(0.0, min(100.0, score)) / 100.0

    def y_of(p: float) -> float:
        return bottom - (bottom - top) * max(0.0, min(1.0, p))

    def series(key: str, cls: str) -> str:
        pts = [(x_of((r["bin"][0] + r["bin"][1]) / 2.0), y_of(r[key]))
               for r in usable if r.get(key) is not None]
        if not pts:
            return ""
        line = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        dots = "".join(f'<circle class="{cls}-dot" cx="{x:.1f}" cy="{y:.1f}" r="3.4"></circle>'
                       for x, y in pts)
        return f'<polyline class="{cls}" points="{line}"></polyline>{dots}'

    grid = "".join(
        f'<line class="grid" x1="{left}" y1="{y_of(v):.1f}" x2="{right}" y2="{y_of(v):.1f}"></line>'
        f'<text class="tick" x="{left - 8}" y="{y_of(v) + 4:.1f}">{int(v * 100)} %</text>'
        for v in (0.0, 0.25, 0.5, 0.75, 1.0))
    ticks = "".join(
        f'<text class="tick mid" x="{x_of((r["bin"][0] + r["bin"][1]) / 2.0):.1f}" '
        f'y="{bottom + 20:.0f}">{esc(r["label"])}</text>'
        for r in rows[::2])
    return f"""<figure class="chart">
      <svg viewBox="0 0 {width:.0f} {height:.0f}" role="img"
           aria-label="Fréquence de foudre observée selon le score annoncé">
        {grid}
        <line class="diagonal" x1="{left}" y1="{bottom}" x2="{right}" y2="{top}"></line>
        <text class="diagonal-label" x="{x_of(78):.1f}" y="{y_of(0.80):.1f}"
              transform="rotate(-24.4, {x_of(78):.1f}, {y_of(0.80):.1f})">score = probabilité</text>
        {series('observed_nearby', 'near')}
        {series('observed_in_cell', 'exact')}
        <line class="axis" x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}"></line>
        {ticks}
        <text class="tick mid" x="{(left + right) / 2:.0f}" y="{bottom + 44:.0f}">score de risque annoncé (maximum de la journée sur la cellule)</text>
      </svg>
      <figcaption>
        <span class="key near">foudre à ≤ 30 km — la définition utilisée par tous les scores de cette page</span>
        <span class="key exact">foudre dans la cellule elle-même</span>
        <span class="key plain">la diagonale n’est qu’un repère : le score 0-100 <strong>n’est pas</strong> une probabilité, rien ne l’oblige à la suivre</span>
      </figcaption>
    </figure>"""


def _mini_map(points: Sequence[Sequence[float]], label: str, cls: str) -> str:
    path = cells_path(points)
    return f"""<figure class="minimap">
      <svg viewBox="0 0 {MAP_W} {MAP_H:.0f}" role="img" aria-label="{esc(label)}">
        <use href="#fr-outline" class="outline"></use>
        <path class="cells {cls}" d="{path}"></path>
      </svg>
      <figcaption>{esc(label)} — {integer(len(points))} cellules</figcaption>
    </figure>"""


def _case_block(case: dict[str, Any]) -> str:
    scores = case.get("scores") or {}
    contingency = case.get("contingency") or {}
    points = case.get("points") or {}
    motif = ("journée la plus active de la période"
             if case.get("reason") == "journee_la_plus_active"
             else "l’un des plus mauvais scores de la période")
    return f"""<article class="case">
      <header>
        <h3>{date_fr(case.get('date'))}</h3>
        <p class="why">Retenue automatiquement : {motif}.</p>
      </header>
      <div class="maps">
        {_mini_map(points.get('forecast') or [], 'Prévu — zones annoncées pour cette journée', 'forecast')}
        {_mini_map(points.get('observed') or [], 'Observé — cellules réellement foudroyées', 'observed')}
      </div>
      <dl class="case-scores">
        <div><dt>CSI</dt><dd>{num(scores.get('csi'), 3)}</dd></div>
        <div><dt>POD</dt><dd>{num(scores.get('pod'), 3)}</dd></div>
        <div><dt>FAR</dt><dd>{num(scores.get('far'), 3)}</dd></div>
        <div><dt>n</dt><dd>{integer(case.get('observed_cells'))}</dd></div>
      </dl>
      <p class="case-detail">{integer(contingency.get('hits'))} réussites ·
        {integer(contingency.get('misses'))} manquées ·
        {integer(contingency.get('false_alarms'))} fausses alertes ·
        {integer(case.get('flash_total'))} éclairs détectés sur la France</p>
    </article>"""


def _regions_table(rows: Sequence[dict[str, Any]]) -> str:
    if not rows:
        return '<p class="empty">Pas encore de ventilation régionale.</p>'
    body = "".join(
        f"<tr><td>{esc(r.get('zone'))}</td>"
        f"<td class=\"num\">{integer(r.get('positives'))}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('pod'), 3)}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('far'), 3)}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('csi'), 3)}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('hss'), 3)}</td></tr>"
        for r in rows)
    return f"""<div class="tw"><table>
      <thead><tr><th>Région</th><th>n (cellules-jours foudroyées)</th>
        <th>POD</th><th>FAR</th><th>CSI</th><th>HSS</th></tr></thead>
      <tbody>{body}</tbody>
    </table></div>"""


def _lead_section(report: dict[str, Any]) -> str:
    rows = report.get("lead_time") or []
    method = report.get("method") or {}
    leads = ", ".join(f"J+{x}" for x in (method.get("lead_days") or [])) or "aucune"
    if not rows:
        first_change = (report.get("changes") or [{}])[0].get("at")
        return f"""<p>La prévision archivée pour une journée passée est celle du
        <strong>dernier calcul disponible ce jour-là</strong> : tous les scores ci-dessus
        mesurent donc la prévision <strong>du jour même</strong>, pas celle de la veille.</p>
        <p>Cette limite ne pouvait pas être réparée après coup — l'archive ne garde qu'une
        grille par date. La collecte des prévisions à échéance {esc(leads)} a été
        <strong>ouverte le {date_fr(first_change)}</strong> ; tant qu'aucune journée n'a été
        à la fois prévue à l'avance <em>et</em> observée, ce tableau reste vide. Il ne sera
        pas rempli par une estimation.</p>"""
    body = "".join(
        f"<tr><td>J+{esc(r.get('lead'))}</td>"
        f"<td class=\"num\">{integer(r.get('days'))}</td>"
        f"<td class=\"num\">{integer(r.get('positives'))}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('pod'), 3)}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('far'), 3)}</td>"
        f"<td class=\"num\">{num((r.get('scores') or {}).get('csi'), 3)}</td></tr>"
        f"<tr class=\"ref\"><td>J+0, <em>mêmes journées</em></td>"
        f"<td class=\"num\">{integer(((r.get('same_days_j0') or {}).get('days')))}</td>"
        f"<td class=\"num\">{integer(((r.get('same_days_j0') or {}).get('positives')))}</td>"
        f"<td class=\"num\">{num(((r.get('same_days_j0') or {}).get('scores') or {}).get('pod'), 3)}</td>"
        f"<td class=\"num\">{num(((r.get('same_days_j0') or {}).get('scores') or {}).get('far'), 3)}</td>"
        f"<td class=\"num\">{num(((r.get('same_days_j0') or {}).get('scores') or {}).get('csi'), 3)}</td></tr>"
        for r in rows)
    return f"""<p>Chaque échéance est comparée au J+0 <strong>des mêmes journées</strong> :
      comparer une échéance lointaine sur un échantillon et le jour même sur un autre ne
      mesurerait rien.</p>
      <div class="tw"><table>
      <thead><tr><th>Échéance</th><th>Journées</th><th>n</th><th>POD</th><th>FAR</th><th>CSI</th></tr></thead>
      <tbody>{body}</tbody></table></div>"""


def _changes_list(changes: Sequence[dict[str, Any]]) -> str:
    if not changes:
        return '<p class="empty">Aucune rupture enregistrée pour l’instant.</p>'
    items = []
    for change in changes:
        weights = change.get("weights")
        poids = ("poids appris "
                 + ", ".join(f"{k} {num(v, 2)}" for k, v in (weights or {}).items())
                 ) if weights else "poids d’origine"
        items.append(
            f"<li><strong>{datetime_fr(change.get('at'))}</strong> — "
            f"seuil de décision {esc(change.get('threshold'))} "
            f"(référence {esc(change.get('baseline_threshold'))}) · "
            f"agrégateur de cellule « {esc(change.get('cell_aggregator'))} » · {esc(poids)} · "
            f"version {esc(change.get('app_version'))}</li>")
    return f"<ul class='changes'>{''.join(items)}</ul>"


# ── Page ─────────────────────────────────────────────────────────────────────

def render(report: dict[str, Any]) -> str:
    method = report.get("method") or {}
    coverage = report.get("coverage") or {}
    windows = report.get("windows") or {}
    threshold = method.get("threshold")
    baseline = method.get("baseline_threshold")
    radius = method.get("neighborhood_km")
    generated = datetime_fr(report.get("generated_at"))

    cards = "".join(_window_card(windows[k]) for k in ("7j", "30j", "saison") if k in windows)
    cases = "".join(_case_block(c) for c in (report.get("cases") or []))
    if not cases:
        cases = ('<p class="empty">Aucune journée ne dépasse encore l’effectif minimal de '
                 f'{integer(method.get("min_positives_case"))} cellules foudroyées.</p>')

    couverture = (
        f"{integer(coverage.get('days_ready'))} journées vérifiées"
        + (f" sur {integer(coverage.get('days_total'))} disponibles "
           f"(<strong>{integer(coverage.get('days_pending'))} encore en cours de calcul</strong>)"
           if not coverage.get("complete") else "")
        + (f", du {date_fr(coverage.get('first_date'))} au {date_fr(coverage.get('last_date'))}"
           if coverage.get("first_date") else ""))

    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prévu contre observé — la qualité réelle des prévisions ObjectiFoudre</title>
<meta name="description" content="Scores de vérification d'ObjectiFoudre mesurés contre la foudre réellement observée : POD, FAR, CSI, HSS, courbe de fiabilité, réussites et ratés.">
<style>
:root {{
  --ground:#0b131c; --surface:#121c27; --surface-2:#17222f; --line:#24323f;
  --line-soft:#1c2833; --ink:#e5edf5; --ink-soft:#93a7bc; --ink-faint:#6b8098;
  --accent:#5cc2e8; --good:#4dc08c; --bad:#e0736a; --grid:#22303d;
  color-scheme: dark;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--ground); color:var(--ink);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:16px; line-height:1.62; -webkit-font-smoothing:antialiased; }}
.page {{ max-width:1000px; margin:0 auto; padding:36px 20px 90px; }}
.prose {{ max-width:68ch; }}
a {{ color:var(--accent); }}
h1 {{ font-size:clamp(27px,4.2vw,38px); line-height:1.12; letter-spacing:-.02em; margin:6px 0 12px; }}
h2 {{ font-size:21px; letter-spacing:-.01em; margin:0 0 12px; }}
h3 {{ font-size:16.5px; margin:0 0 4px; }}
p {{ margin:0 0 13px; }}
section {{ margin:0 0 46px; }}
.eyebrow {{ font-size:11.5px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--ink-faint); font-weight:600; }}
header.head {{ border-bottom:1px solid var(--line); padding-bottom:22px; margin-bottom:32px; }}
.meta {{ color:var(--ink-faint); font-size:13px; margin-top:12px; }}
.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; }}
.card {{ background:var(--surface); border:1px solid var(--line); border-radius:11px; padding:16px 18px 14px; }}
.card h3 {{ margin-bottom:2px; }}
.card .range {{ color:var(--ink-faint); font-size:12.5px; margin:0 0 12px; }}
.big {{ font-size:38px; font-weight:600; letter-spacing:-.02em; line-height:1;
  font-variant-numeric:tabular-nums; }}
.big.none {{ font-size:20px; color:var(--ink-faint); font-weight:500; }}
.sub {{ color:var(--ink-soft); font-size:13px; margin-top:6px; }}
.card .n {{ font-size:12.5px; color:var(--ink-soft); margin:12px 0 0;
  border-top:1px solid var(--line-soft); padding-top:10px; }}
dl.mini {{ display:flex; gap:18px; margin:14px 0 0; }}
dl.mini div {{ display:flex; flex-direction:column; }}
dl.mini dt {{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); }}
dl.mini dd {{ margin:0; font-size:16px; font-variant-numeric:tabular-nums; }}
.chart {{ margin:0; background:var(--surface); border:1px solid var(--line);
  border-radius:11px; padding:14px 12px 10px; overflow-x:auto; }}
.chart svg {{ display:block; width:100%; height:auto; min-width:520px; }}
.chart figcaption {{ color:var(--ink-soft); font-size:13px; margin:12px 4px 2px; }}
.chart .key {{ display:block; margin-top:4px; }}
.chart .key.near::before,.chart .key.exact::before {{ content:""; display:inline-block;
  width:10px; height:10px; border-radius:50%; margin-right:8px; vertical-align:middle; }}
.chart .key.near::before {{ background:var(--accent); }}
.chart .key.exact::before {{ background:var(--ink-soft); }}
.grid {{ stroke:var(--grid); stroke-width:1; }}
.axis {{ stroke:var(--line); stroke-width:1.5; }}
.tick {{ fill:var(--ink-faint); font-size:11px; text-anchor:end;
  font-family:ui-monospace,monospace; }}
.tick.mid {{ text-anchor:middle; }}
.tick.start {{ text-anchor:start; }}
.bar {{ fill:var(--accent); opacity:.85; }}
.bar.weak {{ fill:var(--ink-faint); opacity:.45; }}
.pooled {{ stroke:var(--bad); stroke-width:1.5; stroke-dasharray:5 4; }}
.pooled-label {{ fill:var(--bad); font-size:11.5px; font-family:ui-monospace,monospace; text-anchor:start; }}
.diagonal {{ stroke:var(--ink-faint); stroke-width:1; stroke-dasharray:3 5; opacity:.55; }}
.diagonal-label {{ fill:var(--ink-faint); font-size:10.5px; opacity:.9;
  font-family:ui-monospace,monospace; }}
polyline.near {{ fill:none; stroke:var(--accent); stroke-width:2.4; stroke-linejoin:round; }}
polyline.exact {{ fill:none; stroke:var(--ink-soft); stroke-width:2; stroke-linejoin:round; }}
.near-dot {{ fill:var(--accent); }}
.exact-dot {{ fill:var(--ink-soft); }}
.tw {{ overflow-x:auto; border:1px solid var(--line); border-radius:11px; background:var(--surface); }}
table {{ border-collapse:collapse; width:100%; font-size:14px; }}
th,td {{ padding:8px 13px; text-align:right; white-space:nowrap; }}
th:first-child,td:first-child {{ text-align:left; }}
thead th {{ font-size:11px; letter-spacing:.07em; text-transform:uppercase; font-weight:600;
  color:var(--ink-faint); background:var(--surface-2); border-bottom:1px solid var(--line); }}
tbody td {{ border-bottom:1px solid var(--line-soft); font-variant-numeric:tabular-nums; }}
tbody tr:last-child td {{ border-bottom:0; }}
tbody tr.ref td {{ color:var(--ink-soft); background:var(--surface-2); }}
.cases {{ display:grid; gap:16px; }}
.case {{ background:var(--surface); border:1px solid var(--line); border-radius:11px; padding:16px 18px; }}
.case .why {{ color:var(--ink-faint); font-size:12.5px; margin:0 0 12px; }}
.maps {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }}
.minimap {{ margin:0; }}
.minimap svg {{ display:block; width:100%; height:auto; background:var(--surface-2);
  border:1px solid var(--line-soft); border-radius:8px; }}
.minimap figcaption {{ color:var(--ink-soft); font-size:12px; margin-top:6px; }}
.outline {{ fill:none; stroke:var(--line); stroke-width:.55; }}
.cells.forecast {{ fill:var(--accent); opacity:.75; }}
.cells.observed {{ fill:var(--bad); opacity:.8; }}
dl.case-scores {{ display:flex; flex-wrap:wrap; gap:20px; margin:14px 0 0; }}
dl.case-scores div {{ display:flex; flex-direction:column; }}
dl.case-scores dt {{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); }}
dl.case-scores dd {{ margin:0; font-size:18px; font-variant-numeric:tabular-nums; }}
.case-detail {{ color:var(--ink-soft); font-size:12.5px; margin:10px 0 0; }}
ul.changes {{ padding-left:18px; color:var(--ink-soft); font-size:14px; }}
ul.changes li {{ margin:6px 0; }}
.empty {{ color:var(--ink-faint); font-style:italic; }}
.note {{ border-left:3px solid var(--accent); background:var(--surface);
  border-radius:0 9px 9px 0; padding:12px 16px; margin:0 0 16px; }}
footer {{ border-top:1px solid var(--line); padding-top:22px; margin-top:10px;
  color:var(--ink-faint); font-size:13px; }}
footer h2 {{ font-size:15px; color:var(--ink-soft); }}
footer p {{ margin:0 0 10px; }}
.srcs {{ display:grid; gap:10px; }}
.src {{ background:var(--surface); border:1px solid var(--line-soft); border-radius:8px; padding:10px 13px; }}
.src strong {{ color:var(--ink-soft); }}
@media (max-width:640px) {{
  .page {{ padding:26px 14px 70px; }}
  .card,.case {{ padding:14px 14px 12px; }}
  .big {{ font-size:32px; }}
}}
</style>
</head>
<body>
<svg width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute">
  <defs><path id="fr-outline" d="{france_outline_path()}"></path></defs>
</svg>
<div class="page">

<header class="head">
  <span class="eyebrow">ObjectiFoudre · vérification</span>
  <h1>Prévu contre observé</h1>
  <p class="prose">Cette page compare, jour après jour, ce qu'ObjectiFoudre a annoncé à la
     foudre réellement détectée par satellite. Elle est publique, elle n'est pas choisie :
     les fenêtres de temps sont fixes, les journées montrées sont sélectionnées par une
     règle automatique, et les échecs y figurent au même titre que les réussites.</p>
  <p class="meta">Recalculée le {generated} · {couverture} ·
     seuil de décision {esc(threshold)} (référence {esc(baseline)}) ·
     appariement à {num(radius, 0)} km · version {esc(report.get('app_version'))}</p>
</header>

<section>
  <span class="eyebrow">Scores</span>
  <h2>Trois fenêtres, jamais choisies</h2>
  <div class="cards">{cards}</div>
  <p class="prose" style="margin-top:14px">Le <strong>n</strong> affiché sous chaque score
     est le nombre de cellules-jours où de la foudre a réellement été détectée. C'est lui qui
     dit si le score au-dessus veut dire quelque chose : sous
     {integer(method.get('min_positives_window'))}, on n'en affiche aucun.</p>
</section>

<section>
  <span class="eyebrow">Jour par jour</span>
  <h2>Ce qu'une moyenne cacherait</h2>
  {_daily_strip(report.get('daily') or [])}
</section>

<section>
  <span class="eyebrow">Fiabilité</span>
  <h2>Quand la carte annonce 70, que se passe-t-il ?</h2>
  <p class="prose">Le score de risque va de 0 à 100 — ce <strong>n'est pas</strong> un
     pourcentage de probabilité. Voici, pour chaque tranche de score, la proportion de
     cellules où la foudre est effectivement tombée.</p>
  {_reliability_chart(report.get('reliability') or [])}
</section>

<section>
  <span class="eyebrow">Géographie</span>
  <h2>Par région</h2>
  <p class="prose">Une région sous {integer(method.get('min_positives_region'))} cellules-jours
     foudroyées garde son effectif mais perd ses scores : à cette échelle, ils seraient du bruit.</p>
  {_regions_table(report.get('regions') or [])}
</section>

<section>
  <span class="eyebrow">Échéance</span>
  <h2>Prévoir la veille, est-ce moins bon ?</h2>
  {_lead_section(report)}
</section>

<section>
  <span class="eyebrow">Cas</span>
  <h2>Réussites et ratés, côte à côte</h2>
  <p class="prose">Trois journées parmi les plus orageuses de la période, et trois parmi les
     plus mal prévues. La sélection est faite par une règle fixe — les plus grands effectifs,
     puis les plus mauvais CSI — et n'est jamais retouchée à la main.</p>
  <div class="cases">{cases}</div>
</section>

<section>
  <span class="eyebrow">Méthode</span>
  <h2>Comment ces chiffres sont calculés</h2>
  <div class="prose">
    <p><strong>Ce qui est prévu.</strong> La France est découpée en {integer(coverage.get('grid_cells'))} cellules
       d'environ 15 km. Pour chaque cellule et chaque journée, on retient le score de risque
       le plus élevé des 24 créneaux horaires : « a-t-on annoncé un orage ici, à un moment de
       la journée ? ». Une cellule est comptée comme <em>prévue</em> si ce score atteint
       <strong>{esc(threshold)}</strong>.</p>
    <p><strong>Ce qui est observé.</strong> Les éclairs proviennent de l'instrument
       <em>Lightning Imager</em> du satellite Meteosat Troisième Génération (EUMETSAT), agrégés
       sur les mêmes cellules. Une cellule est comptée comme <em>orage observé</em> à partir de
       <strong>{num(method.get('flash_threshold'), 0)} éclair</strong> détecté dans la journée.</p>
    <p><strong>Comment on les rapproche.</strong> Pas cellule à cellule : un modèle
       d'environnement à ~15 km ne peut pas désigner la maille exacte où l'éclair tombera. On
       tolère un rayon de <strong>{num(radius, 0)} km</strong>. Une cellule foudroyée est une
       réussite s'il existait une cellule prévue à moins de {num(radius, 0)} km ; une cellule
       prévue est une fausse alerte s'il n'y a eu aucune foudre à moins de
       {num(radius, 0)} km. Ce rayon est <strong>le premier levier</strong> qui fait bouger un
       CSI : à la cellule exacte, tous les scores de cette page seraient nettement plus bas —
       la courbe de fiabilité ci-dessus montre les deux.</p>
    <p><strong>Les scores.</strong> POD = part des orages observés qui avaient été prévus.
       FAR = part des zones prévues où rien n'est tombé. CSI = réussites rapportées à
       l'ensemble réussites + manqués + fausses alertes ; c'est le score le plus sévère et
       le plus honnête, il ignore les journées calmes correctement prévues. HSS mesure ce que
       la prévision apporte par rapport au hasard. Les journées sont
       <strong>additionnées</strong> (une seule table de contingence pour toute la fenêtre),
       jamais moyennées : une grosse journée pèse ce qu'elle vaut.</p>
    <p><strong>Le seuil bouge, et on le dit.</strong> Le seuil de décision est réajusté
       automatiquement par l'apprentissage du modèle : il vaut actuellement
       <strong>{esc(threshold)}</strong>, contre {esc(baseline)} en réglage d'origine. Les
       poids internes du score et la façon d'agréger une cellule changent aussi. Toute la
       période est donc recalculée avec la méthode <em>du jour</em> : c'est cohérent, mais
       cela veut dire qu'un chiffre relevé ici aujourd'hui peut différer du même chiffre relevé
       dans un mois. Les ruptures connues sont listées ci-dessous.</p>
    <h3>Ruptures de méthode</h3>
    {_changes_list(report.get('changes') or [])}
    <p style="color:var(--ink-faint);font-size:13.5px">Le journal d'apprentissage antérieur à
       l'ouverture de ce suivi ne conservait ni le seuil ni les poids : les ruptures plus
       anciennes sont perdues, et ne sont pas reconstituées ici.</p>
    <h3>Limites connues</h3>
    <ul>
      <li><strong>Détection.</strong> Un orage trop faible pour être vu depuis l'orbite compte
        comme « pas d'orage » : il pénalise le score comme une fausse alerte.</li>
      <li><strong>Bords du domaine.</strong> Les cellules en mer et le long des frontières
        n'appartiennent à aucun département : elles comptent dans les scores nationaux mais
        pas dans la ventilation régionale.</li>
      <li><strong>Journées calmes.</strong> Une journée sans foudre observée ne produit aucun
        CSI. Elle n'est pas écartée du décompte, elle n'a simplement rien à mesurer.</li>
      <li><strong>Profondeur.</strong> L'archive est conservée
        {integer(coverage.get('retention_days'))} jours. Au-delà, les journées disparaissent
        et les fenêtres se raccourcissent d'autant.</li>
      <li><strong>Saison.</strong> L'archive commence au printemps 2026. Tant que l'hiver n'y
        est pas, la fenêtre « saison » décrit un été orageux, pas une année.</li>
    </ul>
  </div>
</section>

<footer>
  <h2>Sources et licences</h2>
  <div class="srcs">
    <div class="src"><strong>Météo-France</strong> — modèles AROME et ARPEGE, et radar de
      précipitations. Source : Météo-France. Données publiques diffusées sous
      <em>Licence Ouverte / Open Licence Etalab 2.0</em>.</div>
    <div class="src"><strong>EUMETSAT</strong> — éclairs observés, instrument
      <em>Lightning Imager</em> de Meteosat Troisième Génération.
      Contient des données EUMETSAT Meteosat modifiées, 2026.</div>
    <div class="src"><strong>ECMWF</strong> — tendance J+5 à J+10 dans l'application
      (non utilisée sur cette page). Copyright « © 2026 European Centre for Medium-Range
      Weather Forecasts (ECMWF) ». Source : www.ecmwf.int. Données publiées sous licence
      <em>Creative Commons Attribution 4.0 International (CC BY 4.0)</em>. L'ECMWF décline
      toute responsabilité en cas d'erreur ou d'omission dans les données, d'indisponibilité,
      ou de tout dommage résultant de leur usage.</div>
    <div class="src"><strong>IGN</strong> — RGE ALTI® pour le calcul d'horizon des spots
      d'observation, et contours administratifs des départements utilisés par les cartes
      ci-dessus. © IGN, <em>Licence Ouverte / Open Licence Etalab 2.0</em>.</div>
    <div class="src"><strong>Fond de carte de l'application</strong> —
      © OpenStreetMap contributors © CARTO. Les cartes de cette page n'utilisent aucune
      tuile : elles sont dessinées à partir des seuls contours départementaux.</div>
  </div>
  <p style="margin-top:18px">Page régénérée automatiquement à la fin de chaque cycle de
     vérification. Aucun cookie, aucun traceur, aucun compte nécessaire.
     <a href="/">Retour à l'application</a> ·
     <a href="/api/verification/publique">les mêmes chiffres en JSON</a> ·
     <a href="/confidentialite">confidentialité</a></p>
</footer>

</div>
</body>
</html>
"""
