"""Run: python3 -m unittest discover -s standalone -p history_import_test.py"""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from import_history import import_history, NS, require_unique

HERE = Path(__file__).parent
SOURCE = HERE / "source-check/Cricket_Statistics_Master_v2.xlsx"
BASELINE = HERE / "player-baseline.json"
COMPANION = HERE / "source-check/data.json"


class HistoricalImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = import_history(SOURCE, BASELINE, companion_path=COMPANION)

    def test_lossless_counts_identity_nulls_and_determinism(self):
        result = self.result
        self.assertEqual(result["provenance"]["source_counts"], {"players": 218, "matches": 440, "batting": 6530, "bowling": 6536, "fielding": 3618})
        self.assertNotEqual(result["player_id_by_name"]["Ali L"], result["player_id_by_name"]["Ali\u00a0L"])
        self.assertEqual(result, import_history(SOURCE, BASELINE, companion_path=COMPANION))
        self.assertFalse(result["review"]["publication_ready"])
        self.assertEqual(result["review"]["metadata_conflicts"], [])
        self.assertEqual(len(result["review"]["repeated_player_match_slots"]), 54)
        appearances = [row for row in result["tables"]["batting"] if row["match_id"] == "20190302_2" and row["name"] == "Mansab"]
        self.assertEqual([row["seq"] for row in appearances], [1, 2])
        self.assertEqual(len({row["source_record_id"] for row in appearances}), 2)
        original = next(row for row in result["tables"]["batting"] if row["match_id"] == "20190209_1" and row["name"] == "Mustafa")
        self.assertIsNone(original["sixes"])
        self.assertEqual(original["side"], "Unknown")
        self.assertEqual(sum(row["date"] is None for row in result["tables"]["matches"]), 6)
        self.assertNotIn("slot1_total", result["tables"]["matches"][0])
        self.assertEqual(result["provenance"]["totals_of_known_values"]["batting"]["runs"], 57149)
        self.assertEqual(result["provenance"]["totals_of_known_values"]["bowling"]["runs"], 88795)

    def test_aggregate_reconciliation_reports_instead_of_repairing_source(self):
        checks = self.result["review"]["reconciliation"]
        self.assertEqual(checks["checks"], 4619)
        self.assertEqual(checks["mismatches"], [{"sheet": "Players", "row": 45, "name": "Ammar", "metric": "Matches", "expected": 28, "computed": 29}])
        self.assertEqual(next(row["matches"] for row in self.result["tables"]["players"] if row["name"] == "Ammar"), 28)
        self.assertTrue(any(row["name"] == "Ammar" and row["match_id"] == "20231104_2" for row in self.result["tables"]["fielding"]))

    def test_companion_is_reviewed_but_never_enriches_or_overwrites(self):
        review = self.result["review"]["companion"]
        self.assertEqual(review["counts"]["matches"], 434)
        self.assertEqual(review["overlapping_matches_after_documented_id_mapping"], 434)
        self.assertEqual(len(review["workbook_only_matches"]), 6)
        self.assertEqual(len(review["true_totals_available_matches"]), 9)
        self.assertFalse(review["enrichment_applied"])
        self.assertEqual(review["enrichment_candidates_without_observed_row_or_header_conflicts"], [])
        self.assertIn("20260821_2", review["row_comparison"]["bowling"]["changed_player_figures_ignoring_team_slot"])
        self.assertIn("20260116_2", review["row_comparison"]["fielding"]["changed_player_figures_ignoring_team_slot"])
        self.assertFalse(any(row["name"] == "#REF!" for row in self.result["tables"]["fielding"]))

    def test_unmapped_identity_hash_and_duplicate_conflicts_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = json.loads(BASELINE.read_text())
            altered = copy.deepcopy(baseline)
            altered["sha256"] = "0" * 64
            target = Path(directory) / "baseline.json"
            target.write_text(json.dumps(altered))
            with self.assertRaisesRegex(ValueError, "hash differs"):
                import_history(SOURCE, target)
            altered = copy.deepcopy(baseline)
            altered["players"][0]["name"] = "Unapproved replacement name"
            target.write_text(json.dumps(altered))
            with self.assertRaisesRegex(ValueError, "Unmapped identity"):
                import_history(SOURCE, target)
            changed = Path(directory) / "duplicate-match.xlsx"
            with zipfile.ZipFile(SOURCE) as original, zipfile.ZipFile(changed, "w") as output:
                for entry in original.infolist():
                    contents = original.read(entry.filename)
                    if entry.filename == "xl/worksheets/sheet3.xml":
                        document = ET.fromstring(contents)
                        rows = document.find("m:sheetData", NS)
                        row = copy.deepcopy(next(row for row in rows if row.attrib["r"] == "4"))
                        row.attrib["r"] = "10000"
                        rows.append(row)
                        contents = ET.tostring(document)
                    output.writestr(entry, contents)
            with self.assertRaisesRegex(ValueError, "Duplicate key conflict in Matches"):
                import_history(changed, BASELINE, allow_source_update=True)
        with self.assertRaisesRegex(ValueError, "Duplicate key conflict"):
            require_unique([{"source_record_id": "same"}, {"source_record_id": "same"}], ["source_record_id"], "Batting Data")


if __name__ == "__main__":
    unittest.main()
