from datetime import date as Date
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import app as api_app


def _minimal_float32_tiff(width=3, height=3, center_value=290.15):
    entries = []
    values = [280.0] * (width * height)
    values[(height // 2) * width + (width // 2)] = center_value
    entry_count = 9
    data_offset = 8 + 2 + (entry_count * 12) + 4

    def short_entry(tag, value):
        entries.append(struct.pack("<HHI4s", tag, 3, 1, struct.pack("<H", value) + b"\x00\x00"))

    def long_entry(tag, value):
        entries.append(struct.pack("<HHII", tag, 4, 1, value))

    short_entry(256, width)
    short_entry(257, height)
    short_entry(258, 32)
    short_entry(259, 1)
    long_entry(273, data_offset)
    short_entry(277, 1)
    long_entry(278, height)
    long_entry(279, width * height * 4)
    short_entry(339, 3)

    header = b"II" + struct.pack("<HI", 42, 8)
    ifd = struct.pack("<H", entry_count) + b"".join(entries) + struct.pack("<I", 0)
    raster = struct.pack(f"<{len(values)}f", *values)
    return header + ifd + raster


def _minimal_grib2_message(length=24):
    payload_len = max(0, length - 16)
    return b"GRIB" + b"\x00\x00" + b"\x00" + b"\x02" + length.to_bytes(8, "big") + (b"0" * payload_len)


def _grib2_section(number, body):
    return (5 + len(body)).to_bytes(4, "big") + bytes([number]) + body


def _minimal_grib2_metadata_message(category=7, parameter_number=6, forecast_hour=3, surface_type=1, surface_value=0, length_padding=0):
    section_1 = _grib2_section(
        1,
        struct.pack(">HHBBBHBBBBBBB", 85, 0, 2, 0, 1, 2026, 5, 8, 0, 0, 0, 0, 1),
    )
    section_3 = _grib2_section(
        3,
        b"\x00" + (77).to_bytes(4, "big") + b"\x00\x00" + (0).to_bytes(2, "big"),
    )
    section_4_body = (
        (0).to_bytes(2, "big")
        + (0).to_bytes(2, "big")
        + bytes([category, parameter_number, 2, 0, 0])
        + (0).to_bytes(2, "big")
        + b"\x00"
        + bytes([1])
        + int(forecast_hour).to_bytes(4, "big", signed=True)
        + bytes([surface_type, 0])
        + int(surface_value).to_bytes(4, "big", signed=True)
        + b"\xff\xff\xff\xff\xff\xff"
    )
    section_4 = _grib2_section(4, section_4_body)
    section_5 = _grib2_section(5, (77).to_bytes(4, "big") + (0).to_bytes(2, "big"))
    payload = section_1 + section_3 + section_4 + section_5 + (b"x" * length_padding) + b"7777"
    total_length = 16 + len(payload)
    return b"GRIB" + b"\x00\x00" + b"\x00" + b"\x02" + total_length.to_bytes(8, "big") + payload


class CacheKeyTests(unittest.TestCase):
    def setUp(self):
        api_app._cache.clear()

    def tearDown(self):
        api_app._cache.clear()

    def test_latest_cache_key_keeps_nearby_centers_and_labels_distinct(self):
        day = Date(2026, 5, 7)

        lyon = api_app._latest_cache_key(45.76401, 4.83571, day, "auto", "Lyon")
        nearby = api_app._latest_cache_key(45.76491, 4.83571, day, "auto", "Lyon")
        other_label = api_app._latest_cache_key(45.76401, 4.83571, day, "auto", "Villeurbanne")

        self.assertNotEqual(lyon, nearby)
        self.assertNotEqual(lyon, other_label)

    def test_nearest_recent_cache_only_uses_latest_payloads_for_same_mode_and_date(self):
        day = Date(2026, 5, 7)
        expected_payload = {"meta": {"center": {"lat": 45.764, "lon": 4.8357, "label": "Lyon"}}}
        latest_key = api_app._latest_cache_key(45.764, 4.8357, day, "auto", "Lyon")
        api_app._set_cached_value(latest_key, expected_payload)
        api_app._set_cached_value("historical:45.7640:4.8357:2026-05-07:Lyon:historical:all", [{"not": "a latest payload"}])
        api_app._set_cached_value(api_app._latest_cache_key(45.764, 4.8357, day, "mock", "Lyon"), {"meta": {"mode": "mock"}})

        entry, distance = api_app._nearest_recent_cache(45.77, 4.84, day, "auto")

        self.assertIsNotNone(entry)
        self.assertLess(distance, 2)
        self.assertEqual(entry["payload"], expected_payload)


class MeteoFranceKeyTests(unittest.TestCase):
    def setUp(self):
        api_app._cache.clear()
        api_app._grib_auto_preload_jobs.clear()
        self._original_cache_dir = api_app.METEOFRANCE_PERSISTENT_CACHE_DIR
        self._tmp_cache_dir = Path(tempfile.mkdtemp(prefix="objectifoudre-mf-cache-"))
        api_app.METEOFRANCE_PERSISTENT_CACHE_DIR = self._tmp_cache_dir

    def tearDown(self):
        api_app._cache.clear()
        api_app._grib_auto_preload_jobs.clear()
        api_app.METEOFRANCE_PERSISTENT_CACHE_DIR = self._original_cache_dir
        shutil.rmtree(self._tmp_cache_dir, ignore_errors=True)

    def test_clean_meteofrance_api_key_accepts_portal_headers(self):
        self.assertEqual(api_app._clean_meteofrance_api_key("apikey: abc12345"), "abc12345")
        self.assertEqual(api_app._clean_meteofrance_api_key("Authorization: Bearer abc12345"), "abc12345")
        self.assertEqual(api_app._clean_meteofrance_api_key("Bearer abc12345"), "abc12345")

    def test_meteofrance_api_key_test_detects_wms_and_wcs_capabilities(self):
        class FakeResponse:
            def __init__(self, body):
                self.body = body

            status = 200
            headers = {"content-type": "text/xml"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return self.body

        wms_body = b"<WMS_Capabilities><Capability><Layer></Layer></Capability></WMS_Capabilities>"
        wcs_body = b"""<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0">
        <wcs:Contents>
          <wcs:CoverageSummary><wcs:CoverageId>CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
          <wcs:CoverageSummary><wcs:CoverageId>WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
        </wcs:Contents></wcs:Capabilities>"""

        def fake_urlopen(request, timeout=None):
            body = wcs_body if "/wcs/" in request.full_url else wms_body
            return FakeResponse(body)

        with patch("app.urllib.request.urlopen", side_effect=fake_urlopen) as mocked_urlopen:
            result = api_app._test_meteofrance_api_key_sync("abc12345")

        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(request.get_header("apikey") or request.get_header("Apikey"), "abc12345")
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], 200)
        self.assertTrue(result["wcs"]["objecti_foudre_ready"])
        self.assertEqual(result["wcs"]["ready_count"], result["wcs"]["required_count"])

    def test_meteofrance_wcs_capabilities_are_cached_per_api_key(self):
        class FakeResponse:
            def __init__(self, body):
                self.body = body

            status = 200
            headers = {"content-type": "text/xml"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return self.body

        wcs_body = b"""<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0">
        <wcs:Contents>
          <wcs:CoverageSummary><wcs:CoverageId>TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
        </wcs:Contents></wcs:Capabilities>"""

        with patch("app.urllib.request.urlopen", return_value=FakeResponse(wcs_body)) as mocked_urlopen:
            first = api_app._build_meteofrance_wcs_capabilities("abc12345")
            second = api_app._build_meteofrance_wcs_capabilities("abc12345")

        self.assertEqual(mocked_urlopen.call_count, 1)
        self.assertFalse(first["metadata_cache_hit"])
        self.assertTrue(second["metadata_cache_hit"])

    def test_meteofrance_wcs_grid_date_status_limits_direct_grid_horizon(self):
        today = Date(2026, 5, 8)

        self.assertTrue(api_app._meteofrance_arome_wcs_grid_date_status(Date(2026, 5, 8), today)["ok"])
        self.assertTrue(api_app._meteofrance_arome_wcs_grid_date_status(Date(2026, 5, 9), today)["ok"])
        too_far = api_app._meteofrance_arome_wcs_grid_date_status(Date(2026, 5, 10), today)
        too_old = api_app._meteofrance_arome_wcs_grid_date_status(Date(2026, 5, 7), today)
        grib_yesterday = api_app._meteofrance_arome_wcs_grid_date_status(Date(2026, 5, 7), today, allow_previous_day=True)

        self.assertFalse(too_far["ok"])
        self.assertFalse(too_old["ok"])
        self.assertTrue(grib_yesterday["ok"])
        self.assertEqual(grib_yesterday["supported_start"], "2026-05-07")
        self.assertEqual(too_far["supported_until"], "2026-05-09")

    def test_meteofrance_time_subset_accepts_dot_separated_begin_position(self):
        description = {
            "begin_position": "2026-05-08T00.00.00Z",
            "axes": {"time": ["0", "3600", "7200", "10800"]},
        }

        selected, meta = api_app._select_meteofrance_time_subset_for_hour(description, Date(2026, 5, 8), 3)

        self.assertEqual(selected, "3600")
        self.assertEqual(meta["target_offset_seconds"], 3600)
        self.assertEqual(meta["delta_seconds"], 0)

    def test_meteofrance_time_range_subset_selects_day_offsets(self):
        description = {
            "begin_position": "2026-05-08T00.00.00Z",
            "axes": {"time": [str(hour * 3600) for hour in range(24)]},
        }

        selected, meta = api_app._select_meteofrance_time_range_subset_for_hours(description, Date(2026, 5, 8), 2, 5)

        self.assertEqual(selected, "0,10800")
        self.assertEqual(meta["start_hour"], 2)
        self.assertEqual(meta["end_hour"], 5)
        self.assertEqual(meta["start_delta_seconds"], 0)
        self.assertEqual(meta["end_delta_seconds"], 0)

    def test_meteofrance_multitime_probe_variants_include_single_control(self):
        variants = api_app._meteofrance_multitime_probe_variants("0,75600")

        self.assertEqual([variant["name"] for variant in variants], [
            "numeric_range",
            "quoted_numeric_range",
            "repeated_bounds",
            "single_start_control",
        ])
        self.assertEqual(variants[0]["time_subsets"], ["0,75600"])
        self.assertEqual(variants[-1]["time_subsets"], ["0"])
        self.assertFalse(variants[-1]["multi"])

    def test_package_catalog_links_extract_grid_and_package_ids(self):
        payload = {
            "links": [
                {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids", "title": "self"},
                {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025", "title": "Grille 0,025°"},
                {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1", "title": "Paramètres courants"},
            ]
        }

        grids = api_app._catalog_items_from_links(payload, "/grids/")
        packages = api_app._catalog_items_from_links(payload, "/packages/")

        self.assertEqual(grids[0]["id"], "0.025")
        self.assertEqual(packages[0]["id"], "SP1")
        self.assertIn("/v1/models/AROME", grids[0]["href"])

    def test_probe_meteofrance_model_packages_discovers_products(self):
        def fake_fetch(_api_key, url):
            if url.endswith("/models/AROME/grids"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.01", "title": "Grille 0,01°"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025", "title": "Grille 0,025°"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1", "title": "Paramètres courants à la surface"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP2", "title": "Paramètres additionnels à la surface"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages/SP1"):
                return 200, "application/json", {
                    "description": "P(mer), U(10m), V(10m), T(2m), HU(2m).",
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1?referencetime=2026-05-08T00:00:00Z", "title": "Réseau 00 UTC"}
                    ],
                }
            if "packages/SP1?referencetime=2026-05-08T00%3A00%3A00Z" in url or "packages/SP1?referencetime=2026-05-08T00:00:00Z" in url:
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1/productARO?referencetime=2026-05-08T00:00:00Z&time=00H06H&format=grib2", "time": "00H06H", "reference_time": "2026-05-08T00:00:00Z"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1/productARO?referencetime=2026-05-08T00:00:00Z&time=07H12H&format=grib2", "time": "07H12H", "reference_time": "2026-05-08T00:00:00Z"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages/SP2"):
                return 200, "application/json", {"description": "Additionnels.", "links": []}
            raise AssertionError(url)

        with patch("app._fetch_meteofrance_package_json", side_effect=fake_fetch):
            result = api_app._probe_meteofrance_model_packages_sync("abc12345")

        self.assertTrue(result["ok"])
        self.assertEqual(result["selected_grid"], "0.025")
        self.assertEqual(result["inspected_packages"][0]["id"], "SP1")
        self.assertEqual(result["inspected_packages"][0]["time_groups"], ["00H06H", "07H12H"])

    def test_package_candidate_summary_prioritizes_vertical_profiles(self):
        summary = api_app._summarize_meteofrance_package_candidates(
            [
                {"id": "SP1", "title": "Paramètres surface"},
                {"id": "IP1", "title": "Température et humidité sur niveaux isobares"},
                {"id": "HP1", "title": "Vent sur niveaux hauteur"},
            ]
        )

        self.assertEqual(summary["profile_candidates"][0]["id"], "IP1")
        self.assertIn("HP1", summary["recommended_profile_package_ids"])
        self.assertEqual(summary["surface_candidates"][0]["id"], "SP1")

    def test_probe_meteofrance_model_packages_inspect_all_prefers_profile_candidates(self):
        def fake_fetch(_api_key, url):
            if url.endswith("/models/AROME/grids"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025", "title": "Grille 0,025°"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1", "title": "Paramètres surface"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/IP1", "title": "Température humidité niveaux isobares"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/HP1", "title": "Vent niveaux hauteur"},
                    ]
                }
            for package_id in ("IP1", "HP1"):
                if url.endswith(f"/models/AROME/grids/0.025/packages/{package_id}"):
                    return 200, "application/json", {
                        "description": "Profils verticaux.",
                        "links": [
                            {"href": f"https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/{package_id}?referencetime=2026-05-08T00:00:00Z", "title": "Réseau 00 UTC"}
                        ],
                    }
                if f"packages/{package_id}?referencetime=" in url:
                    return 200, "application/json", {
                        "links": [
                            {"href": f"https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/{package_id}/productARO?referencetime=2026-05-08T00:00:00Z&time=00H06H&format=grib2", "time": "00H06H", "reference_time": "2026-05-08T00:00:00Z"},
                        ]
                    }
            raise AssertionError(url)

        with patch("app._fetch_meteofrance_package_json", side_effect=fake_fetch):
            result = api_app._probe_meteofrance_model_packages_sync(
                "abc12345",
                inspect_all=True,
                max_inspected_packages=2,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["inspected_package_ids"], ["IP1", "HP1"])
        self.assertEqual(result["inspected_packages"][0]["candidate"]["role"], "profile_candidate")

    def test_scan_grib_messages_reads_grib2_header(self):
        info = api_app._scan_grib_messages(_minimal_grib2_message())

        self.assertTrue(info["is_grib"])
        self.assertEqual(info["message_count_in_sample"], 1)
        self.assertEqual(info["messages"][0]["edition"], 2)
        self.assertEqual(info["messages"][0]["length"], 24)

    def test_parse_grib2_metadata_extracts_product_section(self):
        message = _minimal_grib2_metadata_message(category=7, parameter_number=6, forecast_hour=3)
        header = api_app._parse_grib_header(message, 0)
        metadata = api_app._parse_grib2_metadata(message, 0, header["length"])

        self.assertTrue(metadata["metadata_complete"])
        self.assertEqual(metadata["product"]["parameter_key"], "0.7.6")
        self.assertEqual(metadata["product"]["parameter_label"], "CAPE")
        self.assertEqual(metadata["product"]["forecast_hour"], 3)
        self.assertEqual(metadata["product"]["level"], "surface")
        self.assertEqual(metadata["grid"]["data_points"], 77)
        self.assertEqual(api_app._grib2_parameter_label(0, 2, 0), "Direction du vent")
        self.assertEqual(api_app._grib2_parameter_label(0, 2, 1), "Vitesse du vent")
        self.assertEqual(api_app._grib2_parameter_label(0, 1, 52), "Taux de précipitations total")
        self.assertEqual(api_app._grib2_parameter_label(0, 4, 9), "Flux net rayonnement court")
        self.assertEqual(api_app._grib2_parameter_label(0, 1, 84), "Glace nuageuse spécifique")
        self.assertEqual(api_app._grib2_parameter_label(0, 2, 12), "Tourbillon relatif")
        self.assertEqual(api_app._grib2_parameter_label(0, 16, 192), "Réflectivité radar pluie")
        self.assertEqual(api_app._grib2_parameter_label(0, 19, 11), "Énergie cinétique turbulente")

    def test_index_grib_message_headers_walks_offsets_with_range(self):
        package = _minimal_grib2_message(24) + _minimal_grib2_message(32)

        def fake_fetch(_api_key, _url, range_bytes=None, range_start=0):
            chunk = package[range_start:range_start + range_bytes]
            return 206, "application/octet-stream", chunk, {"content-range": f"bytes {range_start}-{range_start + len(chunk) - 1}/{len(package)}"}

        with patch("app._fetch_meteofrance_package_bytes", side_effect=fake_fetch) as mocked_fetch:
            index = api_app._index_grib_message_headers("abc12345", "https://example.test/productARO", max_messages=8)

        self.assertTrue(index["complete"])
        self.assertEqual(index["message_count_indexed"], 2)
        self.assertEqual(index["messages"][0]["offset"], 0)
        self.assertEqual(index["messages"][1]["offset"], 24)
        self.assertEqual(mocked_fetch.call_count, 2)

    def test_index_grib_message_headers_summarizes_product_metadata(self):
        package = (
            _minimal_grib2_metadata_message(category=7, parameter_number=6, forecast_hour=0)
            + _minimal_grib2_metadata_message(category=7, parameter_number=7, forecast_hour=1)
        )

        def fake_fetch(_api_key, _url, range_bytes=None, range_start=0):
            chunk = package[range_start:range_start + range_bytes]
            return 206, "application/octet-stream", chunk, {"content-range": f"bytes {range_start}-{range_start + len(chunk) - 1}/{len(package)}"}

        with patch("app._fetch_meteofrance_package_bytes", side_effect=fake_fetch):
            index = api_app._index_grib_message_headers("abc12345", "https://example.test/productARO", max_messages=8)

        self.assertTrue(index["complete"])
        self.assertEqual(index["parameter_summary"]["parameter_count"], 2)
        self.assertEqual(index["parameter_summary"]["product_metadata_count"], 2)
        self.assertEqual(index["parameter_summary"]["forecast_hours"], [0, 1])
        self.assertEqual([item["label"] for item in index["parameter_summary"]["parameters"]], ["CAPE", "CIN"])

    def test_index_grib_message_headers_cached_extends_existing_prefix(self):
        package = (
            _minimal_grib2_metadata_message(category=2, parameter_number=2, forecast_hour=0)
            + _minimal_grib2_metadata_message(category=2, parameter_number=3, forecast_hour=0)
            + _minimal_grib2_metadata_message(category=2, parameter_number=12, forecast_hour=0)
        )
        fetch_offsets = []

        def fake_fetch(_api_key, _url, range_bytes=None, range_start=0):
            fetch_offsets.append(range_start)
            chunk = package[range_start:range_start + range_bytes]
            return 206, "application/octet-stream", chunk, {"content-range": f"bytes {range_start}-{range_start + len(chunk) - 1}/{len(package)}"}

        with patch("app._fetch_meteofrance_package_bytes", side_effect=fake_fetch):
            first = api_app._index_grib_message_headers_cached("abc12345", "https://example.test/productARO", max_messages=1)
            second = api_app._index_grib_message_headers_cached("abc12345", "https://example.test/productARO", max_messages=3)

        self.assertEqual(first["message_count_indexed"], 1)
        self.assertEqual(second["message_count_indexed"], 3)
        self.assertEqual(second["range_request_count"], 2)
        self.assertEqual(second["cached_range_request_count"], 1)
        self.assertEqual(fetch_offsets, [0, first["next_offset"], second["messages"][1]["end_offset"]])
        labels = [item["label"] for item in second["parameter_summary"]["parameters"]]
        self.assertIn("Vent U", labels)
        self.assertIn("Vent V", labels)
        self.assertIn("Tourbillon relatif", labels)

    def test_index_grib_message_headers_cached_target_stop_can_extend_later(self):
        package = _minimal_grib2_message(24) * 4
        fetch_offsets = []

        def fake_fetch(_api_key, _url, range_bytes=None, range_start=0):
            fetch_offsets.append(range_start)
            chunk = package[range_start:range_start + range_bytes]
            return 206, "application/octet-stream", chunk, {"content-range": f"bytes {range_start}-{range_start + len(chunk) - 1}/{len(package)}"}

        with patch("app._fetch_meteofrance_package_bytes", side_effect=fake_fetch):
            first = api_app._index_grib_message_headers_cached(
                "abc12345",
                "https://example.test/product-target-stop",
                max_messages=4,
                stop_when=lambda messages: len(messages) >= 2,
            )
            cached = api_app._index_grib_message_headers_cached(
                "abc12345",
                "https://example.test/product-target-stop",
                max_messages=4,
                stop_when=lambda messages: len(messages) >= 2,
            )
            full = api_app._index_grib_message_headers_cached(
                "abc12345",
                "https://example.test/product-target-stop",
                max_messages=4,
            )

        self.assertEqual(first["message_count_indexed"], 2)
        self.assertEqual(first["range_request_count"], 2)
        self.assertEqual(cached["message_count_indexed"], 2)
        self.assertEqual(cached["range_request_count"], 0)
        self.assertEqual(full["message_count_indexed"], 4)
        self.assertEqual(full["range_request_count"], 2)
        self.assertEqual(full["cached_range_request_count"], 2)
        self.assertEqual(fetch_offsets, [0, 24, 48, 72])

    def test_probe_meteofrance_grib_package_uses_range_download(self):
        resolved = {
            "statuses": [{"step": "run", "status": 200, "content_type": "application/json"}],
            "grid": "0.025",
            "package_id": "SP1",
            "package_title": "Paramètres courants",
            "reference_time": "2026-05-08T00:00:00Z",
            "available_time_groups": ["00H06H"],
            "product": {
                "time": "00H06H",
                "href": "https://example.test/productARO?time=00H06H",
                "reference_time": "2026-05-08T00:00:00Z",
            },
        }

        with patch("app._resolve_meteofrance_package_product", return_value=resolved), \
            patch("app._fetch_meteofrance_package_bytes", return_value=(206, "application/octet-stream", _minimal_grib2_message(), {"content-range": "bytes 0-23/24000"})) as mocked_fetch:
            result = api_app._probe_meteofrance_grib_package_sync("abc12345", range_bytes=24)

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], 206)
        self.assertEqual(result["total_size"], 24000)
        self.assertEqual(result["grib"]["message_count_in_sample"], 1)
        mocked_fetch.assert_called_once()

    def test_probe_meteofrance_grib_index_uses_header_ranges(self):
        resolved = {
            "statuses": [{"step": "run", "status": 200, "content_type": "application/json"}],
            "grid": "0.025",
            "package_id": "SP1",
            "package_title": "Paramètres courants",
            "reference_time": "2026-05-08T00:00:00Z",
            "available_time_groups": ["00H06H"],
            "product": {
                "time": "00H06H",
                "href": "https://example.test/productARO?time=00H06H",
                "reference_time": "2026-05-08T00:00:00Z",
            },
        }
        index = {
            "messages": [{"offset": 0, "edition": 2, "discipline": 0, "length": 24, "end_offset": 24}],
            "message_count_indexed": 1,
            "next_offset": 24,
            "total_size": 24,
            "complete": True,
            "truncated": False,
            "range_request_count": 1,
            "statuses": [{"offset": 0, "status": 206, "content_type": "application/octet-stream"}],
        }

        with patch("app._resolve_meteofrance_package_product", return_value=resolved), \
            patch("app._index_grib_message_headers", return_value=index):
            result = api_app._probe_meteofrance_grib_index_sync("abc12345", max_messages=8)

        self.assertTrue(result["ok"])
        self.assertEqual(result["index"]["message_count_indexed"], 1)
        self.assertEqual(result["total_size"], 24)

    def test_probe_meteofrance_grib_profile_indexes_selected_packages(self):
        def fake_fetch(_api_key, url):
            if url.endswith("/models/AROME/grids"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025", "title": "Grille 0,025°"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages"):
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1", "title": "Surface 1"},
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP2", "title": "Surface 2"},
                    ]
                }
            if url.endswith("/models/AROME/grids/0.025/packages/SP1"):
                return 200, "application/json", {
                    "description": "Vent.",
                    "links": [{"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1?referencetime=2026-05-08T00:00:00Z"}],
                }
            if url.endswith("/models/AROME/grids/0.025/packages/SP2"):
                return 200, "application/json", {
                    "description": "Thermo.",
                    "links": [{"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP2?referencetime=2026-05-08T00:00:00Z"}],
                }
            if "packages/SP1?referencetime=" in url:
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP1/productARO?referencetime=2026-05-08T00:00:00Z&time=00H06H&format=grib2", "time": "00H06H"},
                    ]
                }
            if "packages/SP2?referencetime=" in url:
                return 200, "application/json", {
                    "links": [
                        {"href": "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/models/AROME/grids/0.025/packages/SP2/productARO?referencetime=2026-05-08T00:00:00Z&time=00H06H&format=grib2", "time": "00H06H"},
                    ]
                }
            raise AssertionError(url)

        def fake_index(_api_key, href, max_messages=32, metadata_bytes=4096, **_kwargs):
            if "SP2" in href:
                label = "CAPE"
                key = "0.7.6"
            else:
                label = "Vitesse du vent"
                key = "0.2.1"
            return {
                "messages": [
                    {
                        "offset": 0,
                        "edition": 2,
                        "discipline": 0,
                        "length": 24,
                        "end_offset": 24,
                        "product": {
                            "parameter_key": key,
                            "parameter_label": label,
                            "forecast_hour": 0,
                            "level": "surface",
                        },
                    }
                ],
                "message_count_indexed": 1,
                "next_offset": 24,
                "total_size": 24000,
                "complete": False,
                "truncated": True,
                "range_request_count": 32,
                "parameter_summary": {
                    "product_metadata_count": 1,
                    "parameter_count": 1,
                    "forecast_hours": [0],
                    "parameters": [{"key": key, "label": label, "count": 1, "levels": ["surface"], "forecast_hours": [0]}],
                },
                "statuses": [{"offset": 0, "status": 206, "content_type": "application/octet-stream"}],
            }

        with patch("app._fetch_meteofrance_package_json", side_effect=fake_fetch), \
            patch("app._index_grib_message_headers", side_effect=fake_index):
            result = api_app._probe_meteofrance_grib_profile_sync("abc12345", package_ids=["SP1", "SP2"], requested_time_group="00H06H")

        self.assertTrue(result["ok"])
        self.assertFalse(result["grib_profile_cache_hit"])
        self.assertEqual(result["total_range_request_count"], 64)
        self.assertEqual(result["cached_total_range_request_count"], 0)
        self.assertEqual(len(result["package_profiles"]), 2)
        by_key = {item["key"]: item for item in result["combined_parameter_summary"]["parameters"]}
        self.assertEqual(by_key["0.7.6"]["packages"], ["SP2"])
        self.assertEqual(by_key["0.2.1"]["packages"], ["SP1"])
        plan_fields = {item["field"]: item for item in result["objectifoudre_plan"]["fields"]}
        self.assertEqual(plan_fields["cape"]["package_id"], "SP2")
        self.assertEqual(plan_fields["convective_inhibition"]["status"], "not_listed")

        cached = api_app._probe_meteofrance_grib_profile_sync("abc12345", package_ids=["SP1", "SP2"], requested_time_group="00H06H")
        self.assertTrue(cached["grib_profile_cache_hit"])
        self.assertEqual(cached["total_range_request_count"], 0)
        self.assertEqual(cached["cached_total_range_request_count"], 64)
        self.assertIn("0 requête Range API", cached["message"])
        self.assertEqual(cached["objectifoudre_plan"]["by_package"]["SP2"][0]["package_id"], "SP2")

    def test_probe_meteofrance_grib_target_message_downloads_selected_message(self):
        resolved = {
            "statuses": [{"step": "run", "status": 200, "content_type": "application/json"}],
            "grid": "0.025",
            "package_id": "SP2",
            "package_title": "Surface 2",
            "reference_time": "2026-05-08T00:00:00Z",
            "available_time_groups": ["00H06H"],
            "product": {
                "time": "00H06H",
                "href": "https://example.test/SP2/productARO?time=00H06H",
                "reference_time": "2026-05-08T00:00:00Z",
            },
        }
        selected_message = {
            "offset": 2048,
            "edition": 2,
            "discipline": 0,
            "length": 128,
            "end_offset": 2176,
            "product": {
                "parameter_key": "0.0.0",
                "parameter_label": "Température",
                "forecast_hour": 0,
                "level": "2 m sol",
            },
        }
        index = {
            "messages": [
                {
                    "offset": 0,
                    "edition": 2,
                    "discipline": 0,
                    "length": 64,
                    "end_offset": 64,
                    "product": {"parameter_key": "0.1.0", "parameter_label": "Humidité spécifique", "forecast_hour": 0},
                },
                selected_message,
            ],
            "message_count_indexed": 2,
            "next_offset": 2176,
            "total_size": 24000,
            "complete": False,
            "truncated": False,
            "range_request_count": 2,
            "parameter_summary": {"parameter_count": 2, "parameters": []},
            "statuses": [{"offset": 0, "status": 206, "content_type": "application/octet-stream"}],
        }
        decode = {
            "ok": True,
            "message": "Message GRIB décodé avec eccodes.",
            "metadata": {"shortName": "2t", "Ni": 11, "Nj": 7},
            "values": {"readable": True, "count": 77, "finite_count": 77, "min": 280.0, "max": 292.0, "sample": [285.0]},
        }
        sample_zones = []

        def fake_sample(_raw, points, max_points=9):
            zone = points[0].zone if points else "none"
            sample_zones.append(zone)
            return {"ok": True, "samples": [{"zone": zone, "value": 10.1}], "valid_count": 1, "count": 1}

        with patch("app._detect_grib_decoder_status", return_value={"can_decode_grib": True, "preferred_decoder": "eccodes"}), \
            patch("app._resolve_meteofrance_package_product", return_value=resolved), \
            patch("app._index_grib_message_headers", return_value=index) as mocked_index, \
            patch("app._fetch_meteofrance_package_bytes", return_value=(206, "application/octet-stream", b"GRIB" + (b"\x00" * 124), {"content-range": "bytes 2048-2175/24000"})) as mocked_fetch, \
            patch("app._decode_grib_message_with_eccodes", return_value=decode) as mocked_decode, \
            patch("app._sample_grib_message_nearest_with_eccodes", side_effect=fake_sample) as mocked_sample:
            result = api_app._probe_meteofrance_grib_target_message_sync("abc12345", label="Lyon")
            cached = api_app._probe_meteofrance_grib_target_message_sync("abc12345", lat=48.8566, lon=2.3522, label="Paris")

        self.assertTrue(result["ok"])
        self.assertEqual(result["selected_message"]["offset"], 2048)
        self.assertEqual(result["total_range_request_count"], 3)
        self.assertFalse(result["grib_target_cache_hit"])
        self.assertEqual(result["decode"]["metadata"]["shortName"], "2t")
        self.assertEqual(result["nearest_samples"]["valid_count"], 1)
        mocked_fetch.assert_called_once_with(
            "abc12345",
            resolved["product"]["href"],
            range_bytes=128,
            range_start=2048,
        )
        mocked_index.assert_called_once()
        self.assertEqual(mocked_decode.call_count, 2)
        self.assertEqual(mocked_sample.call_count, 2)
        self.assertTrue(cached["grib_target_cache_hit"])
        self.assertEqual(cached["total_range_request_count"], 0)
        self.assertEqual(cached["selected_message"]["offset"], 2048)
        self.assertTrue(cached["nearest_samples"]["samples"][0]["zone"].startswith("Paris"))
        self.assertEqual(len(sample_zones), 2)

    def test_grib_slot_index_limit_is_lower_for_known_surface_packages(self):
        self.assertEqual(api_app._meteofrance_grib_slot_index_limit("SP1"), 24)
        self.assertEqual(api_app._meteofrance_grib_slot_index_limit("SP2"), 80)
        self.assertEqual(api_app._meteofrance_grib_slot_index_limit("IP1"), 96)

    def test_grib_target_message_extends_index_when_initial_slice_misses_target(self):
        initial_index = {
            "messages": [],
            "message_count_indexed": 24,
            "complete": False,
            "range_request_count": 24,
        }
        extended_message = {
            "offset": 10,
            "length": 20,
            "product": {
                "parameter_key": "0.2.1",
                "parameter_label": "Vitesse du vent",
                "forecast_hour": 5,
                "level": "10 m",
            },
        }
        extended_index = {
            "messages": [extended_message],
            "message_count_indexed": 25,
            "complete": False,
            "range_request_count": 1,
        }

        with patch("app._index_grib_message_headers_cached", return_value=extended_index) as mocked_index:
            index, selected, retry_ranges = api_app._ensure_grib_target_message_indexed(
                "abc12345",
                "https://example.test/product.grib",
                "SP1",
                [{"parameter_label": "Vitesse du vent", "level_contains": "10 m"}],
                5,
                "Vitesse du vent",
                "10 m",
                initial_index,
            )

        self.assertIs(index, extended_index)
        self.assertEqual(selected, extended_message)
        self.assertEqual(retry_ranges, 1)
        self.assertEqual(mocked_index.call_args.kwargs["max_messages"], api_app._meteofrance_grib_slot_index_retry_limit("SP1"))

    def test_grib_target_message_can_fallback_to_previous_boundary_hour_for_temp_and_gusts(self):
        index = {
            "messages": [
                {
                    "offset": 10,
                    "length": 20,
                    "product": {
                        "parameter_key": "0.0.0",
                        "parameter_label": "Température",
                        "forecast_hour": 5,
                        "level": "2 m sol",
                    },
                }
            ],
            "message_count_indexed": 1,
            "complete": True,
        }

        out_index, selected, retry_ranges = api_app._ensure_grib_target_message_indexed(
            "abc12345",
            "https://example.test/product.grib",
            "SP2",
            [{"parameter_label": "Température", "level_contains": "2 m"}],
            6,
            "Température",
            "2 m",
            index,
            field="temperature_2m",
        )

        self.assertIs(out_index, index)
        self.assertEqual(retry_ranges, 0)
        self.assertIsNotNone(selected)
        self.assertEqual(selected["_forecast_hour_fallback"], "previous-hour-boundary")
        self.assertEqual(selected["_requested_forecast_hour"], 6)
        self.assertEqual(selected["_message_forecast_hour"], 5)

    def test_grib_target_selection_can_require_exact_forecast_hour(self):
        index = {
            "messages": [
                {
                    "product": {
                        "parameter_label": "Température",
                        "parameter_key": "0.0.0",
                        "forecast_hour": 13,
                        "level": "2 m",
                    }
                }
            ]
        }

        fallback = api_app._select_grib_target_message(index, "Température", 18, "2 m")
        exact_only = api_app._select_grib_target_message(
            index,
            "Température",
            18,
            "2 m",
            allow_forecast_fallback=False,
        )

        self.assertIsNotNone(fallback)
        self.assertIsNone(exact_only)

    def test_fetch_meteofrance_package_bytes_retries_remote_disconnect(self):
        class FakeResponse:
            status = 206
            headers = {"content-type": "application/octet-stream", "content-range": "bytes 0-3/4"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return b"GRIB"

        calls = []

        def fake_urlopen(_request, timeout=None):
            calls.append(timeout)
            if len(calls) == 1:
                raise api_app.http.client.RemoteDisconnected("Remote end closed connection without response")
            return FakeResponse()

        with patch("app.urllib.request.urlopen", side_effect=fake_urlopen):
            status, content_type, raw, headers = api_app._fetch_meteofrance_package_bytes(
                "abc12345",
                "https://example.test/product",
                range_bytes=4,
            )

        self.assertEqual(status, 206)
        self.assertEqual(content_type, "application/octet-stream")
        self.assertEqual(raw, b"GRIB")
        self.assertEqual(headers["content-range"], "bytes 0-3/4")
        self.assertEqual(len(calls), 2)

    def test_grib_auto_preload_scheduler_deduplicates_running_jobs(self):
        background_tasks = api_app.BackgroundTasks()
        time_target = {"time_group_bounds": [0, 6], "forecast_hour_raw": 5}

        first = api_app._schedule_meteofrance_grib_auto_preload(
            background_tasks,
            "abc12345",
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            5,
            None,
            api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            time_target,
        )
        second = api_app._schedule_meteofrance_grib_auto_preload(
            background_tasks,
            "abc12345",
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            4,
            None,
            api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            {"time_group_bounds": [0, 6], "forecast_hour_raw": 4},
        )
        boundary = api_app._schedule_meteofrance_grib_auto_preload(
            background_tasks,
            "abc12345",
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            6,
            None,
            api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            {"time_group_bounds": [0, 6], "forecast_hour_raw": 6},
        )

        self.assertTrue(first["scheduled"])
        self.assertFalse(second["scheduled"])
        self.assertTrue(second["already_running"])
        self.assertFalse(boundary["scheduled"])
        self.assertTrue(boundary["already_running"])
        self.assertEqual(len(background_tasks.tasks), 1)
        self.assertEqual(first["progress"]["completed_count"], 0)
        self.assertEqual(first["progress"]["hour_count"], 7)
        status = api_app._grib_auto_preload_status(first["job_key"])
        self.assertTrue(status["ok"])
        self.assertTrue(status["running"])
        self.assertEqual(status["percent"], 0)

    def test_grib_auto_preload_scheduler_skips_recent_completed_job(self):
        background_tasks = api_app.BackgroundTasks()
        time_target = {"time_group_bounds": [0, 6], "forecast_hour_raw": 3}
        first = api_app._schedule_meteofrance_grib_auto_preload(
            background_tasks,
            "abc12345",
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            3,
            None,
            api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            time_target,
        )
        api_app._grib_auto_preload_jobs[first["job_key"]].update(
            {"running": False, "ok": True, "finished_at": time.time(), "ok_count": 7, "hour_count": 7}
        )

        second = api_app._schedule_meteofrance_grib_auto_preload(
            background_tasks,
            "abc12345",
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            6,
            None,
            api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            {"time_group_bounds": [0, 6], "forecast_hour_raw": 6},
        )

        self.assertTrue(first["scheduled"])
        self.assertFalse(second["scheduled"])
        self.assertTrue(second["already_done"])
        self.assertEqual(second["ok_count"], 7)
        self.assertEqual(len(background_tasks.tasks), 1)

    def test_grib_auto_preload_scheduler_skips_fully_cached_block(self):
        background_tasks = api_app.BackgroundTasks()
        time_target = {"time_group_bounds": [0, 6], "forecast_hour_raw": 3}

        with patch(
            "app._meteofrance_grib_slot_grid_cache_coverage",
            return_value={
                "complete": True,
                "ok_count": 7,
                "hour_count": 7,
                "cached_total_range_request_count": 231,
            },
        ) as mocked_coverage:
            result = api_app._schedule_meteofrance_grib_auto_preload(
                background_tasks,
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                3,
                None,
                api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
                time_target,
            )

        self.assertFalse(result["scheduled"])
        self.assertTrue(result["already_done"])
        self.assertTrue(result["already_cached"])
        self.assertEqual(result["ok_count"], 7)
        self.assertEqual(result["cached_total_range_request_count"], 231)
        self.assertEqual(len(background_tasks.tasks), 0)
        mocked_coverage.assert_called_once()

    def test_grib_day_preload_scheduler_schedules_24h_background_job(self):
        background_tasks = api_app.BackgroundTasks()

        with patch(
            "app._meteofrance_grib_slot_grid_cache_coverage",
            return_value={
                "complete": False,
                "ok_count": 0,
                "hour_count": 24,
                "cached_total_range_request_count": 0,
            },
        ) as mocked_coverage:
            result = api_app._schedule_meteofrance_grib_day_preload(
                background_tasks,
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                12,
                None,
                api_app.METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            )

        self.assertTrue(result["scheduled"])
        self.assertEqual(result["scope"], "day")
        self.assertEqual(result["max_hours"], 24)
        self.assertEqual(result["hours"], list(range(24)))
        self.assertEqual(result["progress"]["hour_count"], 24)
        self.assertEqual(result["progress"]["scope"], "day")
        self.assertEqual(len(background_tasks.tasks), 1)
        status = api_app._grib_auto_preload_status(result["job_key"])
        self.assertTrue(status["ok"])
        self.assertTrue(status["running"])
        self.assertEqual(status["scope"], "day")
        self.assertEqual(status["hour_count"], 24)
        self.assertGreaterEqual(status["elapsed_ms"], 0)
        mocked_coverage.assert_called_once()

    def test_grib_national_day_scheduler_retries_partial_finished_job(self):
        job_key = api_app._meteofrance_grib_national_preload_job_key(
            "abc12345",
            None,
            Date(2026, 5, 10),
        )
        api_app._grib_auto_preload_jobs[job_key] = {
            "running": False,
            "ok": True,
            "finished_at": time.time(),
            "updated_at": time.time(),
            "scope": "national_day",
            "hours": list(range(24)),
            "hour_count": 24,
            "unit_count": 192,
            "unit_label": "champ(s)",
            "ok_count": 21,
            "failed_count": 171,
            "completed_count": 192,
        }
        background_tasks = api_app.BackgroundTasks()

        result = api_app._schedule_meteofrance_grib_national_day_preload(
            background_tasks,
            "abc12345",
            Date(2026, 5, 10),
            None,
        )

        self.assertTrue(result["scheduled"])
        self.assertFalse(result.get("already_done", False))
        self.assertEqual(len(background_tasks.tasks), 1)
        self.assertTrue(api_app._grib_auto_preload_jobs[job_key]["running"])
        self.assertEqual(api_app._grib_auto_preload_jobs[job_key]["ok_count"], 0)

    def test_grib_national_day_scheduler_preserves_partial_job_during_cooldown(self):
        job_key = api_app._meteofrance_grib_national_preload_job_key(
            "abc12345",
            None,
            Date(2026, 5, 10),
        )
        api_app._grib_auto_preload_jobs[job_key] = {
            "running": False,
            "ok": True,
            "finished_at": time.time(),
            "updated_at": time.time(),
            "scope": "national_day",
            "hours": list(range(24)),
            "hour_count": 24,
            "unit_count": 192,
            "unit_label": "champ(s)",
            "ok_count": 152,
            "failed_count": 40,
            "completed_count": 192,
        }
        api_app._set_meteofrance_quota_cooldown(
            "abc12345",
            api_app.METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
            {"status": 429, "message": "Quota Météo-France dépassé."},
        )
        background_tasks = api_app.BackgroundTasks()

        result = api_app._schedule_meteofrance_grib_national_day_preload(
            background_tasks,
            "abc12345",
            Date(2026, 5, 10),
            None,
        )

        self.assertFalse(result["scheduled"])
        self.assertTrue(result["quota_cooldown"])
        self.assertEqual(len(background_tasks.tasks), 0)
        self.assertEqual(result["progress"]["ok_count"], 152)
        self.assertEqual(result["progress"]["failed_count"], 40)
        self.assertEqual(api_app._grib_auto_preload_jobs[job_key]["ok_count"], 152)
        self.assertFalse(api_app._grib_auto_preload_jobs[job_key]["running"])

    def test_grib_national_day_scheduler_keeps_complete_finished_job_done(self):
        job_key = api_app._meteofrance_grib_national_preload_job_key(
            "abc12345",
            None,
            Date(2026, 5, 10),
        )
        api_app._grib_auto_preload_jobs[job_key] = {
            "running": False,
            "ok": True,
            "finished_at": time.time(),
            "updated_at": time.time(),
            "scope": "national_day",
            "hours": list(range(24)),
            "hour_count": 24,
            "unit_count": len(api_app._grib_slot_required_fields()) * 24,
            "unit_label": "champ(s)",
            "ok_count": len(api_app._grib_slot_required_fields()) * 24,
            "failed_count": 0,
            "completed_count": len(api_app._grib_slot_required_fields()) * 24,
        }
        background_tasks = api_app.BackgroundTasks()

        with patch(
            "app._meteofrance_grib_france_slot_grid_cache_coverage",
            return_value={
                "complete": True,
                "cached_hours": list(range(24)),
                "missing_hours": [],
                "ok_count": 24,
                "hour_count": 24,
                "cached_total_range_request_count": 0,
            },
        ):
            result = api_app._schedule_meteofrance_grib_national_day_preload(
                background_tasks,
                "abc12345",
                Date(2026, 5, 10),
                None,
            )

        self.assertFalse(result["scheduled"])
        self.assertTrue(result["already_done"])
        self.assertEqual(len(background_tasks.tasks), 0)

    def test_grib_national_day_scheduler_can_start_without_background_tasks(self):
        with patch("app.threading.Thread") as mocked_thread:
            result = api_app._schedule_meteofrance_grib_national_day_preload(
                None,
                "abc12345",
                Date(2026, 5, 10),
                None,
            )

        self.assertTrue(result["scheduled"])
        mocked_thread.assert_called_once()
        mocked_thread.return_value.start.assert_called_once()

    def test_server_arome_preload_dates_accepts_relative_and_iso_days(self):
        with patch.object(api_app, "OBJECTIFOUDRE_AUTO_PRELOAD_DAYS", "veille,today,tomorrow,2026-05-20,bad"):
            dates = api_app._server_arome_preload_dates(Date(2026, 5, 18))

        self.assertEqual(
            dates,
            [
                Date(2026, 5, 17),
                Date(2026, 5, 18),
                Date(2026, 5, 19),
                Date(2026, 5, 20),
            ],
        )

    def test_sample_grib_message_nearest_with_eccodes_filters_missing_and_converts_temperature(self):
        calls = []
        fake_eccodes = types.SimpleNamespace()
        fake_eccodes.codes_new_from_message = lambda message: "handle"
        fake_eccodes.codes_get = lambda _handle, key: {"shortName": "t", "missingValue": 9999.0}.get(key)
        fake_eccodes.codes_grib_find_nearest = lambda _handle, lat, lon, is_lsm, npoints: ({"lat": lat, "lon": lon, "value": 280.0, "distance": 1.2, "index": 42},)
        fake_eccodes.codes_release = lambda handle: calls.append(("release", handle))
        point = types.SimpleNamespace(zone="Test-1", lat=45.0, lon=4.0)

        with patch.dict(sys.modules, {"eccodes": fake_eccodes}):
            sampled = api_app._sample_grib_message_nearest_with_eccodes(b"GRIB-test", [point])

        self.assertTrue(sampled["ok"])
        self.assertEqual(sampled["samples"][0]["value"], 6.85)
        self.assertEqual(sampled["valid_count"], 1)
        self.assertEqual(calls[-1], ("release", "handle"))

    def test_grib_temperature_conversion_handles_min_2t_short_name(self):
        metadata = {"shortName": "min_2t", "missingValue": 9999.0}

        self.assertEqual(api_app._convert_grib_nearest_value(283.15, metadata), 10.0)
        self.assertEqual(api_app._convert_meteofrance_grib_field_value("temperature_2m", 283.15, metadata), 10.0)

    def test_choose_grib_product_for_slot_uses_reference_time_and_local_hour(self):
        product, meta = api_app._choose_meteofrance_grib_product_for_slot(
            [
                {"time": "00H06H", "href": "https://example.test/00"},
                {"time": "07H12H", "href": "https://example.test/07"},
            ],
            "2026-05-10T00:00:00Z",
            Date(2026, 5, 10),
            10,
        )

        self.assertEqual(product["time"], "07H12H")
        self.assertEqual(meta["forecast_hour"], 8)
        self.assertEqual(meta["forecast_hour_delta"], 0)

    def test_choose_grib_run_product_prefers_older_exact_run(self):
        statuses = []
        runs = [
            {"reference_time": "2026-05-10T12:00:00Z", "href": "https://example.test/run-12"},
            {"reference_time": "2026-05-10T00:00:00Z", "href": "https://example.test/run-00"},
        ]

        def fake_fetch(_api_key, url):
            if url.endswith("run-12"):
                return 200, "application/json", {"links": [{"time": "00H06H", "href": "https://example.test/new-00"}]}
            if url.endswith("run-00"):
                return 200, "application/json", {"links": [{"time": "07H12H", "href": "https://example.test/old-07"}]}
            raise AssertionError(url)

        with patch("app._fetch_meteofrance_package_json", side_effect=fake_fetch):
            choice = api_app._choose_meteofrance_grib_run_product_for_slot(
                "abc12345",
                statuses,
                runs,
                Date(2026, 5, 10),
                10,
            )

        self.assertEqual(choice["run"]["reference_time"], "2026-05-10T00:00:00Z")
        self.assertEqual(choice["run_index"], 1)
        self.assertEqual(choice["product"]["time"], "07H12H")
        self.assertEqual(choice["time_target"]["forecast_hour"], 8)
        self.assertTrue(choice["time_target"]["exact_forecast_hour"])
        self.assertEqual(len(statuses), 2)

    def test_grib_local_hours_for_time_group_translates_forecast_bounds(self):
        hours = api_app._meteofrance_grib_local_hours_for_time_group(
            {"forecast_hour_raw": 13, "time_group_bounds": [13, 18]},
            15,
        )

        self.assertEqual(hours, [15, 16, 17, 18, 19, 20])

    def test_grib_preload_time_group_builds_each_local_hour(self):
        resolved = {
            "time_target": {"forecast_hour_raw": 13, "time_group_bounds": [13, 18]},
        }
        built_hours = []

        def fake_build(_api_key, _lat, _lon, _label, _date, hour, requested_grid=None, detail_level="core"):
            built_hours.append(hour)
            return {
                "ok": True,
                "status": 206,
                "message": f"h{hour}",
                "payload": {
                    "meta": {
                        "slot_grid_cache_hit": hour == 15,
                        "total_range_request_count": 0 if hour == 15 else 2,
                        "cached_total_range_request_count": 10 if hour == 15 else 0,
                        "field_request_count": len(api_app._grib_slot_required_fields()),
                    }
                },
            }

        with patch("app._resolve_meteofrance_package_product_for_slot", return_value=resolved), \
            patch("app._build_meteofrance_grib_slot_grid_sync", side_effect=fake_build):
            result = api_app._preload_meteofrance_grib_slot_grids_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                15,
                max_hours=8,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["hours"], [15, 16, 17, 18, 19, 20])
        self.assertEqual(built_hours, [15, 16, 17, 18, 19, 20])
        self.assertEqual(result["total_range_request_count"], 10)
        self.assertEqual(result["cached_total_range_request_count"], 10)
        self.assertEqual(result["slot_grid_cache_hit_count"], 1)

    def test_grib_preload_reports_progress_callback(self):
        resolved = {
            "time_target": {"forecast_hour_raw": 13, "time_group_bounds": [13, 15]},
        }
        updates = []

        def fake_build(_api_key, _lat, _lon, _label, _date, hour, requested_grid=None, detail_level="core"):
            return {
                "ok": True,
                "status": 206,
                "message": f"h{hour}",
                "payload": {
                    "meta": {
                        "slot_grid_cache_hit": hour == 15,
                        "total_range_request_count": 0 if hour == 15 else 2,
                        "cached_total_range_request_count": 10 if hour == 15 else 0,
                        "field_request_count": len(api_app._grib_slot_required_fields()),
                    }
                },
            }

        with patch("app._resolve_meteofrance_package_product_for_slot", return_value=resolved), \
            patch("app._build_meteofrance_grib_slot_grid_sync", side_effect=fake_build):
            result = api_app._preload_meteofrance_grib_slot_grids_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                15,
                max_hours=8,
                progress_callback=updates.append,
            )

        self.assertTrue(result["ok"])
        self.assertGreaterEqual(len(updates), 4)
        self.assertEqual(updates[0]["completed_count"], 0)
        self.assertEqual(updates[0]["hour_count"], 3)
        self.assertEqual(updates[-1]["completed_count"], 3)
        self.assertEqual(updates[-1]["ok_count"], 3)
        self.assertEqual(updates[-1]["cached_total_range_request_count"], 10)

    def test_grib_preload_partial_result_reports_failed_hour(self):
        resolved = {
            "time_target": {"forecast_hour_raw": 13, "time_group_bounds": [13, 15]},
        }

        def fake_build(_api_key, _lat, _lon, _label, _date, hour, requested_grid=None, detail_level="core"):
            if hour == 16:
                return {
                    "ok": False,
                    "status": 206,
                    "message": "Message GRIB introuvable dans l’index.",
                    "payload": {
                        "meta": {
                            "total_range_request_count": 0,
                            "missing_fields": ["cape"],
                            "field_request_count": len(api_app._grib_slot_required_fields()),
                        }
                    },
                }
            return {
                "ok": True,
                "status": 206,
                "message": f"h{hour}",
                "payload": {
                    "meta": {
                        "slot_grid_cache_hit": False,
                        "total_range_request_count": 2,
                        "field_request_count": len(api_app._grib_slot_required_fields()),
                    }
                },
            }

        with patch("app._resolve_meteofrance_package_product_for_slot", return_value=resolved), \
            patch("app._build_meteofrance_grib_slot_grid_sync", side_effect=fake_build):
            result = api_app._preload_meteofrance_grib_slot_grids_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                15,
                max_hours=8,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["ok_count"], 2)
        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["failed_hours"], [16])
        self.assertIn("partiel", result["message"])
        self.assertEqual(result["failure_summary"][0]["missing_fields"], ["cape"])

    def test_grib_preload_stops_after_quota_error(self):
        resolved = {
            "time_target": {"forecast_hour_raw": 13, "time_group_bounds": [13, 15]},
        }
        built_hours = []

        def fake_build(_api_key, _lat, _lon, _label, _date, hour, requested_grid=None, detail_level="core"):
            built_hours.append(hour)
            if hour == 16:
                return {
                    "ok": False,
                    "status": 429,
                    "message": "Quota Météo-France dépassé pour cette clé.",
                    "quota_cooldown_seconds": 1200,
                }
            return {
                "ok": True,
                "status": 206,
                "message": f"h{hour}",
                "payload": {
                    "meta": {
                        "slot_grid_cache_hit": hour == 15,
                        "total_range_request_count": 0,
                        "cached_total_range_request_count": 98,
                        "field_request_count": len(api_app._grib_slot_required_fields()),
                    }
                },
            }

        with patch("app._resolve_meteofrance_package_product_for_slot", return_value=resolved), \
            patch("app._build_meteofrance_grib_slot_grid_sync", side_effect=fake_build):
            result = api_app._preload_meteofrance_grib_slot_grids_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                15,
                max_hours=8,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(built_hours, [15, 16])
        self.assertEqual(result["ok_count"], 1)
        self.assertEqual(result["failed_hours"], [16, 17])
        self.assertEqual(result["quota_cooldown_seconds"], 1200)
        self.assertFalse(result["failure_summary"][0]["skipped_due_to_quota"])
        self.assertTrue(result["failure_summary"][1]["skipped_due_to_quota"])

    def test_grib_slot_grid_cache_reports_zero_live_ranges(self):
        key = api_app._meteofrance_grib_slot_grid_cache_key(
            "abc12345",
            None,
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            15,
            "core",
        )
        self.assertIn(api_app.METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION, key)
        api_app._set_cached_value(
            key,
            {
                "ok": True,
                "status": 206,
                "message": "Grille Météo-France GRIB générée pour 15h : 169 cellules, 98 Range API.",
                "payload": {
                    "meta": {
                        "slot_grid_cache_hit": False,
                        "total_range_request_count": 98,
                        "index_range_request_count": 79,
                        "message_range_request_count": 19,
                        "field_requests": [{"field": field, "ok": True} for field in api_app._grib_slot_required_fields()],
                    },
                    "days": [
                        {
                            "day_key": "2026-05-10",
                            "slots": [
                                {"slot_key": "h15", "cells": [{} for _ in range(169)]},
                            ],
                        }
                    ],
                },
                "cache_hit": False,
            },
        )

        with patch("app._meteofrance_arome_wcs_grid_date_status", return_value={"ok": True, "message": "", "supported_start": "2026-05-10", "supported_until": "2026-05-11"}):
            result = api_app._build_meteofrance_grib_slot_grid_sync("abc12345", 45.764, 4.8357, "Lyon", Date(2026, 5, 10), 15)

        meta = result["payload"]["meta"]
        self.assertTrue(result["cache_hit"])
        self.assertEqual(meta["total_range_request_count"], 0)
        self.assertEqual(meta["cached_total_range_request_count"], 98)
        self.assertEqual(meta["cached_index_range_request_count"], 79)
        self.assertEqual(meta["cached_message_range_request_count"], 19)
        self.assertEqual(meta["grib_slot_grid_algorithm_version"], api_app.METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION)
        self.assertIn("0 Range API", result["message"])

    def test_grib_slot_grid_cache_only_never_builds_missing_grid(self):
        with patch("app._meteofrance_quota_cooldown_result", side_effect=AssertionError("quota check")), \
            patch("app._resolve_meteofrance_package_product_for_slot", side_effect=AssertionError("api call")):
            result = api_app._get_meteofrance_grib_slot_grid_cached_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                15,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 404)
        self.assertTrue(result["cache_only"])
        self.assertEqual(result["total_range_request_count"], 0)

    def test_grib_cache_status_lists_cached_hours_without_api(self):
        for hour in (15, 16):
            key = api_app._meteofrance_grib_slot_grid_cache_key(
                "abc12345",
                None,
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                hour,
                "core",
            )
            api_app._set_cached_value(
                key,
                {
                    "ok": True,
                    "payload": {"meta": {"total_range_request_count": 12, "field_requests": [{"field": field, "ok": True} for field in api_app._grib_slot_required_fields()]}},
                    "cache_hit": False,
                },
            )

        with patch("app._resolve_meteofrance_package_product_for_slot", side_effect=AssertionError("api call")):
            result = api_app._meteofrance_grib_slot_grid_cache_status_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["cached_hours"], [15, 16])
        self.assertEqual(result["cached_slot_keys"], ["h15", "h16"])
        self.assertEqual(result["cached_count"], 2)
        self.assertEqual(result["hour_count"], 24)
        self.assertEqual(result["cached_total_range_request_count"], 24)

    def test_grib_france_slot_grid_cache_only_reports_zero_live_ranges(self):
        key = api_app._meteofrance_grib_france_slot_grid_cache_key(
            "abc12345",
            None,
            Date(2026, 5, 10),
            15,
            "core",
        )
        api_app._set_cached_value(
            key,
            {
                "ok": True,
                "status": 206,
                "message": "Grille France Météo-France GRIB générée pour 15h : 1800 cellules, 98 Range API.",
                "payload": {
                    "meta": {
                        "grid_scope": "france",
                        "france_grid": True,
                        "slot_grid_cache_hit": False,
                        "total_range_request_count": 98,
                        "index_range_request_count": 79,
                        "message_range_request_count": 19,
                        "field_requests": [{"field": field, "ok": True} for field in api_app._grib_slot_required_fields()],
                    },
                    "days": [
                        {
                            "day_key": "2026-05-10",
                            "slots": [
                                {"slot_key": "h15", "cells": [{} for _ in range(1800)]},
                            ],
                        }
                    ],
                },
                "cache_hit": False,
            },
        )

        with patch("app._resolve_meteofrance_package_product_for_slot", side_effect=AssertionError("api call")):
            result = api_app._get_meteofrance_grib_france_slot_grid_cached_sync(
                "abc12345",
                Date(2026, 5, 10),
                15,
            )

        meta = result["payload"]["meta"]
        self.assertTrue(result["ok"])
        self.assertTrue(result["cache_hit"])
        self.assertTrue(meta["slot_grid_cache_hit"])
        self.assertTrue(meta["france_grid"])
        self.assertEqual(meta["grid_scope"], "france")
        self.assertEqual(meta["total_range_request_count"], 0)
        self.assertEqual(meta["cached_total_range_request_count"], 98)
        self.assertIn("France", result["message"])
        self.assertIn("0 Range API", result["message"])

    def test_grib_france_cache_status_lists_cached_hours_without_api(self):
        for hour in (15, 16):
            key = api_app._meteofrance_grib_france_slot_grid_cache_key(
                "abc12345",
                None,
                Date(2026, 5, 10),
                hour,
                "core",
            )
            api_app._set_cached_value(
                key,
                {
                    "ok": True,
                    "payload": {
                        "meta": {
                            "grid_scope": "france",
                            "france_grid": True,
                            "total_range_request_count": 12,
                            "field_requests": [{"field": field, "ok": True} for field in api_app._grib_slot_required_fields()],
                        }
                    },
                    "cache_hit": False,
                },
            )

        with patch("app._resolve_meteofrance_package_product_for_slot", side_effect=AssertionError("api call")):
            result = api_app._meteofrance_grib_france_slot_grid_cache_status_sync(
                "abc12345",
                Date(2026, 5, 10),
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["france_grid"])
        self.assertEqual(result["grid_scope"], "france")
        self.assertEqual(result["cached_hours"], [15, 16])
        self.assertEqual(result["cached_slot_keys"], ["h15", "h16"])
        self.assertEqual(result["cached_count"], 2)
        self.assertEqual(result["hour_count"], 24)
        self.assertEqual(result["cached_total_range_request_count"], 24)

    def test_sample_national_field_cache_uses_grid_metadata(self):
        field_cache_key = "national-field-test"
        payload = {
            "metadata": {
                "Ni": 2,
                "Nj": 2,
                "latitudeOfFirstGridPointInDegrees": 1.0,
                "latitudeOfLastGridPointInDegrees": 0.0,
                "longitudeOfFirstGridPointInDegrees": 0.0,
                "longitudeOfLastGridPointInDegrees": 1.0,
                "iDirectionIncrementInDegrees": 1.0,
                "jDirectionIncrementInDegrees": 1.0,
            },
            "value_count": 4,
            "byteorder": api_app._current_float32_byteorder_label(),
        }
        api_app._set_cached_value(f"{field_cache_key}:values", api_app.array("f", [10.0, 11.0, 20.0, 21.0]))
        points = [
            types.SimpleNamespace(zone="A", lat=1.0, lon=1.0),
            types.SimpleNamespace(zone="B", lat=0.0, lon=0.0),
        ]

        sampled = api_app._sample_meteofrance_grib_national_field_cache(field_cache_key, payload, "temperature_2m", points)

        self.assertTrue(sampled["ok"])
        self.assertEqual(sampled["valid_count"], 2)
        values = {item["zone"]: item["value"] for item in sampled["samples"]}
        self.assertEqual(values, {"A": 11.0, "B": 20.0})

    def test_grib_slot_grid_uses_national_field_cache_before_message_fetch(self):
        message = {
            "offset": 12,
            "length": 34,
            "product": {
                "parameter_label": "Température",
                "forecast_hour": 0,
                "level": "2 m sol",
            },
        }
        product_href = "https://example.test/sp2.grib"
        field_cache_key = api_app._meteofrance_grib_national_field_cache_key(None, product_href, message, "temperature_2m")
        payload = {
            "metadata": {
                "shortName": "2t",
                "name": "Temperature",
                "units": "C",
                "Ni": 2,
                "Nj": 2,
                "latitudeOfFirstGridPointInDegrees": 1.0,
                "latitudeOfLastGridPointInDegrees": 0.0,
                "longitudeOfFirstGridPointInDegrees": 0.0,
                "longitudeOfLastGridPointInDegrees": 1.0,
                "iDirectionIncrementInDegrees": 1.0,
                "jDirectionIncrementInDegrees": 1.0,
            },
            "value_count": 4,
            "byteorder": api_app._current_float32_byteorder_label(),
        }
        api_app._set_cached_value(field_cache_key, payload)
        api_app._set_cached_value(f"{field_cache_key}:values", api_app.array("f", [10.0, 11.0, 20.0, 21.0]))
        point = types.SimpleNamespace(zone="Test-1", lat=1.0, lon=1.0, cell_height_deg=0.1, cell_width_deg=0.1)

        with patch(
            "app.METEOFRANCE_GRIB_SLOT_GRID_SPECS",
            [
                {
                    "field": "temperature_2m",
                    "package_id": "SP2",
                    "parameter_label": "Température",
                    "level_contains": "2 m",
                    "required": True,
                }
            ],
        ), patch(
            "app._meteofrance_arome_wcs_grid_date_status",
            return_value={"ok": True},
        ), patch(
            "app._detect_grib_decoder_status",
            return_value={"can_decode_grib": True, "message": "ok"},
        ), patch(
            "app.build_grid",
            return_value=[point],
        ), patch(
            "app._resolve_meteofrance_package_product_for_slot",
            return_value={
                "product": {"href": product_href, "time": "00H06H"},
                "time_target": {"forecast_hour": 0, "forecast_hour_raw": 0, "time_group_bounds": [0, 6]},
            },
        ), patch(
            "app._index_grib_message_headers_cached",
            return_value={"messages": [message], "range_request_count": 0, "cached_range_request_count": 8, "cache": {"hit": True}},
        ), patch(
            "app._fetch_grib_message_cached",
            side_effect=AssertionError("must not fetch message when national field is cached"),
        ):
            result = api_app._build_meteofrance_grib_slot_grid_sync(
                "abc12345",
                1.0,
                1.0,
                "Test",
                Date(2026, 5, 10),
                0,
            )

        self.assertTrue(result["ok"])
        self.assertIn("cache national", result["message"])
        meta = result["payload"]["meta"]
        self.assertEqual(meta["total_range_request_count"], 0)
        self.assertEqual(meta["cached_total_range_request_count"], 8)
        self.assertEqual(meta["national_field_cache_hit_count"], 1)
        self.assertEqual(meta["field_requests"][0]["national_field_cache_hit"], True)
        cell = result["payload"]["days"][0]["slots"][0]["cells"][0]
        self.assertEqual(cell["temp_c"], 11.0)

    def test_build_meteofrance_france_grid_points_covers_mainland_and_corsica(self):
        points = api_app._build_meteofrance_france_grid_points()

        self.assertGreater(len(points), 1500)
        self.assertLess(len(points), 6000)
        self.assertTrue(any(48.7 <= point.lat <= 49.1 and 2.1 <= point.lon <= 2.6 for point in points))
        self.assertTrue(any(41.7 <= point.lat <= 42.7 and 8.6 <= point.lon <= 9.4 for point in points))
        self.assertFalse(any(point.lon < -6 or point.lon > 10 for point in points))
        self.assertTrue(api_app._is_meteofrance_france_grid_point(48.85, 2.35))
        self.assertTrue(api_app._is_meteofrance_france_grid_point(42.2, 9.05))
        self.assertFalse(api_app._is_meteofrance_france_grid_point(45.3, -3.2))
        self.assertFalse(api_app._is_meteofrance_france_grid_point(49.6, -3.3))

    def test_grib_france_slot_grid_uses_national_cache(self):
        message = {
            "offset": 12,
            "length": 34,
            "product": {
                "parameter_label": "Température",
                "forecast_hour": 0,
                "level": "2 m sol",
            },
        }
        product_href = "https://example.test/sp2.grib"
        field_cache_key = api_app._meteofrance_grib_national_field_cache_key(None, product_href, message, "temperature_2m")
        payload = {
            "metadata": {
                "shortName": "2t",
                "name": "Temperature",
                "units": "C",
                "Ni": 2,
                "Nj": 2,
                "latitudeOfFirstGridPointInDegrees": 1.0,
                "latitudeOfLastGridPointInDegrees": 0.0,
                "longitudeOfFirstGridPointInDegrees": 0.0,
                "longitudeOfLastGridPointInDegrees": 1.0,
                "iDirectionIncrementInDegrees": 1.0,
                "jDirectionIncrementInDegrees": 1.0,
            },
            "value_count": 4,
            "byteorder": api_app._current_float32_byteorder_label(),
        }
        api_app._set_cached_value(field_cache_key, payload)
        api_app._set_cached_value(f"{field_cache_key}:values", api_app.array("f", [10.0, 11.0, 20.0, 21.0]))
        point = types.SimpleNamespace(zone="France-1", lat=1.0, lon=1.0, cell_height_deg=0.1, cell_width_deg=0.1)

        with patch(
            "app.METEOFRANCE_GRIB_SLOT_GRID_SPECS",
            [
                {
                    "field": "temperature_2m",
                    "package_id": "SP2",
                    "parameter_label": "Température",
                    "level_contains": "2 m",
                    "required": True,
                }
            ],
        ), patch(
            "app._build_meteofrance_france_grid_points",
            return_value=[point],
        ), patch(
            "app._meteofrance_arome_wcs_grid_date_status",
            return_value={"ok": True},
        ), patch(
            "app._detect_grib_decoder_status",
            return_value={"can_decode_grib": True, "message": "ok"},
        ), patch(
            "app._resolve_meteofrance_package_product_for_slot",
            return_value={
                "product": {"href": product_href, "time": "00H06H"},
                "time_target": {"forecast_hour": 0, "forecast_hour_raw": 0, "time_group_bounds": [0, 6]},
            },
        ), patch(
            "app._index_grib_message_headers_cached",
            return_value={"messages": [message], "range_request_count": 0, "cached_range_request_count": 8, "cache": {"hit": True}},
        ), patch(
            "app._fetch_grib_message_cached",
            side_effect=AssertionError("must not fetch message when national field is cached"),
        ):
            result = api_app._build_meteofrance_grib_france_slot_grid_sync(
                "abc12345",
                Date(2026, 5, 10),
                0,
            )

        self.assertTrue(result["ok"])
        self.assertIn("France", result["message"])
        meta = result["payload"]["meta"]
        self.assertTrue(meta["france_grid"])
        self.assertEqual(meta["grid_scope"], "france")
        self.assertEqual(meta["country_mask"], "france")
        self.assertEqual(meta["france_grid_cell_count"], 1)
        slot = result["payload"]["days"][0]["slots"][0]
        self.assertEqual(slot["grid_scope"], "france")
        self.assertEqual(slot["country_mask"], "france")
        self.assertTrue(slot["france_grid"])
        self.assertEqual(meta["national_field_cache_hit_count"], 1)
        self.assertEqual(meta["total_range_request_count"], 0)
        self.assertEqual(meta["cached_total_range_request_count"], 8)

    def test_grib_slot_grid_requires_exact_forecast_hour(self):
        with patch(
            "app.METEOFRANCE_GRIB_SLOT_GRID_SPECS",
            [
                {
                    "field": "cape",
                    "package_id": "SP2",
                    "parameter_label": "CAPE",
                    "level_contains": None,
                    "required": True,
                }
            ],
        ), patch(
            "app._meteofrance_arome_wcs_grid_date_status",
            return_value={"ok": True},
        ), patch(
            "app._detect_grib_decoder_status",
            return_value={"can_decode_grib": True, "message": "ok"},
        ), patch(
            "app._resolve_meteofrance_package_product_for_slot",
            return_value={
                "product": {"href": "https://example.test/sp2.grib", "time": "00H06H"},
                "time_target": {"forecast_hour": 5, "forecast_hour_raw": 5, "time_group_bounds": [0, 6]},
            },
        ), patch(
            "app._index_grib_message_headers_cached",
            return_value={
                "messages": [
                    {
                        "offset": 123,
                        "length": 456,
                        "product": {
                            "parameter_label": "CAPE",
                            "parameter_key": "0.7.6",
                            "forecast_hour": 4,
                            "level": "surface",
                        },
                    }
                ],
                "range_request_count": 1,
                "cache": {"hit": False},
            },
        ), patch(
            "app._find_grib_target_in_alternate_run",
            return_value=(None, None, None, 0, 0),
        ), patch(
            "app._fetch_grib_message_cached",
            side_effect=AssertionError("must not fetch non-exact hour"),
        ):
            result = api_app._build_meteofrance_grib_slot_grid_sync(
                "abc12345",
                45.764,
                4.8357,
                "Lyon",
                Date(2026, 5, 10),
                7,
            )

        self.assertFalse(result["ok"])
        self.assertIn("cape", result["missing_fields"])
        self.assertEqual(result["field_requests"][0]["forecast_hour"], 5)
        self.assertIn("introuvable", result["field_requests"][0]["message"])

    def test_grib_advanced_request_is_served_as_core_cache_before_quota_check(self):
        key = api_app._meteofrance_grib_slot_grid_cache_key(
            "abc12345",
            None,
            45.764,
            4.8357,
            "Lyon",
            Date(2026, 5, 10),
            15,
            "core",
        )
        api_app._set_cached_value(
            key,
            {
                "ok": True,
                "status": 206,
                "message": "Grille Météo-France GRIB générée pour 15h : 169 cellules, 98 Range API.",
                "payload": {
                    "meta": {
                        "detail_level": "core",
                        "slot_grid_cache_hit": False,
                        "total_range_request_count": 98,
                        "index_range_request_count": 79,
                        "message_range_request_count": 19,
                        "field_requests": [{"field": field, "ok": True} for field in api_app._grib_slot_required_fields()],
                        "optional_missing_fields": [],
                    },
                    "days": [
                        {
                            "day_key": "2026-05-10",
                            "slots": [
                                {"slot_key": "h15", "cells": [{} for _ in range(169)]},
                            ],
                        }
                    ],
                },
                "cache_hit": False,
            },
        )

        with patch("app._meteofrance_arome_wcs_grid_date_status", return_value={"ok": True, "message": "", "supported_start": "2026-05-10", "supported_until": "2026-05-11"}), \
            patch("app._meteofrance_quota_cooldown_result", side_effect=AssertionError("quota check")):
            result = api_app._build_meteofrance_grib_slot_grid_sync("abc12345", 45.764, 4.8357, "Lyon", Date(2026, 5, 10), 15, detail_level="advanced")

        meta = result["payload"]["meta"]
        self.assertTrue(result["cache_hit"])
        self.assertEqual(meta["detail_level"], "core")
        self.assertEqual(meta["total_range_request_count"], 0)
        self.assertEqual(meta["cached_total_range_request_count"], 98)
        self.assertNotIn("advanced_core_cache_fallback", meta)
        self.assertNotIn("wind_profile_850hpa", meta.get("optional_missing_fields", []))
        self.assertIn("0 Range API", result["message"])

    def test_decode_grib_message_with_eccodes_uses_local_one_arg_api(self):
        calls = []

        fake_eccodes = types.SimpleNamespace()

        def fake_new_from_message(message):
            calls.append(("new", message))
            return "handle"

        def fake_get(_handle, key):
            if key == "shortName":
                return "2t"
            if key == "Ni":
                return 2
            if key == "Nj":
                return 2
            if key == "missingValue":
                return 9999.0
            return None

        fake_eccodes.codes_new_from_message = fake_new_from_message
        fake_eccodes.codes_get = fake_get
        fake_eccodes.codes_get_values = lambda _handle: [9999.0, 280.0, 281.0, 282.0, 283.0]
        fake_eccodes.codes_release = lambda handle: calls.append(("release", handle))

        with patch.dict(sys.modules, {"eccodes": fake_eccodes}):
            decoded = api_app._decode_grib_message_with_eccodes(b"GRIB-test")

        self.assertTrue(decoded["ok"])
        self.assertEqual(calls[0], ("new", b"GRIB-test"))
        self.assertEqual(decoded["metadata"]["shortName"], "2t")
        self.assertEqual(decoded["values"]["min"], 280.0)
        self.assertEqual(decoded["values"]["valid_count"], 4)
        self.assertEqual(decoded["values"]["converted"]["min"], 6.85)
        self.assertEqual(calls[-1], ("release", "handle"))

    def test_detect_grib_decoder_status_reports_available_decoder(self):
        def fake_find_spec(name):
            return object() if name == "eccodes" else None

        def fake_which(name):
            return "/usr/bin/wgrib2" if name == "wgrib2" else None

        with patch("app.importlib.util.find_spec", side_effect=fake_find_spec), \
            patch("app.shutil.which", side_effect=fake_which):
            status = api_app._detect_grib_decoder_status()

        self.assertTrue(status["can_decode_grib"])
        self.assertEqual(status["preferred_decoder"], "eccodes")
        self.assertIn("wgrib2", [item["name"] for item in status["commands"] if item["available"]])

    def test_extract_geotiff_center_sample_reads_float32_temperature(self):
        tiff = _minimal_float32_tiff(center_value=290.15)

        sample = api_app._extract_geotiff_center_sample(tiff)

        self.assertTrue(sample["readable"])
        self.assertAlmostEqual(sample["center_value"], 290.15, places=2)
        self.assertAlmostEqual(sample["temperature_c"], 17.0, places=1)

    def test_inspect_tiff_structure_reports_single_ifd(self):
        tiff = _minimal_float32_tiff(center_value=290.15)

        info = api_app._inspect_tiff_structure(tiff)

        self.assertTrue(info["is_tiff"])
        self.assertEqual(info["ifd_count"], 1)
        self.assertEqual(info["first_width"], 3)
        self.assertEqual(info["first_height"], 3)

    def test_extract_geotiff_raster_samples_bbox_nearest_value(self):
        tiff = _minimal_float32_tiff(center_value=291.15)

        raster = api_app._extract_geotiff_raster(tiff)
        value = api_app._sample_geotiff_raster_nearest(
            raster,
            lat=1.0,
            lon=1.0,
            bbox={"south": 0.0, "north": 2.0, "west": 0.0, "east": 2.0},
        )

        self.assertTrue(raster["readable"])
        self.assertAlmostEqual(value, 291.15, places=2)

    def test_meteofrance_wind_direction_values_are_normalized(self):
        self.assertEqual(api_app._convert_meteofrance_value("wind_direction_10m", 370.0), 10.0)
        self.assertEqual(api_app._convert_meteofrance_value("wind_direction_100m", -5.0), 355.0)

    def test_meteofrance_slot_grid_default_core_skips_optional_coverages(self):
        tiff = _minimal_float32_tiff(center_value=280.0)
        caps = {
            "status": 200,
            "metadata_cache_hit": False,
            "latest_by_prefix": {
                "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE": "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE": "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
            },
        }
        description = {
            "axes": {"time": ["0", "3600"], "height": ["2", "10", "100"]},
            "begin_position": "2026-05-08T00.00.00Z",
            "metadata_cache_hit": False,
        }

        with patch("app._build_meteofrance_wcs_capabilities", return_value=caps), \
            patch("app._describe_meteofrance_coverage", return_value=description), \
            patch("app._meteofrance_arome_wcs_grid_date_status", return_value={"ok": True, "message": "", "supported_start": "2026-05-08", "supported_until": "2026-05-09"}), \
            patch("app._fetch_meteofrance_bytes", return_value=(200, "image/tiff", tiff)) as mocked_fetch:
            result = api_app._build_meteofrance_slot_grid_sync("abc12345", 45.764, 4.8357, "Lyon", Date(2026, 5, 8), 3)

        meta = result["payload"]["meta"]
        self.assertTrue(result["ok"])
        self.assertEqual(meta["detail_level"], "core")
        self.assertFalse(meta["wind_direction_ready"])
        self.assertEqual(meta["optional_missing_fields"], [])
        self.assertEqual(
            meta["skipped_optional_fields"],
            [
                "convective_inhibition",
                "relative_humidity_2m",
                "cloud_cover_low",
                "cloud_cover_mid",
                "cloud_cover_high",
                "wind_gusts_10m",
                "wind_speed_10m",
                "wind_speed_100m",
                "wind_direction_10m",
                "wind_direction_100m",
            ],
        )
        self.assertEqual(mocked_fetch.call_count, 3)

    def test_meteofrance_slot_grid_advanced_is_cached_and_uses_optional_wind_direction(self):
        tiff = _minimal_float32_tiff(center_value=280.0)
        caps = {
            "status": 200,
            "metadata_cache_hit": False,
            "latest_by_prefix": {
                "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE": "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE": "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE": "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE___2026-05-08T00.00.00Z",
                "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
                "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND": "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-08T00.00.00Z",
            },
        }
        description = {
            "axes": {"time": ["0", "3600"], "height": ["2", "10", "100"]},
            "begin_position": "2026-05-08T00.00.00Z",
            "metadata_cache_hit": False,
        }

        with patch("app._build_meteofrance_wcs_capabilities", return_value=caps), \
            patch("app._describe_meteofrance_coverage", return_value=description), \
            patch("app._meteofrance_arome_wcs_grid_date_status", return_value={"ok": True, "message": "", "supported_start": "2026-05-08", "supported_until": "2026-05-09"}), \
            patch("app._fetch_meteofrance_bytes", return_value=(200, "image/tiff", tiff)) as mocked_fetch:
            first = api_app._build_meteofrance_slot_grid_sync("abc12345", 45.764, 4.8357, "Lyon", Date(2026, 5, 8), 3, detail_level="advanced")
            second = api_app._build_meteofrance_slot_grid_sync("abc12345", 45.764, 4.8357, "Lyon", Date(2026, 5, 8), 3, detail_level="advanced")

        self.assertTrue(first["ok"])
        self.assertFalse(first["cache_hit"])
        self.assertFalse(first["payload"]["meta"]["slot_grid_cache_hit"])
        self.assertEqual(first["payload"]["meta"]["detail_level"], "advanced")
        self.assertTrue(first["payload"]["meta"]["wind_direction_ready"])
        self.assertEqual(first["payload"]["meta"]["optional_missing_fields"], [])
        self.assertEqual(first["payload"]["meta"]["skipped_optional_fields"], [])
        first_cell = first["payload"]["days"][0]["slots"][0]["cells"][0]
        self.assertEqual(first["payload"]["meta"]["source_provider"], "meteofrance_arome_wcs")
        self.assertEqual(first_cell["source_provider"], "meteofrance_arome_wcs")
        self.assertTrue(second["cache_hit"])
        self.assertTrue(second["payload"]["meta"]["slot_grid_cache_hit"])
        self.assertEqual(second["payload"]["meta"]["coverage_request_count"], 0)
        self.assertEqual(second["payload"]["meta"]["cached_coverage_request_count"], 13)
        self.assertIn("cache", second["message"])
        self.assertEqual(mocked_fetch.call_count, 13)

    def test_sample_meteofrance_temperature_coverage_downloads_geotiff(self):
        class FakeResponse:
            def __init__(self, body, content_type="text/xml"):
                self.body = body
                self.headers = {"content-type": content_type}
                self.status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return self.body

        wcs_body = b"""<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0">
        <wcs:Contents>
          <wcs:CoverageSummary><wcs:CoverageId>TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z</wcs:CoverageId></wcs:CoverageSummary>
        </wcs:Contents></wcs:Capabilities>"""
        describe_body = b"""<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gmlrgrid="http://www.opengis.net/gml/3.3/rgrid" xmlns:gml="http://www.opengis.net/gml/3.2">
        <wcs:CoverageDescription>
          <gml:boundedBy><gml:EnvelopeWithTimePeriod><gml:beginPosition>2026-05-07T00:00:00Z</gml:beginPosition><gml:endPosition>2026-05-08T00:00:00Z</gml:endPosition></gml:EnvelopeWithTimePeriod></gml:boundedBy>
          <gmlrgrid:GeneralGridAxis><gmlrgrid:gridAxesSpanned>height</gmlrgrid:gridAxesSpanned><gmlrgrid:coefficients>2</gmlrgrid:coefficients></gmlrgrid:GeneralGridAxis>
          <gmlrgrid:GeneralGridAxis><gmlrgrid:gridAxesSpanned>time</gmlrgrid:gridAxesSpanned><gmlrgrid:coefficients>0 3600 7200</gmlrgrid:coefficients></gmlrgrid:GeneralGridAxis>
        </wcs:CoverageDescription></wcs:CoverageDescriptions>"""
        tiff_body = _minimal_float32_tiff(center_value=289.15)

        def fake_urlopen(request, timeout=None):
            url = request.full_url
            if "GetCapabilities" in url:
                return FakeResponse(wcs_body)
            if "DescribeCoverage" in url:
                return FakeResponse(describe_body)
            if "GetCoverage" in url:
                self.assertIn("format=image%2Ftiff", url)
                self.assertIn("subset=time%283600%29", url)
                self.assertIn("subset=height%282%29", url)
                return FakeResponse(tiff_body, "image/tiff")
            raise AssertionError(url)

        with patch("app.urllib.request.urlopen", side_effect=fake_urlopen):
            result = api_app._sample_meteofrance_temperature_coverage_sync("abc12345", 45.764, 4.8357, 2.0)

        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage_id"], "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND___2026-05-07T00.00.00Z")
        self.assertAlmostEqual(result["sample"]["temperature_c"], 16.0, places=1)


if __name__ == "__main__":
    unittest.main()
