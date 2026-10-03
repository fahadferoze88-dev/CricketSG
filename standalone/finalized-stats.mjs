import { createHash } from "node:crypto";
import { validateRecovery } from "../testing/recovery.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const invalid = (message) => { throw new Error(message); };
const slot = (key) => key === "teamA" ? "Team 1" : "Team 2";
const opposite = (key) => key === "teamA" ? "teamB" : "teamA";
const countsBall = (event) => !(event.overIndex === 15 && ["Wide", "No ball"].includes(event.extraType));

// A pure, review-only projection of one immutable D1 finalization. No writes or network calls.
// House rules approved 30 September 2026: F/S means one boundary, plain numbers mean runs only.
// A dot is a counting delivery with no batter runs, extras or dismissal.
export function finalizationToTables(record, { season, generatedAt } = {}) {
  if (!uuid.test(record?.match_id || "") || !Number.isSafeInteger(record.revision) || record.revision < 1) invalid("A finalized match UUID and positive revision are required.");
  if (typeof season !== "string" || !season.trim()) invalid("An explicit season is required; it cannot be inferred from the match date.");
  const raw = typeof record.snapshot === "string" ? record.snapshot : JSON.stringify(record.snapshot);
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/i.test(record.content_hash || "") || createHash("sha256").update(raw).digest("hex") !== record.content_hash.toLowerCase()) invalid("Finalized snapshot checksum does not match its immutable record.");
  const saved = JSON.parse(raw);
  const config = saved.matchConfig;
  if (config?.schemaVersion !== 2 || !["completed", "shortened", "abandoned"].includes(saved.matchStatus)) invalid("Only completed, shortened or abandoned schema-2 finalizations can become statistics.");
  validateRecovery(saved, { verifyUndo: false });
  const allIds = [...config.teamA.players, ...config.teamB.players];
  if (allIds.some((id) => !uuid.test(id) || typeof config.playerNames?.[id] !== "string" || !config.playerNames[id].trim()) ||
      !config.teamA.players.includes(config.teamA.captain) || !config.teamB.players.includes(config.teamB.captain)) invalid("Permanent player IDs, names and roster captains are required.");
  if (saved.matchStatus === "completed" && (saved.inningsNumber !== 2 || saved.completedInnings[0].legalBalls !== 96 || saved.state.legalBalls !== 96)) invalid("A completed result needs two complete innings.");
  const finalizedAt = record.created_at;
  if (typeof finalizedAt !== "string" || !Number.isFinite(Date.parse(finalizedAt)) ||
      (generatedAt !== undefined && (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))))) invalid("A valid finalization timestamp is required.");
  const date = config.date.replaceAll("-", "");
  const inningsByTeam = new Map([...saved.completedInnings, saved.state].map((innings, index) => [index === 0 ? config.battingFirst : opposite(config.battingFirst), innings]));
  const played = (key) => Boolean(inningsByTeam.get(key)?.history.length);
  const totals = Object.fromEntries(["teamA", "teamB"].map((key) => [key, played(key) ? inningsByTeam.get(key).total : null]));
  const winner = saved.matchStatus === "completed" && totals.teamA !== totals.teamB ? totals.teamA > totals.teamB ? "teamA" : "teamB" : null;
  const result = saved.matchStatus !== "completed" ? null : winner ? `${winner === "teamA" ? "Team A" : "Team B"} won` : "Tie";
  const side = (key) => winner ? winner === key ? "Won" : "Lost" : result === "Tie" ? "Tie" : null;
  const provenance = {
    source: "cricket-sg-finalization", match_id: record.match_id, revision: record.revision,
    content_hash: record.content_hash.toLowerCase(), finalized_at: finalizedAt,
    schema_version: 2, scoring_version: 2, statistics_rules_version: "2026-09-30", status: saved.matchStatus,
  };
  const tables = { players: [], matches: [], batting: [], bowling: [], fielding: [] };
  const match = {
    match_id: record.match_id, revision: record.revision, date, season, match_number: config.matchNumber,
    match_name: config.matchName, competition: config.competition || null, status: saved.matchStatus,
    batting_first: slot(config.battingFirst), result, winner_slot: winner ? slot(winner) : null,
    margin: winner ? Math.abs(totals.teamA - totals.teamB) : result === "Tie" ? 0 : null,
    slot1_captain_id: config.teamA.captain, slot2_captain_id: config.teamB.captain,
    slot1_captain: config.playerNames[config.teamA.captain], slot2_captain: config.playerNames[config.teamB.captain],
    slot1_name: config.teamA.name, slot2_name: config.teamB.name,
  };
  const participants = new Set();
  const common = (id, teamKey, seq) => ({
    match_id: record.match_id, revision: record.revision, player_id: id, name: config.playerNames[id],
    team_slot: slot(teamKey), team_side: teamKey === "teamA" ? "A" : "B", side: side(teamKey),
    date, season, competition: config.competition || null, seq,
  });
  for (const [teamKey, number] of [["teamA", 1], ["teamB", 2]]) {
    const innings = inningsByTeam.get(teamKey);
    const history = innings?.history || [];
    const prefix = `slot${number}_`;
    const facts = history.length ? {
      total: innings.total, player_runs: sum(Object.values(innings.playerRuns)),
      extras: sum(history.map((event) => event.extras || 0)),
      leg_byes: sum(history.filter((event) => event.extraType === "Leg bye").map((event) => event.extras)),
      run_out_penalty: -5 * history.filter((event) => event.dismissal === "Run Out").length,
      run_out_count: history.filter((event) => event.dismissal === "Run Out").length,
      bowling_player_runs: sum(Object.values(innings.bowlerRuns)), counting_balls: innings.legalBalls,
    } : Object.fromEntries(["total", "player_runs", "extras", "leg_byes", "run_out_penalty", "run_out_count", "bowling_player_runs", "counting_balls"].map((key) => [key, null]));
    for (const [key, value] of Object.entries(facts)) match[prefix + key] = value;
    if (!history.length) continue;
    if (facts.total !== facts.player_runs + facts.extras || facts.total !== facts.bowling_player_runs + facts.leg_byes + facts.run_out_penalty) invalid("Innings totals do not reconcile with batting, extras and bowling adjustments.");
    const appearedBatters = [...new Set(history.flatMap((event) => [event.striker, event.nonStriker]))];
    for (const [index, id] of appearedBatters.entries()) {
      participants.add(id);
      const faced = history.filter((event) => event.striker === id);
      const fours = faced.filter((event) => /^\d+F$/.test(event.chip)).length;
      const sixes = faced.filter((event) => /^\d+S$/.test(event.chip)).length;
      const codes = {};
      for (const event of faced) codes[event.chip] = (codes[event.chip] || 0) + 1;
      tables.batting.push({
        ...common(id, teamKey, index + 1), balls_faced: innings.playerBalls[id], runs: innings.playerRuns[id],
        out: history.filter((event) => event.dismissal && event.penalizedPlayer === id).length,
        fours, sixes, dots: faced.filter((event) => countsBall(event) && (event.batterRuns || 0) === 0 &&
          !(event.extras || 0) && !event.dismissal).length,
        boundary_codes: codes,
      });
    }
    const fieldingKey = opposite(teamKey);
    const bowlers = [...new Set(history.map((event) => event.bowler))];
    for (const [index, id] of bowlers.entries()) {
      const deliveries = history.filter((event) => event.bowler === id);
      tables.bowling.push({
        ...common(id, fieldingKey, index + 1), balls: innings.bowlerBalls[id], runs: innings.bowlerRuns[id],
        wickets: innings.bowlerWickets[id], caught: deliveries.filter((event) => event.dismissal === "Catch").length,
        bowled: deliveries.filter((event) => event.dismissal === "Bowled").length,
        others: deliveries.filter((event) => ["Stumped", "Out-Other"].includes(event.dismissal)).length,
        // The existing converter calls this column 'wides' but displays it as total bowling extras.
        wides: innings.bowlerExtras[id],
        wide_runs: sum(deliveries.filter((event) => event.extraType === "Wide").map((event) => event.extras)),
        no_ball_runs: sum(deliveries.filter((event) => event.extraType === "No ball").map((event) => event.extras)),
      });
    }
    for (const [index, id] of config[fieldingKey].players.entries()) {
      participants.add(id);
      const stats = innings.fielding[id];
      tables.fielding.push({ ...common(id, fieldingKey, index + 1), catches: stats.catches, runouts: stats.runouts,
        stumpings: stats.stumpings, dropped: stats.drops, dropped_other: null });
    }
  }
  match.players_total = participants.size;
  tables.matches.push(match);
  tables.players = allIds.map((id) => ({ player_id: id, name: config.playerNames[id], matches: Number(participants.has(id)),
    first_match: participants.has(id) ? date : null, last_match: participants.has(id) ? date : null }));
  return {
    generated_at: generatedAt || finalizedAt, season, tables, provenance: [provenance],
    review: { ready: true, issues: [], fielding_participation: "All eight roster fielders once the opposing innings has a recorded delivery.",
      boundary_policy: "Each F code counts one four; each S code counts one six; plain run values count no boundary.",
      dot_rule: "scoreless-delivery", dot_rule_description: "Counting delivery with no batter runs, extras or dismissal.",
      result_policy: "Only a completed two-innings match has an inferred winner; shortened and abandoned results remain unrecorded.",
      drop_coverage: "Recorded dropped chances are retained; the scorer does not retain a separate dropped-other subtype." },
  };
}
