from datetime import date as Date
from urllib.parse import parse_qs, urlparse
import unittest
from unittest.mock import patch

import weather_logic as wl


class ApiContextTests(unittest.TestCase):
    def test_auto_today_uses_forecast_full_day(self):
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            api_base, params, api_mode = wl.api_context(Date(2026, 5, 7), "auto")

        self.assertEqual(api_base, wl.FORECAST_API_BASE)
        self.assertEqual(api_mode, "forecast")
        self.assertEqual(params, {"start_date": "2026-05-07", "end_date": "2026-05-07"})

    def test_auto_past_day_uses_historical(self):
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            api_base, params, api_mode = wl.api_context(Date(2026, 5, 6), "auto")

        self.assertEqual(api_base, wl.HISTORICAL_API_BASE)
        self.assertEqual(api_mode, "historical")
        self.assertEqual(params, {"start_date": "2026-05-06", "end_date": "2026-05-06"})

    def test_auto_tomorrow_uses_forecast_full_day(self):
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            api_base, params, api_mode = wl.api_context(Date(2026, 5, 8), "auto")

        self.assertEqual(api_base, wl.FORECAST_API_BASE)
        self.assertEqual(api_mode, "forecast")
        self.assertEqual(params, {"start_date": "2026-05-08", "end_date": "2026-05-08"})

    def test_auto_day_after_tomorrow_uses_forecast_full_day(self):
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            api_base, params, api_mode = wl.api_context(Date(2026, 5, 9), "auto")

        self.assertEqual(api_base, wl.FORECAST_API_BASE)
        self.assertEqual(api_mode, "forecast")
        self.assertEqual(params, {"start_date": "2026-05-09", "end_date": "2026-05-09"})

    def test_auto_rejects_dates_beyond_meteofrance_forecast_horizon(self):
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            with self.assertRaisesRegex(ValueError, "hors horizon forecast Météo-France"):
                wl.api_context(Date(2026, 5, 11), "auto")

    def test_selected_forecast_day_url_does_not_use_current_hour_window(self):
        point = wl.Point("Lyon-1", 45.764, 4.8357, 0.1, 0.1)
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            url = wl.build_api_url([point], target_date=Date(2026, 5, 7), mode="auto")

        query = parse_qs(urlparse(url).query)
        self.assertEqual(query["start_date"], ["2026-05-07"])
        self.assertEqual(query["end_date"], ["2026-05-07"])
        self.assertNotIn("forecast_hours", query)

    def test_hourly_vars_follow_strict_arome_contract(self):
        expected = {
            "cape",
            "precipitable_water",
            "shortwave_radiation",
            "precipitation_rate",
            "relative_humidity_2m",
            "wind_speed_10m",
            "wind_direction_10m",
            "temperature_2m",
            "dew_point_2m",
            "cloud_cover_low",
            "cloud_cover_mid",
            "cloud_cover_high",
            "wind_gusts_10m",
        }
        self.assertEqual(set(wl.HOURLY_VARS), expected)

    def test_mock_location_populates_strict_fields(self):
        point = wl.Point("Mock-1", 45.764, 4.8357, 0.1, 0.1)
        location = wl.generate_mock_location(point, target_date=Date(2026, 5, 8))
        hourly = location["hourly"]

        for field in wl.HOURLY_VARS:
            self.assertIn(field, hourly)
            self.assertEqual(len(hourly[field]), 24)
        self.assertEqual(len(hourly["wind_direction_10m_available"]), 24)
        self.assertTrue(all(hourly["wind_direction_10m_available"]))
        self.assertGreater(max(hourly["precipitable_water"]), 0)
        self.assertGreater(max(hourly["shortwave_radiation"]), 0)

    def test_day_after_tomorrow_uses_meteofrance_best_match(self):
        point = wl.Point("Lyon-1", 45.764, 4.8357, 0.1, 0.1)
        with patch.object(wl, "local_today", return_value=Date(2026, 5, 7)):
            url = wl.build_api_url([point], target_date=Date(2026, 5, 9), mode="auto")

        query = parse_qs(urlparse(url).query)
        self.assertEqual(query["start_date"], ["2026-05-09"])
        self.assertEqual(query["end_date"], ["2026-05-09"])
        self.assertNotIn("models", query)


class ScoreTests(unittest.TestCase):
    def test_actual_cin_feeds_initiation_score(self):
        dt = wl.datetime(2026, 5, 8, 15)

        base_score, base_diag = wl.compute_initiation(900, 16, 72, 0.9, 24, 18, dt)
        capped_score, capped_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, cin_jkg=-180
        )
        open_score, open_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, cin_jkg=-10
        )

        self.assertIsNone(base_diag["cin_actual_component"])
        self.assertLess(capped_score, base_score)
        self.assertGreater(open_score, base_score)
        self.assertEqual(capped_diag["cin_actual_component"], 7)
        self.assertEqual(open_diag["cin_actual_component"], 91)

    def test_precipitable_water_modulates_moisture_score(self):
        dt = wl.datetime(2026, 5, 8, 16)

        dry_score, dry_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, precipitable_water_kg_m2=14
        )
        moist_score, moist_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, precipitable_water_kg_m2=36
        )

        self.assertLess(dry_score, moist_score)
        self.assertLess(dry_diag["moisture"], moist_diag["moisture"])
        self.assertLess(dry_diag["precipitable_water_component"], moist_diag["precipitable_water_component"])

    def test_shortwave_radiation_modulates_surface_heating(self):
        dt = wl.datetime(2026, 5, 8, 15)

        shaded_score, shaded_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, shortwave_radiation_w_m2=40
        )
        sunny_score, sunny_diag = wl.compute_initiation(
            900, 16, 72, 0.9, 24, 18, dt, shortwave_radiation_w_m2=650
        )

        self.assertLess(shaded_score, sunny_score)
        self.assertLess(shaded_diag["surface_heating_component"], sunny_diag["surface_heating_component"])
        self.assertLess(shaded_diag["shortwave_radiation_component"], sunny_diag["shortwave_radiation_component"])

    def test_low_cape_is_not_a_hard_zero_gate(self):
        dt = wl.datetime(2026, 5, 8, 15)

        weak_score, weak_diag = wl.compute_initiation(
            80, 17, 72, 0.9, 24, 18, dt
        )
        null_score, null_diag = wl.compute_initiation(
            0, 17, 72, 0.9, 24, 18, dt
        )

        self.assertGreater(weak_score, 0)
        self.assertLess(weak_score, 35)
        self.assertGreater(weak_diag["cape_component"], null_diag["cape_component"])
        self.assertLessEqual(null_score, 8)

    def test_clear_sky_guard_is_diagnostic_only(self):
        dt = wl.datetime(2026, 5, 8, 17)

        clear_score, clear_diag = wl.compute_initiation(
            1200, 17, 62, 1.1, 25, 19, dt, cloud_low=0, cloud_mid=0, cloud_high=3
        )
        cloudy_score, cloudy_diag = wl.compute_initiation(
            1200, 17, 62, 1.1, 25, 19, dt, cloud_low=35, cloud_mid=45, cloud_high=25
        )

        self.assertEqual(clear_score, cloudy_score)
        self.assertGreater(clear_diag["clear_sky_penalty"], 0)
        self.assertEqual(cloudy_diag["clear_sky_penalty"], 0)
        self.assertLess(clear_diag["cloud_trigger_component"], cloudy_diag["cloud_trigger_component"])

    def test_clear_sky_context_does_not_reduce_confidence(self):
        dt = wl.datetime(2026, 5, 8, 17)

        clear_score, clear_diag = wl.compute_initiation(
            1200, 17, 62, 1.1, 25, 19, dt, cloud_low=0, cloud_mid=0, cloud_high=3
        )
        cloudy_score, cloudy_diag = wl.compute_initiation(
            1200, 17, 62, 1.1, 25, 19, dt, cloud_low=35, cloud_mid=45, cloud_high=25
        )
        clear_confidence, clear_conf_diag = wl.compute_signal_confidence({"trigger": clear_score, **clear_diag}, [])
        cloudy_confidence, cloudy_conf_diag = wl.compute_signal_confidence({"trigger": cloudy_score, **cloudy_diag}, [])

        self.assertEqual(clear_confidence, cloudy_confidence)
        self.assertEqual(clear_conf_diag["consistency"], cloudy_conf_diag["consistency"])
        self.assertEqual(clear_conf_diag["margin"], cloudy_conf_diag["margin"])

    def test_analysis_export_omits_removed_scores(self):
        point = wl.Point("Test-1", 45.0, 4.0, 0.1, 0.1)
        rows = wl.rows_for_location(
            point,
            {
                "hourly": {
                    "time": ["2026-05-08T15:00:00+02:00"],
                    "cape": [900],
                    "precipitable_water": [32],
                    "shortwave_radiation": [520],
                    "precipitation_rate": [0.2],
                    "temperature_2m": [24],
                    "dew_point_2m": [16],
                    "relative_humidity_2m": [72],
                    "cloud_cover_low": [25],
                    "cloud_cover_mid": [30],
                    "cloud_cover_high": [40],
                    "wind_gusts_10m": [12],
                    "wind_speed_10m": [5],
                    "wind_direction_10m": [220],
                }
            },
        )

        exported = wl.flatten_rows_for_analysis(rows)
        self.assertEqual(len(exported), 1)
        for removed_key in ("structure_score", "chase_quality_score", "stability_score", "score_global"):
            self.assertNotIn(removed_key, exported[0])
        self.assertIn("trigger_score", exported[0])
        self.assertIn("confidence_score", exported[0])

    def test_hour_without_temperature_or_dewpoint_is_skipped(self):
        point = wl.Point("Test-1", 45.0, 4.0, 0.1, 0.1)
        rows = wl.rows_for_location(
            point,
            {
                "hourly": {
                    "time": ["2026-05-08T14:00:00+02:00", "2026-05-08T15:00:00+02:00"],
                    "cape": [800, 900],
                    "temperature_2m": [None, 24],
                    "dew_point_2m": [15, 16],
                    "relative_humidity_2m": [70, 72],
                    "cloud_cover_low": [20, 25],
                    "cloud_cover_mid": [25, 30],
                    "cloud_cover_high": [35, 40],
                    "wind_gusts_10m": [10, 12],
                    "wind_speed_10m": [5, 5],
                    "wind_direction_10m": [220, 220],
                }
            },
        )
        hours = {row.selected_hour for row in rows}
        # L'heure 14h sans température doit être écartée, pas scorée avec T=0
        self.assertNotIn("14h", hours)
        self.assertIn("15h", hours)

    def test_missing_cloud_cover_propagates_none_not_zero(self):
        point = wl.Point("Test-1", 45.0, 4.0, 0.1, 0.1)
        rows = wl.rows_for_location(
            point,
            {
                "hourly": {
                    "time": ["2026-05-08T15:00:00+02:00"],
                    "cape": [900],
                    "temperature_2m": [24],
                    "dew_point_2m": [16],
                    "relative_humidity_2m": [72],
                    "cloud_cover_low": [None],
                    "cloud_cover_mid": [None],
                    "cloud_cover_high": [None],
                    "wind_gusts_10m": [12],
                    "wind_speed_10m": [5],
                    "wind_direction_10m": [220],
                }
            },
        )
        self.assertEqual(len(rows), 1)
        # Donnée nuageuse absente => None (et non 0 % trompeur de ciel clair)
        self.assertIsNone(rows[0].cloud_cover_low)
        self.assertIsNone(rows[0].cloud_cover_mid)
        self.assertIsNone(rows[0].cloud_cover_high)

    def test_rows_expose_actual_cin_metrics(self):
        point = wl.Point("Test-1", 45.0, 4.0, 0.1, 0.1)
        rows = wl.rows_for_location(
            point,
            {
                "hourly": {
                    "time": ["2026-05-08T15:00:00+02:00"],
                    "cape": [900],
                    "temperature_2m": [24],
                    "dew_point_2m": [16],
                    "relative_humidity_2m": [72],
                    "vapour_pressure_deficit": [0.9],
                    "wet_bulb_temperature_2m": [18],
                    "precipitable_water": [32],
                    "shortwave_radiation": [520],
                    "convective_inhibition": [-42.6],
                    "cloud_cover_low": [25],
                    "cloud_cover_mid": [30],
                    "cloud_cover_high": [40],
                    "wind_gusts_10m": [12],
                    "wind_speed_10m": [5],
                    "wind_speed_100m": [14],
                    "wind_direction_10m": [220],
                    "wind_direction_100m": [240],
                }
            },
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row.convective_inhibition, -42.6)
        self.assertEqual(row.metrics_used["convective_inhibition_jkg"], -42.6)
        self.assertIsNotNone(row.metric_scores["cin_actual_score"])
        self.assertEqual(row.precipitable_water, 32)
        self.assertEqual(row.metrics_used["precipitable_water_kg_m2"], 32)
        self.assertIsNotNone(row.metric_scores["precipitable_water_score"])
        # Le flux net AROME brut (520, en réalité un cumul J/m² inexploitable) est REMPLACÉ par
        # l'ensoleillement estimé honnête (ciel clair × nébulosité) — cf. estimated_insolation_w_m2.
        expected_insol = round(wl.estimated_insolation_w_m2(
            wl.dt_from_iso("2026-05-08T15:00:00+02:00"), 45.0, 4.0, 25, 30, 40), 1)
        self.assertNotEqual(row.shortwave_radiation, 520)
        self.assertEqual(row.shortwave_radiation, expected_insol)
        self.assertEqual(row.metrics_used["shortwave_radiation_w_m2"], expected_insol)
        self.assertIsNotNone(row.metric_scores["shortwave_radiation_score"])

    def test_grid_rows_expose_surface_convergence_trigger_proxy(self):
        points = []
        locations = []
        directions = {
            (0, 1): 180,
            (1, 0): 270,
            (1, 1): 270,
            (1, 2): 90,
            (2, 1): 0,
        }
        for row in range(3):
            for col in range(3):
                point = wl.Point(f"P-{row}-{col}", 45.0 + (row - 1) * 0.1, 4.0 + (col - 1) * 0.1, 0.1, 0.1)
                direction = directions.get((row, col), 225)
                points.append(point)
                locations.append(
                    {
                        "hourly": {
                            "time": ["2026-05-08T15:00:00+02:00"],
                            "cape": [900],
                            "temperature_2m": [24],
                            "dew_point_2m": [16],
                            "relative_humidity_2m": [72],
                            "vapour_pressure_deficit": [0.9],
                            "wet_bulb_temperature_2m": [18],
                            "convective_inhibition": [None],
                            "cloud_cover_low": [25],
                            "cloud_cover_mid": [30],
                            "cloud_cover_high": [40],
                            "wind_gusts_10m": [12],
                            "wind_speed_10m": [10],
                            "wind_speed_100m": [14],
                            "wind_direction_10m": [direction],
                            "wind_direction_100m": [240],
                        }
                    }
                )

        rows = wl.rows_for_grid_locations(points, locations)
        center = next(row for row in rows if row.zone == "P-1-1")

        self.assertGreater(center.metrics_used["surface_convergence_1e4s"], 0)
        self.assertGreaterEqual(center.metric_scores["surface_trigger_score"], 75)


class TimeSlotTests(unittest.TestCase):
    def test_time_slots_are_hourly_for_full_day(self):
        self.assertEqual(len(wl.TIME_SLOTS), 24)
        self.assertEqual(wl.TIME_SLOTS[0], ("h00", 0, 0, "00h"))
        self.assertEqual(wl.TIME_SLOTS[-1], ("h23", 23, 23, "23h"))


class DeployedTriggerReconstructionTests(unittest.TestCase):
    """Reconstruction du trigger DÉPLOYÉ (pour l'autocalibration de la force du boost LI)."""

    def _cell(self, lifted_index):
        # Cellule archivée synthétique instable (LI très négatif → boost actif).
        return {
            "metric_scores": {
                "cape_score": 55, "surface_heating_score": 55,
                "dewpoint_score": 60, "humidity_score": 60, "vpd_score": 55,
                "wetbulb_score": 55, "precipitable_water_score": 55,
                "surface_trigger_score": 50, "cin_actual_score": 80,
                "shortwave_radiation_score": 60, "convective_activity_score": 30,
                "boundary_layer_score": 50,
                # champs d'activité MODESTES (sous la base) → boost activité ~nul, on isole le LI
                "cloud_trigger_score": 20, "precipitation_score": 15, "gust_potential_score": 20,
                "lifted_index": lifted_index,
            },
            "mucape": 1200.0, "shear_ms": 12.0,
            "selected_time_iso": "2026-07-15T15:00:00+02:00",
            "confidence_score": 70,
        }

    def test_reconstruction_equals_deploy_pipeline_no_double_count(self):
        cell = self._cell(-8.0)  # inst = min(4, -( -8+2)) = 4 → boost = gain·4
        base = wl.score_from_archived_cell(cell, None)
        self.assertIsNotNone(base)
        # Pipeline de déploiement à l'identique de rows_for_location : base → activité → LI.
        after_activity = wl.apply_activity_boost(base, wl._activity_metric_from_scores(cell["metric_scores"]))
        expected = wl.apply_lifted_index_boost(after_activity, -8.0)  # gain défaut actif
        got = wl.deployed_trigger_from_archived_cell(cell, None, None)
        self.assertEqual(got, expected)
        # Le gain explicite == défaut donne le même résultat.
        self.assertEqual(wl.deployed_trigger_from_archived_cell(cell, None, wl.LI_BOOST_GAIN), expected)
        # ANTI-DOUBLE-COMPTAGE : `got` est le trigger DÉPLOYÉ (= ce qui serait archivé). Rebooster
        # cette valeur déjà boostée (double-comptage) donnerait STRICTEMENT plus.
        self.assertGreater(got, base)                                 # le boost LI a bien agi
        self.assertLess(got, 100)                                     # pas de saturation
        self.assertGreater(wl.apply_lifted_index_boost(got, -8.0), got)  # doubler > got
        self.assertEqual(got, expected)                              # got ne double PAS

    def test_gain_zero_disables_li_and_gain_monotone(self):
        cell = self._cell(-8.0)
        base = wl.score_from_archived_cell(cell, None)
        after_activity = wl.apply_activity_boost(base, wl._activity_metric_from_scores(cell["metric_scores"]))
        # gain=0 → aucun boost LI (reste à la base + activité).
        self.assertEqual(wl.deployed_trigger_from_archived_cell(cell, None, 0), after_activity)
        # boost croissant avec le gain (LI actif).
        g4 = wl.deployed_trigger_from_archived_cell(cell, None, 4)
        g8 = wl.deployed_trigger_from_archived_cell(cell, None, 8)
        self.assertLess(after_activity, g4)
        self.assertLess(g4, g8)

    def test_stable_cell_and_missing_li_are_neutral(self):
        base_cell = self._cell(None)
        after_activity = wl.apply_activity_boost(
            wl.score_from_archived_cell(base_cell, None),
            wl._activity_metric_from_scores(base_cell["metric_scores"]),
        )
        # LI absent → aucun boost quel que soit le gain.
        self.assertEqual(wl.deployed_trigger_from_archived_cell(base_cell, None, 10), after_activity)
        # LI positif (stable, > -2) → onset non franchi → boost nul.
        stable = self._cell(3.0)
        after_stable = wl.apply_activity_boost(
            wl.score_from_archived_cell(stable, None),
            wl._activity_metric_from_scores(stable["metric_scores"]),
        )
        self.assertEqual(wl.deployed_trigger_from_archived_cell(stable, None, 10), after_stable)


if __name__ == "__main__":
    unittest.main()
