const fs = require("fs");
const path = require("path");
const mega = require("megajs");

const MEGA_FOLDER_URL = process.env.MEGA_FOLDER_URL || "https://mega.nz/folder/rlAWQSLZ#nLAVvNeg05TeqrOGpmf8uQ";
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(process.cwd(), "public", "data.json");

const CONFIG = {
  hall_of_fame_min_matches: 60,
  hall_of_fame_top_n: 10,
  player_history_min_matches: 20,
  season_leaderboard_min_matches: 2,
  mvp_min_matches_season: 2,
  mvp_min_matches_career: 60,
  match_day_min_matches: 1,
  recent_match_days: 2,
  form_line_innings: 10,
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const root = await loadMegaFolder(MEGA_FOLDER_URL);
  const candidates = collectFiles(root).filter((file) => file.name === "data.json");
  if (candidates.length === 0) throw new Error("No data.json found in the MEGA folder.");

  const inspected = [];
  for (const candidate of candidates) {
    const raw = await downloadText(candidate);
    const data = parseJson(raw);
    inspected.push({ name: candidate.name, size: candidate.size, keys: Object.keys(data).join(", ") });

    if (isWebContract(data)) {
      writeData(data);
      console.log(`Updated public/data.json from web contract schema ${data.meta.schema_version}.`);
      return;
    }

    if (isTablesExport(data)) {
      const converted = convertTablesExport(data);
      writeData(converted);
      console.log(`Updated public/data.json from MEGA tables export (${converted.meta.current_season}).`);
      return;
    }
  }

  console.error("Found data.json file(s), but none matched a supported CricketSG format:");
  for (const item of inspected) console.error(`- ${item.name} (${item.size} bytes): ${item.keys}`);
  throw new Error("Unsupported data.json format.");
}

function loadMegaFolder(url) {
  return new Promise((resolve, reject) => {
    const folder = mega.File.fromURL(url);
    folder.loadAttributes((error, file) => (error ? reject(error) : resolve(file)));
  });
}

function collectFiles(file) {
  if (!file.directory) return [file];
  return (file.children || []).flatMap(collectFiles);
}

function downloadText(file) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    file.download()
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseJson(raw) {
  return JSON.parse(raw.replace(/\bNaN\b/g, "null"));
}

function isWebContract(data) {
  return Boolean(data?.meta && data?.players && data?.matches && data?.raw && data?.views);
}

function isTablesExport(data) {
  return Boolean(data?.generated_at && data?.season && data?.tables?.players && data?.tables?.matches && data?.tables?.batting && data?.tables?.bowling);
}

function writeData(data) {
  validateWebContract(data);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data)}\n`);
}

function validateWebContract(data) {
  if (!isWebContract(data)) throw new Error("Converted data does not match the expected CricketSG web contract.");
}

function convertTablesExport(source) {
  const tables = source.tables;
  const matches = tables.matches.map((match) => convertMatch(match));
  const matchesById = new Map(matches.map((match) => [match.id, match]));
  const battingRows = tables.batting.map((row) => {
    const teamSlot = clean(row.team_slot) || slotFromTeamSide(row.team_side);
    return {
      match: row.match_id,
      player: clean(row.name),
      team_slot: teamSlot,
      side: clean(row.side) || sideFromSlot(teamSlot, matchesById.get(row.match_id)),
      balls_faced: value(row.balls_faced),
      runs: value(row.runs),
      out: value(row.out),
      sixes: value(row.sixes),
      fours: value(row.fours),
      dots: value(row.dots),
      seq: value(row.seq),
    };
  });
  const bowlingRows = tables.bowling.map((row) => {
    const teamSlot = clean(row.team_slot) || slotFromTeamSide(row.team_side);
    return {
      match: row.match_id,
      player: clean(row.name),
      team_slot: teamSlot,
      side: clean(row.side) || sideFromSlot(teamSlot, matchesById.get(row.match_id)),
      balls: value(row.balls),
      runs: value(row.runs),
      wickets: value(row.wickets),
      caught: value(row.caught),
      bowled: value(row.bowled),
      others: value(row.others),
      wides: value(row.wides),
      seq: value(row.seq),
    };
  });
  const fieldingRows = (tables.fielding || []).map((row) => {
    const teamSlot = clean(row.team_slot) || slotFromTeamSide(row.team_side);
    return {
      match: row.match_id,
      player: clean(row.name),
      team_slot: teamSlot,
      side: clean(row.side) || sideFromSlot(teamSlot, matchesById.get(row.match_id)),
      catches: value(row.catches),
      runouts: value(row.runouts),
      stumpings: value(row.stumpings),
      dropped: value(row.dropped),
      seq: value(row.seq),
    };
  });

  const season = source.season;
  const matchGroups = groupBy(matches.filter((match) => hasDate(match.date) && match.has_true_totals), (match) => match.date);
  const recentDates = Object.keys(matchGroups).sort().slice(-CONFIG.recent_match_days);
  const recentDays = recentDates.map((date) => buildRecentDay(date, matchGroups[date], battingRows, bowlingRows, fieldingRows));
  const playerRecords = buildPlayerRecords(tables.players, battingRows, bowlingRows, fieldingRows, matchesById);
  const players = tables.players.map((player) => ({
    name: clean(player.name),
    matches: playerRecords[clean(player.name)]?.matches || 0,
    in_history: (playerRecords[clean(player.name)]?.matches || 0) >= CONFIG.player_history_min_matches,
  }));

  return {
    meta: {
      generated_at: source.generated_at,
      current_season: season,
      season_label: seasonLabel(season),
      latest_match_date: recentDates.at(-1) || latestDate(matches),
      schema_version: 3,
      config: CONFIG,
      coverage: {
        fielding: "Fielding tracked from 2023 onward.",
        note: "Converted from CricketSG tables export.",
      },
    },
    players,
    matches,
    raw: {
      batting: tableFromObjects(battingRows, ["match", "player", "team_slot", "side", "balls_faced", "runs", "out", "sixes", "fours", "dots", "seq"]),
      bowling: tableFromObjects(bowlingRows, ["match", "player", "team_slot", "side", "balls", "runs", "wickets", "caught", "bowled", "others", "wides", "seq"]),
      fielding: tableFromObjects(fieldingRows, ["match", "player", "team_slot", "side", "catches", "runouts", "stumpings", "dropped", "seq"]),
    },
    views: {
      season: buildSeasonView(season, battingRows, bowlingRows, fieldingRows, matchesById),
      hall_of_fame: buildHallOfFame(battingRows, bowlingRows, fieldingRows, matchesById),
      recent_days: recentDays,
      player_records: playerRecords,
    },
  };
}

function convertMatch(row) {
  const totals = {
    "Team 1": value(row.slot1_total ?? row.team_a_total),
    "Team 2": value(row.slot2_total ?? row.team_b_total),
  };
  const playerRuns = {
    "Team 1": value(row.slot1_player_runs),
    "Team 2": value(row.slot2_player_runs),
  };
  const hasTrueTotals = Number.isFinite(totals["Team 1"]) && Number.isFinite(totals["Team 2"]);
  const winnerSlot = clean(row.winner_slot) || winnerSlotFromResult(row.result);
  const loserSlot = winnerSlot === "Team 1" ? "Team 2" : winnerSlot === "Team 2" ? "Team 1" : null;
  const margin = value(row.margin) ?? (winnerSlot && loserSlot && hasTrueTotals ? Math.abs(totals[winnerSlot] - totals[loserSlot]) : null);
  const winningCaptain = winnerSlot === "Team 1" ? clean(row.slot1_captain) : winnerSlot === "Team 2" ? clean(row.slot2_captain) : null;
  const losingCaptain = loserSlot === "Team 1" ? clean(row.slot1_captain) : loserSlot === "Team 2" ? clean(row.slot2_captain) : null;
  const innings = hasTrueTotals ? ["Team 1", "Team 2"].map((battingSlot) => {
    const bowlingSlot = battingSlot === "Team 1" ? "Team 2" : "Team 1";
    const battingPlayerRuns = value(playerRuns[battingSlot]);
    const bowlingPlayerRuns = null;
    return {
      batting_slot: battingSlot,
      bowling_slot: bowlingSlot,
      total: totals[battingSlot],
      batting_player_runs: battingPlayerRuns,
      batting_extras: totals[battingSlot] - safeNumber(battingPlayerRuns),
      bowling_player_runs: bowlingPlayerRuns,
      bowling_run_outs: null,
    };
  }) : [];

  return {
    id: row.match_id,
    date: String(row.date || ""),
    season: clean(row.season),
    competition: clean(row.competition),
    winning_captain: winningCaptain,
    losing_captain: losingCaptain,
    winner_runs: winnerSlot ? totals[winnerSlot] : null,
    loser_runs: loserSlot ? totals[loserSlot] : null,
    result: clean(row.result),
    team_totals: hasTrueTotals ? totals : null,
    has_true_totals: hasTrueTotals,
    margin,
    winner_slot: winnerSlot,
    winner_player_runs: winnerSlot ? playerRuns[winnerSlot] : null,
    loser_player_runs: loserSlot ? playerRuns[loserSlot] : null,
    innings,
  };
}

function buildRecentDay(date, matches, battingRows, bowlingRows, fieldingRows) {
  const ids = new Set(matches.map((match) => match.id));
  return {
    date,
    match_count: matches.length,
    leaders: {
      batting: battingLeaderboard(battingRows.filter((row) => ids.has(row.match)), CONFIG.match_day_min_matches),
      bowling: bowlingLeaderboard(bowlingRows.filter((row) => ids.has(row.match)), CONFIG.match_day_min_matches),
      fielding: fieldingLeaderboard(fieldingRows.filter((row) => ids.has(row.match)), CONFIG.match_day_min_matches),
      mvp: mvpLeaderboard(battingRows.filter((row) => ids.has(row.match)), bowlingRows.filter((row) => ids.has(row.match)), CONFIG.match_day_min_matches),
    },
    matches: matches.map((match) => ({
      id: match.id,
      competition: match.competition,
      winning_captain: match.winning_captain,
      losing_captain: match.losing_captain,
      team_totals: match.team_totals,
      has_true_totals: match.has_true_totals,
      margin: match.margin,
      winner_slot: match.winner_slot,
      batting: battingRows.filter((row) => row.match === match.id).sort(bySeq).map(stripMatchSeq),
      bowling: bowlingRows.filter((row) => row.match === match.id).sort(bySeq).map(stripMatchSeq),
      innings: buildInnings(
        match,
        battingRows.filter((row) => row.match === match.id),
        bowlingRows.filter((row) => row.match === match.id),
      ),
    })),
  };
}

function buildInnings(match, matchBattingRows, matchBowlingRows) {
  if (!match.has_true_totals) return [];
  return match.innings.map((innings) => {
    const batterRows = matchBattingRows.filter((row) => row.team_slot === innings.batting_slot);
    const battingPlayerRuns = batterRows.length > 0 ? sum(batterRows, "runs") : safeNumber(innings.batting_player_runs);
    const bowlerRuns = sum(matchBowlingRows.filter((row) => row.team_slot === innings.bowling_slot), "runs");
    const totalBowlingBalls = sum(matchBowlingRows.filter((row) => row.team_slot === innings.bowling_slot), "balls");
    return {
      ...innings,
      batting_player_runs: battingPlayerRuns,
      batting_extras: innings.total - battingPlayerRuns,
      bowling_player_runs: bowlerRuns,
      bowling_run_outs: totalBowlingBalls > 0 ? innings.total - bowlerRuns : null,
    };
  });
}

function buildSeasonView(season, battingRows, bowlingRows, fieldingRows, matchesById) {
  const inSeason = (row) => matchesById.get(row.match)?.season === season;
  return {
    season,
    min_matches: CONFIG.season_leaderboard_min_matches,
    batting: battingLeaderboard(battingRows.filter(inSeason), CONFIG.season_leaderboard_min_matches),
    bowling: bowlingLeaderboard(bowlingRows.filter(inSeason), CONFIG.season_leaderboard_min_matches),
    fielding: fieldingLeaderboard(fieldingRows.filter(inSeason), CONFIG.season_leaderboard_min_matches),
    mvp: mvpLeaderboard(battingRows.filter(inSeason), bowlingRows.filter(inSeason), CONFIG.mvp_min_matches_season),
  };
}

function buildHallOfFame(battingRows, bowlingRows, fieldingRows) {
  return {
    batting: battingLeaderboard(battingRows, CONFIG.hall_of_fame_min_matches).slice(0, CONFIG.hall_of_fame_top_n),
    bowling: bowlingLeaderboard(bowlingRows, CONFIG.hall_of_fame_min_matches).slice(0, CONFIG.hall_of_fame_top_n),
    fielding: fieldingLeaderboard(fieldingRows, CONFIG.hall_of_fame_min_matches).slice(0, CONFIG.hall_of_fame_top_n),
    mvp: mvpLeaderboard(battingRows, bowlingRows, CONFIG.mvp_min_matches_career).slice(0, CONFIG.hall_of_fame_top_n),
  };
}

function buildPlayerRecords(players, battingRows, bowlingRows, fieldingRows, matchesById) {
  const records = {};
  for (const player of players) {
    const name = clean(player.name);
    const playerBatting = battingRows.filter((row) => row.player === name);
    const playerBowling = bowlingRows.filter((row) => row.player === name);
    const playerFielding = fieldingRows.filter((row) => row.player === name);
    const matchIds = new Set([...playerBatting, ...playerBowling, ...playerFielding].map((row) => row.match));
    const datedMatches = [...matchIds].map((id) => matchesById.get(id)).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const batting = battingStats(playerBatting, true);
    records[name] = {
      player: name,
      matches: matchIds.size,
      first_played: datedMatches[0]?.date || player.first_match || null,
      last_played: datedMatches.at(-1)?.date || player.last_match || null,
      seasons: new Set(datedMatches.map((match) => match.season).filter(Boolean)).size,
      batting,
      bowling: bowlingStats(playerBowling, true),
      fielding: fieldingStats(playerFielding, true),
      form: playerBatting
        .filter((row) => hasDate(matchesById.get(row.match)?.date))
        .sort((a, b) => String(matchesById.get(a.match)?.date).localeCompare(String(matchesById.get(b.match)?.date)))
        .slice(-CONFIG.form_line_innings)
        .map((row) => row.runs),
    };
  }
  return records;
}

function battingLeaderboard(rows, minMatches) {
  return Object.entries(groupBy(rows, (row) => row.player))
    .map(([, playerRows]) => battingStats(playerRows))
    .filter((row) => row.matches >= minMatches)
    .sort((a, b) => b.runs - a.runs || a.player.localeCompare(b.player));
}

function bowlingLeaderboard(rows, minMatches) {
  return Object.entries(groupBy(rows, (row) => row.player))
    .map(([, playerRows]) => bowlingStats(playerRows))
    .filter((row) => row.matches >= minMatches)
    .sort((a, b) => a.economy - b.economy || b.wickets - a.wickets || a.player.localeCompare(b.player));
}

function fieldingLeaderboard(rows, minMatches) {
  return Object.entries(groupBy(rows, (row) => row.player))
    .map(([, playerRows]) => fieldingStats(playerRows))
    .filter((row) => row.matches >= minMatches)
    .sort((a, b) => b.dismissals - a.dismissals || a.player.localeCompare(b.player));
}

function mvpLeaderboard(battingRows, bowlingRows, minMatches) {
  const names = new Set([...battingRows, ...bowlingRows].map((row) => row.player));
  return [...names].map((player) => {
    const batting = battingStats(battingRows.filter((row) => row.player === player));
    const bowling = bowlingStats(bowlingRows.filter((row) => row.player === player));
    const runsPerMatch = batting.matches ? round(batting.runs / batting.matches, 2) : 0;
    const concededPerMatch = bowling.matches ? round(bowling.runs_conceded / bowling.matches, 2) : 0;
    return {
      player,
      matches_batting: batting.matches,
      runs: batting.runs,
      matches_bowling: bowling.matches,
      conceded: bowling.runs_conceded,
      runs_per_match: runsPerMatch,
      conceded_per_match: concededPerMatch,
      mvp_score: round(runsPerMatch - concededPerMatch, 2),
    };
  }).filter((row) => row.matches_batting >= minMatches && row.matches_bowling >= minMatches)
    .sort((a, b) => b.mvp_score - a.mvp_score || a.player.localeCompare(b.player));
}

function battingStats(rows, allowEmpty = false) {
  const player = rows[0]?.player || null;
  const matches = new Set(rows.map((row) => row.match)).size;
  const runs = sum(rows, "runs");
  const balls = sum(rows, "balls_faced");
  return {
    player,
    matches,
    innings: rows.length,
    runs,
    balls,
    outs: sum(rows, "out"),
    highest: rows.length ? Math.max(...rows.map((row) => safeNumber(row.runs))) : null,
    sixes: sum(rows, "sixes"),
    fours: sum(rows, "fours"),
    strike_rate: balls ? round((runs / balls) * 100, 1) : null,
    runs_per_innings: rows.length ? round(runs / rows.length, 2) : null,
  };
}

function bowlingStats(rows) {
  const player = rows[0]?.player || null;
  const matches = new Set(rows.map((row) => row.match)).size;
  const balls = sum(rows, "balls");
  const runs = sum(rows, "runs");
  return {
    player,
    matches,
    balls,
    runs_conceded: runs,
    wickets: sum(rows, "wickets"),
    extras: sum(rows, "wides"),
    overs: round(balls / 6, 2),
    economy: balls ? round(runs / (balls / 6), 2) : null,
  };
}

function fieldingStats(rows) {
  const player = rows[0]?.player || null;
  const catches = sum(rows, "catches");
  const runouts = sum(rows, "runouts");
  const stumpings = sum(rows, "stumpings");
  const dropped = sum(rows, "dropped");
  return {
    player,
    matches: new Set(rows.map((row) => row.match)).size,
    catches,
    runouts,
    stumpings,
    dropped,
    dismissals: catches + runouts + stumpings,
    catch_pct: catches + dropped ? round((catches / (catches + dropped)) * 100, 0) : null,
  };
}

function tableFromObjects(rows, columns) {
  return { columns, rows: rows.map((row) => columns.map((column) => row[column] ?? null)) };
}

function stripMatchSeq(row) {
  const { match, seq, ...rest } = row;
  return rest;
}

function slotFromTeamSide(teamSide) {
  if (teamSide === "A" || teamSide === "H") return "Team 1";
  if (teamSide === "B" || teamSide === "Aways") return "Team 2";
  return null;
}

function winnerSlotFromResult(result) {
  const normalized = String(result || "").toLowerCase();
  if (normalized.includes("team a won")) return "Team 1";
  if (normalized.includes("team b won")) return "Team 2";
  if (normalized.includes("team 1 won")) return "Team 1";
  if (normalized.includes("team 2 won")) return "Team 2";
  return null;
}

function sideFromSlot(teamSlot, match) {
  if (!teamSlot || !match?.winner_slot) return null;
  return teamSlot === match.winner_slot ? "Won" : "Lost";
}

function groupBy(rows, getKey) {
  return rows.reduce((groups, row) => {
    const key = getKey(row) || "Unknown";
    groups[key] = groups[key] || [];
    groups[key].push(row);
    return groups;
  }, {});
}

function bySeq(a, b) {
  return safeNumber(a.seq) - safeNumber(b.seq);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + safeNumber(row[key]), 0);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function value(input) {
  if (input === null || input === undefined || input === "" || input === "Unknown") return null;
  const number = Number(input);
  return Number.isFinite(number) ? number : input;
}

function clean(input) {
  return input === undefined || input === null || input === "" || input === "Unknown" ? null : String(input);
}

function hasDate(value) {
  return /^\d{8}$/.test(String(value || ""));
}

function latestDate(matches) {
  return matches.map((match) => match.date).filter(hasDate).sort().at(-1) || null;
}

function seasonLabel(season) {
  const match = String(season || "").match(/^S(\d+)_(\d{4})$/);
  return match ? `Season ${match[1]} · ${match[2]}` : String(season || "Current season");
}

function round(number, digits) {
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}
