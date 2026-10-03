import { recalculateInnings } from "./scoring.mjs";
// Recovery files are device checkpoints, never trusted official match results.
export function validateRecovery(saved, { verifyUndo = true } = {}) {
  const fail = () => { throw new Error("Invalid recovery data"); };
  const config = saved?.matchConfig;
  if (!config || !["teamA", "teamB"].includes(config.battingFirst) ||
      typeof config.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(config.date) ||
      !Number.isFinite(Date.parse(config.date)) || typeof config.matchName !== "string") fail();
  const players = [config.teamA, config.teamB].flatMap((team) => {
    if (!team || typeof team.name !== "string" || !Array.isArray(team.players) || team.players.length !== 8 ||
        team.players.some((name) => typeof name !== "string" || !name.trim() || name.length > 100)) fail();
    return team.players;
  });
  if (new Set(players.map((name) => name.toLowerCase())).size !== 16 ||
      ![1, 2].includes(saved.inningsNumber) || !Array.isArray(saved.completedInnings) ||
      saved.completedInnings.length !== saved.inningsNumber - 1 ||
      !Array.isArray(saved.undoStack) || saved.undoStack.length > 30) fail();
  for (const innings of [saved.state, ...saved.completedInnings, ...saved.undoStack]) {
    if (!innings || !Number.isFinite(innings.total) || !Number.isInteger(innings.legalBalls) ||
        innings.legalBalls < 0 || innings.legalBalls > 96 || ![0,1,2,3].includes(innings.pairIndex) ||
        ![0,1].includes(innings.strikerIndex) || !Array.isArray(innings.battingPairs) || innings.battingPairs.length > 4 ||
        innings.battingPairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((name) => !players.includes(name))) ||
        !Array.isArray(innings.history) || innings.history.some((event) => !event ||
          ["ballLabel", "summary", "striker"].some((key) => typeof event[key] !== "string")) ||
        !Array.isArray(innings.currentOver) || innings.currentOver.some((event) => !event || typeof event.label !== "string") ||
        typeof innings.awaitingPair !== "boolean" || !Number.isFinite(innings.overRuns) ||
        (!innings.awaitingPair && !innings.battingPairs[innings.pairIndex]) ||
        !(innings.bowler === null || players.includes(innings.bowler))) fail();
    for (const key of ["pairScores", "pairWickets"]) {
      if (!Array.isArray(innings[key]) || innings[key].length !== 4 || innings[key].some((n) => !Number.isFinite(n))) fail();
    }
    for (const key of ["playerRuns", "playerBalls", "bowlerOvers", "bowlerRuns", "bowlerWickets", "bowlerExtras"]) {
      if (!innings[key] || typeof innings[key] !== "object" || Array.isArray(innings[key]) || Object.values(innings[key]).some((n) => !Number.isFinite(n))) fail();
    }
    if (!innings.fielding || Object.values(innings.fielding).some((stats) =>
      !stats || ["catches", "runouts", "stumpings", "drops"].some((key) => !Number.isFinite(stats[key])))) fail();
  }
  if (config.schemaVersion === 2) {
    const first = config[config.battingFirst].players;
    const second = config[config.battingFirst === "teamA" ? "teamB" : "teamA"].players;
    const ordered = [...saved.completedInnings, saved.state];
    const stable = value => JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(name => [name,item[name]])) : item);
    for (const [index, innings] of ordered.entries()) {
      const rebuilt = recalculateInnings(innings,index === 0 ? first : second,index === 0 ? second : first);
      if (Object.keys(rebuilt).some(key => stable(rebuilt[key]) !== stable(innings[key]))) fail();
    }
    for (const innings of verifyUndo ? saved.undoStack : []) {
      const rebuilt = recalculateInnings(innings,saved.inningsNumber === 1 ? first : second,saved.inningsNumber === 1 ? second : first);
      if (Object.keys(rebuilt).some(key => stable(rebuilt[key]) !== stable(innings[key]))) fail();
    }
  }

}
