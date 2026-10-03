#!/usr/bin/env python3
"""Read the approved XLSX into deterministic, lossless historical tables; never publish."""
import argparse
from collections import Counter, defaultdict
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
SCHEMAS = {
    "Players": ("players", {"Player": "name", "Matches": "matches", "First_Match": "first_match", "Last_Match": "last_match", "Status": "status"}),
    "Matches": ("matches", {"Match_ID": "match_id", "Date": "date", "Season": "season", "Competition": "competition", "Players_Total": "players_total", "Winning_Captain": "winning_captain", "Losing_Captain": "losing_captain", "Winner_Player_Runs": "winner_player_runs", "Loser_Player_Runs": "loser_player_runs", "Result": "result"}),
    "Batting Data": ("batting", {"Name": "name", "Balls Faced": "balls_faced", "Runs": "runs", "Out": "out", "Sixes": "sixes", "Fours": "fours", "Dots": "dots", "SR": "sr", "Match_ID": "match_id", "Season": "season", "Competition": "competition", "Date": "date", "Team_Slot": "team_slot", "Side": "side"}),
    "Bowling Data": ("bowling", {"Name": "name", "BB": "balls", "Runs": "runs", "Wickets": "wickets", "Caught": "caught", "Bowled": "bowled", "Others": "others", "Wides": "wides", "Match_ID": "match_id", "Season": "season", "Competition": "competition", "Date": "date", "Team_Slot": "team_slot", "Side": "side"}),
    "Fielding Data": ("fielding", {"Name": "name", "Catches": "catches", "RunOuts": "runouts", "Stumpings": "stumpings", "Dropped": "dropped", "Dropped-Other": "dropped_other", "Match_ID": "match_id", "Season": "season", "Competition": "competition", "Date": "date", "Team_Slot": "team_slot", "Side": "side"}),
}


def workbook(path):
    """Read stored values, preserving exact text, missing cells and worksheet row numbers."""
    with zipfile.ZipFile(path) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(t.text or "" for t in item.findall(".//m:t", NS)) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        links = {item.attrib["Id"]: item.attrib["Target"] for item in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        result = {}
        for sheet in ET.fromstring(archive.read("xl/workbook.xml")).find("m:sheets", NS):
            target = links[sheet.attrib[REL]]
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            rows = []
            for row in ET.fromstring(archive.read(target)).find("m:sheetData", NS):
                cells = {}
                for cell in row:
                    ref, kind = cell.attrib["r"], cell.attrib.get("t", "n")
                    column = re.sub(r"\d", "", ref)
                    node = cell.find("m:v", NS)
                    value = node.text if node is not None else None
                    if cell.find("m:f", NS) is not None and value is None:
                        raise ValueError(f"Uncalculated formula: {sheet.attrib['name']}!{ref}")
                    if kind == "e":
                        raise ValueError(f"Spreadsheet error: {sheet.attrib['name']}!{ref}: {value}")
                    if kind == "inlineStr":
                        texts = cell.findall(".//m:t", NS)
                        value = "".join(t.text or "" for t in texts) if texts else None
                    elif kind == "s" and value is not None:
                        value = strings[int(value)]
                    elif kind == "b" and value is not None:
                        value = value == "1"
                    elif kind == "n" and value is not None:
                        number = Decimal(value)
                        if not number.is_finite():
                            raise ValueError(f"Non-finite value: {sheet.attrib['name']}!{ref}")
                        value = int(number) if number == number.to_integral_value() else float(number)
                    cells[column] = value
                rows.append((int(row.attrib["r"]), cells))
            result[sheet.attrib["name"]] = rows
        properties = ET.fromstring(archive.read("docProps/core.xml"))
        modified = properties.find("{http://purl.org/dc/terms/}modified")
        return result, modified.text if modified is not None else None


def sheet_records(sheets, name):
    rows = sheets[name]
    header = next((cells for number, cells in rows if number == 3), None)
    if not header or any(not isinstance(value, str) or not value for value in header.values()):
        raise ValueError(f"Missing or invalid row-3 headers in {name}")
    if len(set(header.values())) != len(header):
        raise ValueError(f"Duplicate column headers in {name}")
    output = []
    for number, cells in rows:
        if number <= 3 or not any(value is not None for value in cells.values()):
            continue
        if any(column not in header and value is not None for column, value in cells.items()):
            raise ValueError(f"Unexpected populated column in {name} row {number}")
        output.append((number, {title: cells.get(column) for column, title in header.items()}))
    return list(header.values()), output


def require_unique(rows, fields, name):
    seen = set()
    for row in rows:
        key = tuple(row[field] for field in fields)
        if key in seen:
            raise ValueError(f"Duplicate key conflict in {name}: {key!r}")
        seen.add(key)


def compare_companion(path, result, sheets):
    """Compare an older tables export; never copy any of its values into the import."""
    path = Path(path)
    source = json.loads(path.read_text())
    if not isinstance(source.get("tables"), dict):
        raise ValueError("Companion must be a tables export")
    other = source["tables"]
    aliases = {row["Original_ID"]: row["New_ID"] for _, row in sheet_records(sheets, "ID Fix Log")[1]}
    canonical = lambda match_id: aliases.get(match_id, match_id)
    actual = {row["match_id"]: row for row in result["tables"]["matches"]}
    old = {canonical(row["match_id"]): row for row in other["matches"]}
    if len(old) != len(other["matches"]):
        raise ValueError("Companion match IDs collide after documented ID normalization")
    comparable = sorted(actual.keys() & old.keys())
    changed_matches = set()
    row_comparison = {}
    numeric = {"batting": ("balls_faced", "runs", "out", "sixes", "fours", "dots"),
        "bowling": ("balls", "runs", "wickets", "caught", "bowled", "others", "wides"),
        "fielding": ("catches", "runouts", "stumpings", "dropped", "dropped_other")}
    for table, fields in numeric.items():
        current_rows, previous_rows = defaultdict(Counter), defaultdict(Counter)
        for row in result["tables"][table]:
            current_rows[row["match_id"]][tuple(row[key] for key in ("name", "team_slot", *fields))] += 1
        for row in other.get(table, []):
            previous_rows[canonical(row["match_id"])][tuple(row.get(key) for key in ("name", "team_slot", *fields))] += 1
        changed = [match_id for match_id in comparable if current_rows[match_id] != previous_rows[match_id]]
        changed_matches.update(changed)
        def without_slot(rows):
            counter = Counter()
            for values, count in rows.items():
                counter[(values[0], *values[2:])] += count
            return counter
        numeric_changed = [match_id for match_id in comparable if without_slot(current_rows[match_id]) != without_slot(previous_rows[match_id])]
        differences = []
        for match_id in numeric_changed:
            current = without_slot(current_rows[match_id])
            previous = without_slot(previous_rows[match_id])
            differences.append({"match_id": match_id, "fields": ["name", *fields],
                "workbook_only_rows": list((current - previous).elements()), "companion_only_rows": list((previous - current).elements())})
        row_comparison[table] = {"identical_overlapping_matches": len(comparable) - len(changed), "changed_matches": changed,
            "changed_player_figures_ignoring_team_slot": numeric_changed, "figure_differences": differences}
    header_conflicts = []
    totals_available = []
    for match_id in comparable:
        latest, previous = actual[match_id], old[match_id]
        for field in ("date", "season", "competition"):
            if latest[field] != previous.get(field):
                header_conflicts.append({"match_id": match_id, "field": field, "workbook": latest[field], "companion": previous.get(field)})
        winner = previous.get("winner_slot")
        if winner in ("Team 1", "Team 2"):
            winning = "slot1" if winner == "Team 1" else "slot2"
            losing = "slot2" if winner == "Team 1" else "slot1"
            for field, old_field in (("winning_captain", winning + "_captain"), ("losing_captain", losing + "_captain"),
                    ("winner_player_runs", winning + "_player_runs"), ("loser_player_runs", losing + "_player_runs")):
                if latest[field] is not None and previous.get(old_field) is not None and latest[field] != previous[old_field]:
                    header_conflicts.append({"match_id": match_id, "field": field, "workbook": latest[field], "companion": previous[old_field]})
        total_a = previous.get("slot1_total") if previous.get("slot1_total") is not None else previous.get("team_a_total")
        total_b = previous.get("slot2_total") if previous.get("slot2_total") is not None else previous.get("team_b_total")
        if total_a is not None and total_b is not None:
            totals_available.append(match_id)
    conflicted_headers = {row["match_id"] for row in header_conflicts}
    return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "generated_at": source.get("generated_at"),
        "counts": {key: len(value) for key, value in other.items() if isinstance(value, list)},
        "overlapping_matches_after_documented_id_mapping": len(comparable),
        "workbook_only_matches": sorted(actual.keys() - old.keys()), "companion_only_matches": sorted(old.keys() - actual.keys()),
        "row_comparison": row_comparison, "header_conflicts": header_conflicts,
        "true_totals_available_matches": totals_available,
        "enrichment_candidates_without_observed_row_or_header_conflicts": sorted(set(totals_available) - changed_matches - conflicted_headers),
        "enrichment_applied": False,
        "note": "Older, incomplete source. Candidate totals are not independently verified by the workbook, which contains no true team totals. No enrichment is authorized or applied by this extraction."}


def reconcile(sheets, tables, season):
    checks, mismatches = 0, []
    specs = {
        "Batting": ("batting", {"Innings": "rows", "Total_Runs": "runs", "Balls": "balls_faced", "Outs": "out", "Highest": "highest", "Sixes": "sixes", "Fours": "fours"}),
        "Bowling": ("bowling", {"Matches": "matches", "Balls": "balls", "Runs_Conceded": "runs", "Wickets": "wickets", "Extras": "wides"}),
        "Fielding": ("fielding", {"Matches": "matches", "Catches": "catches", "RunOuts": "runouts", "Stumpings": "stumpings", "Dropped": "dropped"}),
    }
    for scope in ("Career", "Season"):
        for discipline, (table, fields) in specs.items():
            grouped = defaultdict(list)
            for row in tables[table]:
                if scope == "Career" or row["season"] == season:
                    grouped[row["name"]].append(row)
            for source_row, expected in sheet_records(sheets, f"{scope} {discipline}")[1]:
                rows = grouped.get(expected["Name"], [])
                for column, metric in fields.items():
                    if expected[column] is None:
                        continue
                    if metric == "rows":
                        actual = len(rows)
                    elif metric == "matches":
                        actual = len({row["match_id"] for row in rows})
                    elif metric == "highest":
                        actual = max((row["runs"] for row in rows if row["runs"] is not None), default=0)
                    else:
                        actual = sum(row[metric] for row in rows if row[metric] is not None)
                    checks += 1
                    if actual != expected[column]:
                        mismatches.append({"sheet": f"{scope} {discipline}", "row": source_row, "name": expected["Name"], "metric": column, "expected": expected[column], "computed": actual})
    appearances = defaultdict(set)
    for table in ("batting", "bowling", "fielding"):
        for row in tables[table]:
            appearances[row["name"]].add(row["match_id"])
    for player in tables["players"]:
        checks += 1
        actual = len(appearances[player["name"]])
        if actual != player["matches"]:
            mismatches.append({"sheet": "Players", "row": player["source_row"], "name": player["name"], "metric": "Matches", "expected": player["matches"], "computed": actual})
    return {"checks": checks, "mismatches": mismatches}


def import_history(path, baseline_path, allow_source_update=False, companion_path=None):
    path = Path(path)
    baseline = json.loads(Path(baseline_path).read_text())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != baseline["sha256"] and not allow_source_update:
        raise ValueError("Workbook hash differs from the approved player baseline. Review an updated source explicitly before importing.")
    player_ids = {player["name"]: player["id"] for player in baseline["players"]}
    if len(player_ids) != len(baseline["players"]) or len(set(player_ids.values())) != len(player_ids):
        raise ValueError("Duplicate name or ID in canonical player mapping")
    sheets, modified = workbook(path)
    readme = "\n".join(str(value) for _, cells in sheets["README"] for value in cells.values() if value is not None)
    season_match = re.search(r"Current season:\s*(S\d+_\d{4}(?:_[A-Z])?)", readme)
    if not season_match or not modified:
        raise ValueError("Workbook current season or modification timestamp is missing")
    season = season_match.group(1)
    tables = {}
    for sheet, (table, mapping) in SCHEMAS.items():
        headers, records = sheet_records(sheets, sheet)
        if set(headers) != set(mapping):
            raise ValueError(f"Unexpected {sheet} schema: {headers!r}")
        output = []
        for row_number, record in records:
            row = {mapping[key]: value for key, value in record.items()}
            row["source_row"] = row_number
            for key in ("matches", "players_total", "winner_player_runs", "loser_player_runs", "balls_faced", "runs", "out", "sixes", "fours", "dots", "sr", "balls", "wickets", "caught", "bowled", "others", "wides", "catches", "runouts", "stumpings", "dropped", "dropped_other"):
                if key in row and row[key] is not None and (isinstance(row[key], bool) or not isinstance(row[key], (int, float))):
                    raise ValueError(f"Invalid numeric value in {sheet} row {row_number}, {key}: {row[key]!r}")
            if "match_id" in row and (not isinstance(row["match_id"], str) or not row["match_id"]):
                raise ValueError(f"Missing or invalid match ID in {sheet} row {row_number}")
            for key in ("date", "first_match", "last_match"):
                if key in row and row[key] is not None:
                    row[key] = str(row[key])
            if "name" in row:
                if row["name"] not in player_ids:
                    raise ValueError(f"Unmapped identity {row['name']!r} in {sheet} row {row_number}")
                row["player_id"] = player_ids[row["name"]]
            for key in ("winning_captain", "losing_captain"):
                if key in row:
                    if row[key] is not None and row[key] not in player_ids:
                        raise ValueError(f"Unmapped captain {row[key]!r} in {sheet} row {row_number}")
                    row[key + "_id"] = player_ids.get(row[key])
            if table in ("batting", "bowling", "fielding"):
                row["source_record_id"] = f"{digest}:{table}:{row_number}"
            output.append(row)
        tables[table] = output
    require_unique(tables["players"], ["player_id"], "Players")
    require_unique(tables["matches"], ["match_id"], "Matches")
    if set(player_ids) != {player["name"] for player in tables["players"]}:
        raise ValueError("Workbook registry and permanent player baseline differ")
    matches = {match["match_id"]: match for match in tables["matches"]}
    repeated = []
    metadata_conflicts = []
    for table in ("batting", "bowling", "fielding"):
        groups = defaultdict(list)
        for row in tables[table]:
            if row["match_id"] not in matches:
                raise ValueError(f"Unknown match {row['match_id']} in {table} row {row['source_row']}")
            for field in ("season", "competition", "date"):
                if row[field] != matches[row["match_id"]][field]:
                    metadata_conflicts.append({"table": table, "row": row["source_row"], "match_id": row["match_id"], "field": field, "row_value": row[field], "match_value": matches[row["match_id"]][field]})
            key = (row["match_id"], row["player_id"], row["team_slot"])
            groups[key].append(row)
            row["seq"] = len(groups[key])
        for (match_id, player_id, slot), rows in groups.items():
            if len(rows) > 1:
                repeated.append({"table": table, "match_id": match_id, "player_id": player_id, "name": rows[0]["name"], "team_slot": slot, "source_rows": [row["source_row"] for row in rows]})
        require_unique(tables[table], ["match_id", "player_id", "team_slot", "seq"], table)
        require_unique(tables[table], ["source_record_id"], table)
    reconciliation = reconcile(sheets, tables, season)
    null_counts = {table: dict(Counter(key for row in rows for key, value in row.items() if value is None)) for table, rows in tables.items()}
    totals = {table: {field: sum(row[field] for row in tables[table] if row[field] is not None) for field in fields} for table, fields in {
        "batting": ("balls_faced", "runs", "out", "sixes", "fours", "dots"),
        "bowling": ("balls", "runs", "wickets", "caught", "bowled", "others", "wides"),
        "fielding": ("catches", "runouts", "stumpings", "dropped", "dropped_other"),
    }.items()}
    result = {"generated_at": modified, "season": season, "tables": tables, "player_id_by_name": player_ids,
        "provenance": {"source": baseline["source"], "workbook_sha256": digest, "baseline_sha256": baseline["sha256"], "import_schema_version": 1,
            "source_counts": {table: len(rows) for table, rows in tables.items()}, "readme": readme, "null_counts": null_counts,
            "totals_of_known_values": totals, "names_preserved_exactly": True, "true_team_totals_available": False},
        "review": {"reconciliation": reconciliation, "repeated_player_match_slots": repeated, "metadata_conflicts": metadata_conflicts,
            "publication_ready": False, "note": "Review-only extraction. Repeated appearances are preserved with per-source occurrence keys, never collapsed or deduplicated. True team totals are absent; player-run totals are not substitutes."}}
    if companion_path:
        result["review"]["companion"] = compare_companion(companion_path, result, sheets)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--baseline", type=Path, default=Path(__file__).with_name("player-baseline.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-source-update", action="store_true", help="Explicitly inspect a different source hash; never permits unknown identities")
    parser.add_argument("--companion", type=Path, help="Compare an older tables JSON without importing its values")
    args = parser.parse_args()
    try:
        result = import_history(args.workbook, args.baseline, args.allow_source_update, args.companion)
        inputs = [args.workbook.resolve(), args.baseline.resolve()] + ([args.companion.resolve()] if args.companion else [])
        if args.output.resolve() in inputs:
            raise ValueError("Output cannot overwrite source inputs")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        print(json.dumps({"source_counts": result["provenance"]["source_counts"], "reconciliation": result["review"]["reconciliation"],
            "repeated_keys": len(result["review"]["repeated_player_match_slots"]), "metadata_conflicts": len(result["review"]["metadata_conflicts"]), "output": str(args.output)}))
        return 0  # Review findings are preserved in output; this tool never marks data ready for publication.
    except (ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as error:
        print(f"Import rejected: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
