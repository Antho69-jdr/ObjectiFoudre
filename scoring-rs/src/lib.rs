//! Noyau de scoring ObjectiFoudre en Rust — PARALLÈLE au Python (`weather_logic.py`),
//! jamais en remplacement tant que la parité + le benchmark ne sont pas validés.
//!
//! Contient : les scorers-feuilles, les portes/modificateurs, et `compute_initiation`
//! COMPLET, exposé en API BATCH (un appel pour N cellules d'un même créneau).
//!
//! PARITÉ EXACTE — pièges répliqués depuis Python :
//!  - `clamp(v) = int(max(0, min(100, round(v))))`, `round` = arrondi BANQUIER (moitié
//!    vers le pair) → `round_ties_even()` côté Rust (PAS `round()`).
//!  - `round(x, n)` Python (champs diagnostic) = arrondi banquier à n décimales.
//!  - non finis (NaN/inf) → traités comme `math.isfinite(...) == False`.
//!  - `dt` est CONSTANT par lot (un créneau = une heure) → on passe `hour`/`minute`.
//!  - HYPOTHÈSE : `weather_logic._active_blend_weights is None` (poids d'origine). Si
//!    l'auto-calibration active des poids appris, l'intégration prod doit repasser au
//!    Python (ou ce noyau doit recevoir les poids). Le harnais teste avec poids None.

use pyo3::prelude::*;
use pyo3::types::PyDict;

/// `weather_logic.clamp` : arrondi banquier puis bornage [0, 100] → entier.
#[inline]
fn clamp(value: f64) -> i64 {
    value.round_ties_even().clamp(0.0, 100.0) as i64
}

/// `round(x, ndigits)` Python (arrondi banquier à n décimales).
#[inline]
fn round_py(x: f64, ndigits: i32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let factor = 10f64.powi(ndigits);
    (x * factor).round_ties_even() / factor
}

/// `weather_logic.piecewise_score`.
fn piecewise(value: f64, points: &[(f64, f64)], inverse: bool) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let mut pts: Vec<(f64, f64)> = points.to_vec();
    if inverse {
        pts.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    } else {
        pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    }
    let last = pts.len() - 1;
    if !inverse {
        if value <= pts[0].0 {
            return clamp(pts[0].1);
        }
        if value >= pts[last].0 {
            return clamp(pts[last].1);
        }
        for w in pts.windows(2) {
            let (x1, y1) = w[0];
            let (x2, y2) = w[1];
            if x1 <= value && value <= x2 {
                let ratio = if x2 == x1 { 0.0 } else { (value - x1) / (x2 - x1) };
                return clamp(y1 + (y2 - y1) * ratio);
            }
        }
    } else {
        if value >= pts[0].0 {
            return clamp(pts[0].1);
        }
        if value <= pts[last].0 {
            return clamp(pts[last].1);
        }
        for w in pts.windows(2) {
            let (x1, y1) = w[0];
            let (x2, y2) = w[1];
            if x2 <= value && value <= x1 {
                let ratio = if x1 == x2 { 0.0 } else { (x1 - value) / (x1 - x2) };
                return clamp(y1 + (y2 - y1) * ratio);
            }
        }
    }
    clamp(pts[last].1)
}

// --- Tables de points (copiées à l'identique de weather_logic.py) ---
const CAPE_PTS: &[(f64, f64)] = &[(0.0, 0.0), (25.0, 2.0), (50.0, 5.0), (100.0, 10.0), (150.0, 16.0), (300.0, 28.0), (600.0, 48.0), (1000.0, 66.0), (1800.0, 82.0), (2500.0, 100.0)];
const DEWPOINT_PTS: &[(f64, f64)] = &[(0.0, 0.0), (6.0, 0.0), (8.0, 10.0), (10.0, 25.0), (12.0, 45.0), (14.0, 65.0), (16.0, 80.0), (18.0, 90.0), (20.0, 100.0)];
const HUMIDITY_PTS: &[(f64, f64)] = &[(20.0, 0.0), (35.0, 0.0), (45.0, 20.0), (55.0, 40.0), (65.0, 60.0), (80.0, 80.0), (95.0, 90.0)];
const VPD_PTS: &[(f64, f64)] = &[(3.5, 0.0), (2.5, 20.0), (1.8, 40.0), (1.2, 65.0), (0.8, 85.0), (0.0, 100.0)];
const WETBULB_PTS: &[(f64, f64)] = &[(4.0, 0.0), (8.0, 15.0), (11.0, 35.0), (14.0, 55.0), (17.0, 75.0), (20.0, 92.0), (23.0, 100.0)];
const PWAT_PTS: &[(f64, f64)] = &[(8.0, 0.0), (14.0, 15.0), (18.0, 35.0), (24.0, 55.0), (30.0, 75.0), (38.0, 92.0), (45.0, 100.0)];
const SHORTWAVE_PTS: &[(f64, f64)] = &[(0.0, 0.0), (50.0, 10.0), (120.0, 25.0), (250.0, 50.0), (400.0, 75.0), (600.0, 92.0), (800.0, 100.0)];
const GUST_PTS: &[(f64, f64)] = &[(4.0, 0.0), (7.0, 12.0), (10.0, 28.0), (14.0, 48.0), (18.0, 68.0), (24.0, 86.0), (30.0, 100.0)];
const PRECIP_PTS: &[(f64, f64)] = &[(0.0, 0.0), (0.05, 8.0), (0.15, 20.0), (0.30, 38.0), (0.60, 58.0), (1.20, 76.0), (2.50, 92.0), (5.00, 100.0)];
const CIN_PTS: &[(f64, f64)] = &[(250.0, 0.0), (150.0, 10.0), (100.0, 28.0), (50.0, 58.0), (25.0, 78.0), (0.0, 100.0)];
const CONV_PTS: &[(f64, f64)] = &[(-2.0, 0.0), (-1.0, 20.0), (0.0, 50.0), (0.5, 65.0), (1.0, 80.0), (2.0, 95.0), (3.0, 100.0)];
const BLH_PTS: &[(f64, f64)] = &[(150.0, 0.0), (400.0, 15.0), (800.0, 40.0), (1200.0, 62.0), (1800.0, 82.0), (2500.0, 95.0), (3500.0, 100.0)];
const CLOUD_SUPPORT_PTS: &[(f64, f64)] = &[(0.0, 0.0), (8.0, 8.0), (15.0, 22.0), (25.0, 45.0), (38.0, 68.0), (55.0, 86.0), (75.0, 100.0)];
const CLOUD_PENALTY_PTS: &[(f64, f64)] = &[(0.0, 8.0), (8.0, 7.0), (15.0, 5.0), (25.0, 3.0), (35.0, 1.0), (45.0, 0.0)];

#[inline] fn score_cape_rs(v: f64) -> i64 { piecewise(v, CAPE_PTS, false) }
#[inline] fn score_dewpoint_rs(v: f64) -> i64 { piecewise(v, DEWPOINT_PTS, false) }
#[inline] fn score_humidity_rs(v: f64) -> i64 { piecewise(v, HUMIDITY_PTS, false) }
#[inline] fn score_vpd_rs(v: f64) -> i64 { piecewise(v, VPD_PTS, true) }
#[inline] fn score_wetbulb_rs(v: f64) -> i64 { piecewise(v, WETBULB_PTS, false) }

#[inline]
fn opt_finite(v: Option<f64>) -> Option<f64> {
    match v { Some(x) if x.is_finite() => Some(x), _ => None }
}
fn score_pwat(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x.max(0.0), PWAT_PTS, false)) }
fn score_shortwave(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x.max(0.0), SHORTWAVE_PTS, false)) }
fn score_gust(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x.max(0.0), GUST_PTS, false)) }
fn score_cin(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x.abs(), CIN_PTS, true)) }
fn score_conv(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x * 10_000.0, CONV_PTS, false)) }
fn score_blh(v: Option<f64>) -> Option<i64> { opt_finite(v).map(|x| piecewise(x.max(0.0), BLH_PTS, false)) }

fn cloud_value(v: Option<f64>) -> Option<f64> { opt_finite(v).map(|x| x.max(0.0).min(100.0)) }

/// `score_clear_sky_guard` → (support, penalty, conv_cover arrondi 1, total_cover arrondi 1).
fn clear_sky_guard(cl: Option<f64>, cm: Option<f64>, ch: Option<f64>) -> (Option<i64>, i64, Option<f64>, Option<f64>) {
    let low = cloud_value(cl);
    let mid = cloud_value(cm);
    let high = cloud_value(ch);
    if low.is_none() && mid.is_none() && high.is_none() {
        return (None, 0, None, None);
    }
    let low_v = low.unwrap_or(0.0);
    let mid_v = mid.unwrap_or(0.0);
    let high_v = high.unwrap_or(0.0);
    let convective_cover = low_v.max(mid_v * 0.85).max((low_v * 0.70 + mid_v * 0.55 + high_v * 0.18).min(100.0));
    let total_cover = low_v.max(mid_v).max(high_v * 0.60).max((low_v + mid_v * 0.75 + high_v * 0.35).min(100.0));
    let support = piecewise(convective_cover, CLOUD_SUPPORT_PTS, false);
    let mut penalty = piecewise(convective_cover, CLOUD_PENALTY_PTS, false);
    if total_cover < 12.0 { penalty = penalty.max(8); }
    else if total_cover < 20.0 { penalty = penalty.max(5); }
    (Some(support), penalty, Some(round_py(convective_cover, 1)), Some(round_py(total_cover, 1)))
}

#[inline]
fn score_timing(hour: i64, minute: i64) -> i64 {
    let h = hour as f64 + minute as f64 / 60.0;
    if h < 8.0 { 10 } else if h < 12.0 { 30 } else if h < 18.0 { 100 } else if h < 22.0 { 60 } else { 20 }
}

fn apply_cape_moisture_gates(mut score: f64, mut penalty: f64, cape: f64, cape_s: i64, dew_s: i64, vpd_s: i64) -> (f64, f64) {
    if cape <= 0.0 || cape_s <= 0 { score = (score * 0.20).min(8.0); penalty += 20.0; }
    else if cape_s < 12 { score *= 0.45; penalty += 12.0; }
    else if cape_s < 25 { score *= 0.65; penalty += 8.0; }
    else if cape_s < 40 { score *= 0.78; penalty += 5.0; }
    if cape > 300.0 && cape < 1000.0 && dew_s > 70 { score += 10.0; }
    if dew_s < 30 && vpd_s < 30 { score *= 0.15; penalty += 32.0; }
    else if dew_s < 30 { score *= 0.30; penalty += 24.0; }
    else if vpd_s < 30 { score *= 0.50; penalty += 18.0; }
    else if cape_s > 60 && dew_s < 40 { score *= 0.60; penalty += 12.0; }
    (score, penalty)
}

#[allow(clippy::too_many_arguments)]
fn apply_environment_modifiers(
    mut score: f64, mut penalty: f64, hour: i64, cape_s: i64, dew_s: i64,
    cin_support_s: Option<i64>, cin_actual_s: Option<i64>, surface_trigger_s: Option<i64>,
    pwat_s: Option<i64>, shortwave_s: Option<i64>, conv_activity_s: Option<i64>, blh_s: Option<i64>,
) -> (f64, f64) {
    if let Some(c) = cin_support_s {
        if c < 25 { score *= 0.55; penalty += 16.0; } else if c < 40 { score *= 0.75; penalty += 8.0; }
    }
    if let Some(c) = cin_actual_s { if c >= 70 { score += 5.0; } }
    if let Some(st) = surface_trigger_s {
        if st < 25 && cape_s < 65 { score *= 0.88; penalty += 5.0; }
        else if st >= 75 && cape_s >= 35 && dew_s >= 40 && (cin_support_s.is_none() || cin_support_s.unwrap() >= 35) { score += 6.0; }
    }
    if let Some(pw) = pwat_s {
        if pw < 25 && cape_s >= 45 { score *= 0.92; penalty += 4.0; }
        else if pw >= 75 && cape_s >= 35 && dew_s >= 45 { score += 4.0; }
    }
    if let Some(sw) = shortwave_s {
        if sw < 20 && (9..=19).contains(&hour) && cape_s >= 45 { score *= 0.94; penalty += 3.0; }
        else if sw >= 70 && cape_s >= 35 && dew_s >= 40 { score += 3.0; }
    }
    if let Some(b) = blh_s {
        if b < 20 && (9..=19).contains(&hour) && cape_s >= 45 { score *= 0.95; penalty += 3.0; }
        else if b >= 70 && cape_s >= 35 && dew_s >= 40 { score += 3.0; }
    }
    if let Some(ca) = conv_activity_s {
        let mut activity = ca as f64;
        if cape_s < 15 && dew_s < 35 { activity *= 0.55; penalty += 6.0; }
        else if cape_s < 15 { activity *= 0.75; penalty += 3.0; }
        score = score.max(activity);
    }
    (score, penalty)
}

struct CellOut {
    score: i64, instability: i64, moisture: i64, timing: i64, surface_heating: i64,
    shortwave_comp: Option<i64>, shortwave_wm2: Option<f64>, environment: i64, inhibition_penalty: i64,
    cape_comp: i64, dew_comp: i64, humidity_comp: i64, vpd_comp: i64, wetbulb_comp: i64,
    cin_actual_comp: Option<i64>, surface_trigger_comp: Option<i64>, precip_comp: Option<i64>,
    precip_rate: Option<f64>, gust_comp: Option<i64>, conv_activity_comp: Option<i64>,
    pwat_comp: Option<i64>, pwat_kgm2: Option<f64>, surface_conv_1e4: Option<f64>,
    cloud_trigger_comp: Option<i64>, clear_sky_penalty: i64, conv_cloud_cover: Option<f64>,
    total_cloud_cover: Option<f64>, blh_comp: Option<i64>, blh_m: Option<f64>,
}

#[allow(clippy::too_many_arguments)]
fn compute_one(
    hour: i64, minute: i64, cape: f64, dewpoint: f64, rh: f64, vpd: f64, wetbulb: f64,
    cin: Option<f64>, conv_s1: Option<f64>, precip: Option<f64>, pwat: Option<f64>,
    shortwave: Option<f64>, gusts: Option<f64>,
    cloud_low: Option<f64>, cloud_mid: Option<f64>, cloud_high: Option<f64>, blh: Option<f64>,
) -> CellOut {
    let cape_s = score_cape_rs(cape);
    let dew_s = score_dewpoint_rs(dewpoint);
    let rh_s = score_humidity_rs(rh);
    let vpd_s = score_vpd_rs(vpd);
    let wet_s = score_wetbulb_rs(wetbulb);
    let timing_s = score_timing(hour, minute);
    let shortwave_s = score_shortwave(shortwave);
    let surface_heating_s = match shortwave_s {
        Some(sw) => clamp(timing_s as f64 * 0.55 + sw as f64 * 0.45),
        None => timing_s,
    };
    let shortwave_radiation = opt_finite(shortwave).map(|v| v.max(0.0));
    let cin_actual_s = score_cin(cin);
    let cin_support_s = cin_actual_s;
    let precip_finite = opt_finite(precip);
    let precip_s = precip_finite.map(|v| piecewise(v.max(0.0), PRECIP_PTS, false));
    let precip_rate = precip_finite.map(|v| v.max(0.0));
    let gust_s = score_gust(gusts);
    let pwat_s = score_pwat(pwat);
    let pwat_v = opt_finite(pwat).map(|v| v.max(0.0));
    let surface_trigger_s = score_conv(conv_s1);
    let surface_conv_1e4 = opt_finite(conv_s1).map(|v| round_py(v * 10_000.0, 2));
    let (cloud_support_s, clear_sky_penalty, conv_cover, total_cover) = clear_sky_guard(cloud_low, cloud_mid, cloud_high);
    let blh_s = score_blh(blh);
    let blh_v = opt_finite(blh).map(|v| v.max(0.0));

    let mut conv_activity_s: Option<i64> = None;
    if let Some(p) = precip_s {
        let cloud_activity = cloud_support_s.unwrap_or(0);
        let gust_activity = gust_s.unwrap_or(0);
        if p >= 58 || (p >= 30 && cloud_activity >= 25) {
            conv_activity_s = Some(clamp(p as f64 * 0.55 + cloud_activity as f64 * 0.25 + gust_activity as f64 * 0.20));
        } else if cloud_activity >= 55 && gust_activity >= 35 {
            conv_activity_s = Some(clamp(cloud_activity as f64 * 0.55 + gust_activity as f64 * 0.25 + p as f64 * 0.20));
        }
    }

    let saturation_s = clamp(vpd_s as f64 * 0.60 + rh_s as f64 * 0.40);
    let humidity_block = match pwat_s {
        None => clamp(dew_s as f64 * 0.65 + saturation_s as f64 * 0.35),
        Some(pw) => clamp(dew_s as f64 * 0.48 + saturation_s as f64 * 0.27 + wet_s as f64 * 0.08 + pw as f64 * 0.17),
    };

    // Poids d'origine (_active_blend_weights is None).
    let mut score: f64 = match surface_trigger_s {
        None => 0.50 * cape_s as f64 + 0.40 * humidity_block as f64 + 0.10 * surface_heating_s as f64,
        Some(st) => 0.44 * cape_s as f64 + 0.34 * humidity_block as f64 + 0.10 * surface_heating_s as f64 + 0.12 * st as f64,
    };

    let (s1, p1) = apply_cape_moisture_gates(score, 0.0, cape, cape_s, dew_s, vpd_s);
    score = s1;
    let (s2, p2) = apply_environment_modifiers(score, p1, hour, cape_s, dew_s, cin_support_s, cin_actual_s, surface_trigger_s, pwat_s, shortwave_s, conv_activity_s, blh_s);
    score = s2;

    CellOut {
        score: clamp(score), instability: cape_s, moisture: humidity_block, timing: timing_s,
        surface_heating: surface_heating_s, shortwave_comp: shortwave_s,
        shortwave_wm2: shortwave_radiation.map(|v| round_py(v, 1)),
        environment: clamp(score), inhibition_penalty: clamp(p2),
        cape_comp: cape_s, dew_comp: dew_s, humidity_comp: rh_s, vpd_comp: vpd_s, wetbulb_comp: wet_s,
        cin_actual_comp: cin_actual_s, surface_trigger_comp: surface_trigger_s, precip_comp: precip_s,
        precip_rate: precip_rate.map(|v| round_py(v, 3)), gust_comp: gust_s, conv_activity_comp: conv_activity_s,
        pwat_comp: pwat_s, pwat_kgm2: pwat_v.map(|v| round_py(v, 1)), surface_conv_1e4,
        cloud_trigger_comp: cloud_support_s, clear_sky_penalty, conv_cloud_cover: conv_cover,
        total_cloud_cover: total_cover, blh_comp: blh_s, blh_m: blh_v.map(|v| round_py(v, 0)),
    }
}

// --- Surface Python : scorers-feuilles (parité 1:1) ---
#[pyfunction] fn score_cape(v: f64) -> i64 { score_cape_rs(v) }
#[pyfunction] fn score_dewpoint(v: f64) -> i64 { score_dewpoint_rs(v) }
#[pyfunction] fn score_humidity(v: f64) -> i64 { score_humidity_rs(v) }
#[pyfunction] fn score_vpd(v: f64) -> i64 { score_vpd_rs(v) }
#[pyfunction] fn score_wetbulb(v: f64) -> i64 { score_wetbulb_rs(v) }

/// Somme des 5 scores-feuilles pour N cellules (benchmark micro, 1 appel FFI).
#[pyfunction]
fn score_leaf_sum_batch(cape: Vec<f64>, dewpoint: Vec<f64>, rh: Vec<f64>, vpd: Vec<f64>, wetbulb: Vec<f64>) -> Vec<i64> {
    (0..cape.len()).map(|i| score_cape_rs(cape[i]) + score_dewpoint_rs(dewpoint[i]) + score_humidity_rs(rh[i]) + score_vpd_rs(vpd[i]) + score_wetbulb_rs(wetbulb[i])).collect()
}

/// `compute_initiation` complet, BATCH. Toutes les cellules partagent `hour`/`minute`
/// (un créneau = une heure). Renvoie une liste de (score, dict de sous-scores) identique
/// à la sortie Python — pour la PARITÉ et l'intégration prod.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn compute_initiation_batch<'py>(
    py: Python<'py>, hour: i64, minute: i64,
    cape: Vec<f64>, dewpoint: Vec<f64>, rh: Vec<f64>, vpd: Vec<f64>, wetbulb: Vec<f64>,
    cin: Vec<Option<f64>>, conv_s1: Vec<Option<f64>>, precip: Vec<Option<f64>>, pwat: Vec<Option<f64>>,
    shortwave: Vec<Option<f64>>, gusts: Vec<Option<f64>>,
    cloud_low: Vec<Option<f64>>, cloud_mid: Vec<Option<f64>>, cloud_high: Vec<Option<f64>>, blh: Vec<Option<f64>>,
) -> PyResult<Vec<(i64, Bound<'py, PyDict>)>> {
    let n = cape.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let c = compute_one(
            hour, minute, cape[i], dewpoint[i], rh[i], vpd[i], wetbulb[i],
            cin[i], conv_s1[i], precip[i], pwat[i], shortwave[i], gusts[i],
            cloud_low[i], cloud_mid[i], cloud_high[i], blh[i],
        );
        let d = PyDict::new(py);
        d.set_item("instability", c.instability)?;
        d.set_item("moisture", c.moisture)?;
        d.set_item("timing", c.timing)?;
        d.set_item("surface_heating_component", c.surface_heating)?;
        d.set_item("shortwave_radiation_component", c.shortwave_comp)?;
        d.set_item("shortwave_radiation_w_m2", c.shortwave_wm2)?;
        d.set_item("environment_component", c.environment)?;
        d.set_item("inhibition_penalty", c.inhibition_penalty)?;
        d.set_item("cape_component", c.cape_comp)?;
        d.set_item("dew_component", c.dew_comp)?;
        d.set_item("humidity_component", c.humidity_comp)?;
        d.set_item("vpd_component", c.vpd_comp)?;
        d.set_item("wetbulb_component", c.wetbulb_comp)?;
        d.set_item("cin_actual_component", c.cin_actual_comp)?;
        d.set_item("surface_trigger_component", c.surface_trigger_comp)?;
        d.set_item("precipitation_component", c.precip_comp)?;
        d.set_item("precipitation_rate_mm_h", c.precip_rate)?;
        d.set_item("gust_potential_component", c.gust_comp)?;
        d.set_item("convective_activity_component", c.conv_activity_comp)?;
        d.set_item("precipitable_water_component", c.pwat_comp)?;
        d.set_item("precipitable_water_kg_m2", c.pwat_kgm2)?;
        d.set_item("surface_convergence_1e4s", c.surface_conv_1e4)?;
        d.set_item("cloud_trigger_component", c.cloud_trigger_comp)?;
        d.set_item("clear_sky_penalty", c.clear_sky_penalty)?;
        d.set_item("convective_cloud_cover", c.conv_cloud_cover)?;
        d.set_item("total_cloud_cover", c.total_cloud_cover)?;
        d.set_item("boundary_layer_component", c.blh_comp)?;
        d.set_item("boundary_layer_height_m", c.blh_m)?;
        out.push((c.score, d));
    }
    Ok(out)
}

/// Scores seuls (i64) — pour le benchmark de vitesse brute (sans construire les dicts).
#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn compute_initiation_scores_batch(
    hour: i64, minute: i64,
    cape: Vec<f64>, dewpoint: Vec<f64>, rh: Vec<f64>, vpd: Vec<f64>, wetbulb: Vec<f64>,
    cin: Vec<Option<f64>>, conv_s1: Vec<Option<f64>>, precip: Vec<Option<f64>>, pwat: Vec<Option<f64>>,
    shortwave: Vec<Option<f64>>, gusts: Vec<Option<f64>>,
    cloud_low: Vec<Option<f64>>, cloud_mid: Vec<Option<f64>>, cloud_high: Vec<Option<f64>>, blh: Vec<Option<f64>>,
) -> Vec<i64> {
    (0..cape.len()).map(|i| compute_one(
        hour, minute, cape[i], dewpoint[i], rh[i], vpd[i], wetbulb[i],
        cin[i], conv_s1[i], precip[i], pwat[i], shortwave[i], gusts[i],
        cloud_low[i], cloud_mid[i], cloud_high[i], blh[i],
    ).score).collect()
}

#[pymodule]
fn scoring_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(score_cape, m)?)?;
    m.add_function(wrap_pyfunction!(score_dewpoint, m)?)?;
    m.add_function(wrap_pyfunction!(score_humidity, m)?)?;
    m.add_function(wrap_pyfunction!(score_vpd, m)?)?;
    m.add_function(wrap_pyfunction!(score_wetbulb, m)?)?;
    m.add_function(wrap_pyfunction!(score_leaf_sum_batch, m)?)?;
    m.add_function(wrap_pyfunction!(compute_initiation_batch, m)?)?;
    m.add_function(wrap_pyfunction!(compute_initiation_scores_batch, m)?)?;
    Ok(())
}
