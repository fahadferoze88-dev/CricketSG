import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const NAV = [
  { id: "matchday", label: "Match Day" },
  { id: "season", label: "Season" },
  { id: "hall", label: "Hall" },
  { id: "players", label: "Players" },
];

const TABS = [
  { id: "batting", label: "Batting" },
  { id: "bowling", label: "Bowling" },
  { id: "fielding", label: "Fielding" },
  { id: "mvp", label: "MVP" },
];

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(() => {
    const hash = window.location.hash.replace("#", "");
    return NAV.some((item) => item.id === hash) ? hash : "matchday";
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/data.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`data.json returned ${response.status}`);
        return response.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Shell page={page} setPage={setPage}>
        <section className="notice-card" role="alert">
          <p className="eyebrow">Data unavailable</p>
          <h1>Could not load the scorebook.</h1>
          <p>Refresh the page, or check that <strong>/public/data.json</strong> exists before deploying.</p>
          <p className="muted">{error}</p>
        </section>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell page={page} setPage={setPage}>
        <section className="notice-card">
          <p className="eyebrow">Loading</p>
          <h1>Reading the latest match day.</h1>
        </section>
      </Shell>
    );
  }

  return (
    <Shell page={page} setPage={setPage} data={data}>
      {page === "matchday" && <MatchDayPage data={data} />}
      {page === "season" && <SeasonPage data={data} />}
      {page === "hall" && <HallPage data={data} />}
      {page === "players" && <PlayersPage data={data} />}
    </Shell>
  );
}

function Shell({ children, page, setPage, data }) {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#matchday" onClick={(event) => switchPage(event, "matchday", setPage)}>
          <img src="/logo.png" alt="" onError={(event) => event.currentTarget.classList.add("image-missing")} />
          <span className="brand-fallback" aria-hidden="true">CSG</span>
          <span>Cricket SG Central</span>
        </a>
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={page === item.id ? "active" : ""}
              onClick={(event) => switchPage(event, item.id, setPage)}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <span>Cricket SG Central</span>
        {data && <span>Updated {formatDateTime(data.meta.generated_at)}</span>}
      </footer>
    </>
  );
}

function switchPage(event, nextPage, setPage) {
  event.preventDefault();
  setPage(nextPage);
  window.history.replaceState(null, "", `#${nextPage}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function MatchDayPage({ data }) {
  const days = [...data.views.recent_days].reverse();
  return (
    <div className="page-shell">
      <PageIntro
        eyebrow="Latest scorecards"
        title="Match Day"
        copy="Recent indoor cricket from Singapore. True team totals include extras; player runs are shown separately in the scorecards."
      />
      <div className="day-stack">
        {days.map((day, index) => (
          <section className={index === 0 ? "match-day current" : "match-day recessed"} key={day.date}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">{index === 0 ? "Most recent" : "Previous"}</p>
                <h2>{formatDate(day.date)}</h2>
              </div>
              <span className="meta-pill">{day.match_count ?? day.matches.length} matches</span>
            </div>
            <DayLeaders leaders={day.leaders} />
            <div className="match-list">
              {day.matches.map((match) => (
                <MatchCard key={match.id} match={match} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function DayLeaders({ leaders }) {
  const [tab, setTab] = useState("batting");
  if (!leaders) return null;
  return (
    <section className="day-leaders">
      <div className="section-heading slim">
        <div>
          <p className="eyebrow">Day leaders</p>
          <h2>Best of the Nets</h2>
        </div>
      </div>
      <Tabs tab={tab} setTab={setTab} />
      {tab === "mvp" && <p className="explainer">MVP is runs scored per match minus runs conceded per match.</p>}
      {tab === "bowling" && <p className="explainer">Economy is sorted low to high; lower is better.</p>}
      <LeaderboardTable type={tab} rows={leaders[tab]} compact />
    </section>
  );
}

function MatchCard({ match }) {
  const teams = groupBy(match.batting, "team_slot");
  const bowlingTeams = groupBy(match.bowling, "team_slot");
  const footers = scorecardFooters(match);
  return (
    <article className="match-card">
      <div className="result-hero">
        <p className="eyebrow">{display(match.competition)}</p>
        <h3>{matchResultText(match)}</h3>
        {match.has_true_totals && match.team_totals && (
          <p>
            {sideLabel(match, "Team 1")} {formatStat(match.team_totals["Team 1"], "integer")} ·{" "}
            {sideLabel(match, "Team 2")} {formatStat(match.team_totals["Team 2"], "integer")}
          </p>
        )}
      </div>
      <div className="innings-grid">
        {Object.entries(teams).map(([teamSlot, rows]) => (
          <ScorecardBlock
            key={teamSlot}
            title={sideLabel(match, teamSlot)}
            side={rows[0]?.side}
            rows={rows}
            footerRows={footers.batting.get(teamSlot)}
            columns={[
              ["player", "Player"],
              ["runs", "Runs", "integer"],
              ["balls_faced", "Balls", "integer optional"],
              ["out", "Out", "integer optional"],
            ]}
          />
        ))}
        {Object.entries(bowlingTeams).map(([teamSlot, rows]) => (
          <ScorecardBlock
            key={`${teamSlot}-bowling`}
            title={`${sideLabel(match, teamSlot)} bowling`}
            side={rows[0]?.side}
            rows={rows}
            footerRows={footers.bowling.get(teamSlot)}
            columns={[
              ["player", "Player"],
              ["runs", "Runs", "integer"],
              ["wickets", "Wkts", "integer optional"],
              ["extras", "Extras", "integer optional"],
            ]}
          />
        ))}
      </div>
    </article>
  );
}

function ScorecardBlock({ title, side, rows, columns, footerRows }) {
  return (
    <details className="scorecard" open>
      <summary>
        <span>{title}</span>
        <span className={side === "Won" ? "side won" : "side"}>{display(side)}</span>
      </summary>
      <Table rows={rows} columns={columns} footerRows={footerRows} compact />
    </details>
  );
}

function SeasonPage({ data }) {
  const [tab, setTab] = useState("batting");
  const season = data.views.season;
  const minMatches = season.min_matches ?? data.meta.config.season_leaderboard_min_matches;
  return (
    <div className="page-shell">
      <PageIntro
        eyebrow={data.meta.current_season}
        title={data.meta.season_label}
        copy="Current-season leaders, rendered from the official generated views."
      />
      <p className="explainer">Minimum {formatStat(minMatches, "integer")} matches.</p>
      <Tabs tab={tab} setTab={setTab} />
      {tab === "mvp" && <p className="explainer">MVP is runs scored per match minus runs conceded per match.</p>}
      {tab === "bowling" && <p className="explainer">Economy is sorted low to high; lower is better.</p>}
      <LeaderboardTable type={tab} rows={season[tab]} />
      {tab === "fielding" && <p className="footnote">Fielding tracked from 2023 onward.</p>}
    </div>
  );
}

function HallPage({ data }) {
  const [tab, setTab] = useState("batting");
  const hall = data.views.hall_of_fame;
  const formByPlayer = useMemo(() => {
    return new Map(
      Object.entries(data.views.player_records || {}).map(([name, record]) => [name, record.form || []]),
    );
  }, [data.views.player_records]);
  return (
    <div className="hall-page">
      <div className="page-shell">
        <section className="hall-intro">
          <p>Hall of Fame</p>
          <h1>The Long List</h1>
          <span>
            Minimum {formatStat(data.meta.config.hall_of_fame_min_matches, "integer")} matches. Top{" "}
            {formatStat(data.meta.config.hall_of_fame_top_n, "integer")} in each discipline.
          </span>
        </section>
        <Tabs tab={tab} setTab={setTab} dark />
        {tab === "mvp" && <p className="explainer dark">MVP is runs scored per match minus runs conceded per match.</p>}
        {tab === "bowling" && <p className="explainer dark">Economy is sorted low to high; lower is better.</p>}
        <div className="hof-list">
          {hall[tab].map((row, index) => (
            <HallRow key={row.player} row={row} index={index} type={tab} form={formByPlayer.get(row.player) || []} />
          ))}
        </div>
        {tab === "fielding" && <p className="footnote dark">Fielding tracked from 2023 onward.</p>}
      </div>
    </div>
  );
}

function HallRow({ row, index, type, form }) {
  const metric = primaryMetric(type, row);
  return (
    <article className="hof-row">
      <div className="rank">{String(index + 1).padStart(2, "0")}</div>
      <div className="hof-main">
        <h3>{row.player}</h3>
        <FormLine values={form} large />
      </div>
      <div className="hof-metric">
        <span>{metric.label}</span>
        <strong className="num">{formatStat(metric.value, metric.kind)}</strong>
        <em>{formatStat(matchCount(row), "integer")} matches</em>
      </div>
    </article>
  );
}

function PlayersPage({ data }) {
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const records = data.views.player_records || {};
  const histories = useMemo(() => buildPlayerHistories(data), [data]);
  const players = useMemo(
    () => data.players.filter((player) => player.in_history).sort((a, b) => a.name.localeCompare(b.name)),
    [data.players],
  );
  const filteredPlayers = players.filter((player) => player.name.toLowerCase().includes(query.toLowerCase()));
  const activeName = selectedName || filteredPlayers[0]?.name;
  const selectedPlayer = activeName && records[activeName] ? { ...records[activeName], history: histories.get(activeName) } : null;

  return (
    <div className="page-shell players-layout">
      <PageIntro
        eyebrow={`${data.meta.config.player_history_min_matches}+ match players`}
        title="Players"
        copy="Search a player, then open their official career record and discipline-by-discipline match history."
      />
      <section className="player-search-card">
        <label htmlFor="player-search">Search players</label>
        <input
          id="player-search"
          type="search"
          value={query}
          placeholder="Type a name"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedName("");
          }}
        />
        <div className="player-list" role="list">
          {filteredPlayers.length === 0 ? (
            <div className="empty-state">No player matched that search. Try fewer letters or check the scorebook spelling.</div>
          ) : (
            filteredPlayers.map((player) => (
              <button
                key={player.name}
                className={activeName === player.name ? "player-button active" : "player-button"}
                onClick={() => setSelectedName(player.name)}
              >
                <span>{player.name}</span>
                <span className="num">{formatStat(player.matches, "integer")}</span>
              </button>
            ))
          )}
        </div>
      </section>
      {selectedPlayer && <PlayerRecord player={selectedPlayer} />}
    </div>
  );
}

function PlayerRecord({ player }) {
  const history = player.history || { batting: [], bowling: [], fielding: [] };
  return (
    <section className="player-record">
      <div className="record-header">
        <div>
          <p className="eyebrow">Player record</p>
          <h2>{player.player}</h2>
          <span>
            {formatDateOrCompetition(player.first_played)} to {formatDateOrCompetition(player.last_played)} ·{" "}
            {formatStat(player.matches, "integer")} matches
          </span>
        </div>
        <FormLine values={player.form || []} large />
      </div>
      <PlayerDiscipline
        title="Batting"
        stats={[
          ["Runs", player.batting.runs, "integer"],
          ["Runs / innings", player.batting.runs_per_innings, "decimal"],
          ["Strike rate", player.batting.strike_rate, "strike"],
          ["Highest", player.batting.highest, "integer"],
        ]}
        rows={history.batting}
        columns={[
          ["date_label", "Date"],
          ["season", "Season"],
          ["runs", "Runs", "integer"],
          ["balls_faced", "Balls", "integer optional"],
          ["out", "Out", "integer optional"],
          ["side", "Result"],
        ]}
      />
      <PlayerDiscipline
        title="Bowling"
        stats={[
          ["Conceded", player.bowling.runs_conceded, "integer"],
          ["Economy", player.bowling.economy, "decimal"],
          ["Wickets", player.bowling.wickets, "integer"],
          ["Extras", player.bowling.extras, "integer"],
        ]}
        rows={history.bowling}
        columns={[
          ["date_label", "Date"],
          ["season", "Season"],
          ["runs", "Runs", "integer"],
          ["wickets", "Wkts", "integer optional"],
          ["extras", "Extras", "integer optional"],
          ["side", "Result"],
        ]}
      />
      <PlayerDiscipline
        title="Fielding"
        stats={[
          ["Dismissals", player.fielding.dismissals, "integer"],
          ["Catches", player.fielding.catches, "integer"],
          ["Runouts", player.fielding.runouts, "integer"],
          ["Catch %", player.fielding.catch_pct, "percent"],
        ]}
        rows={history.fielding}
        columns={[
          ["date_label", "Date"],
          ["season", "Season"],
          ["catches", "Ct", "integer"],
          ["runouts", "RO", "integer optional"],
          ["stumpings", "St", "integer optional"],
          ["dismissals", "Dis", "integer optional"],
          ["side", "Result"],
        ]}
        note="Fielding and match results tracked from 2023 onward."
      />
    </section>
  );
}

function PlayerDiscipline({ title, stats, rows, columns, note }) {
  return (
    <section className="discipline-section">
      <div className="section-heading slim">
        <div>
          <p className="eyebrow">{title}</p>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="stat-grid">
        {stats.map(([label, value, kind]) => (
          <StatCard key={label} label={label} value={value} kind={kind} />
        ))}
      </div>
      {note && <p className="footnote">{note}</p>}
      {rows.length > 0 ? (
        <Table rows={rows} columns={columns} compact />
      ) : (
        <div className="empty-state section-empty">{note || "No rows recorded for this section."}</div>
      )}
    </section>
  );
}

function StatCard({ label, value, kind = "integer" }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong className="num">{formatStat(value, kind)}</strong>
    </div>
  );
}

function LeaderboardTable({ type, rows, compact = true }) {
  return (
    <Table
      rows={rows.map((row, index) => ({ rank: index + 1, matches_display: matchCount(row), ...row }))}
      columns={leaderboardColumns(type)}
      ranked
      compact={compact}
    />
  );
}

function Table({ rows, columns, ranked = false, compact = false, footerRows = [] }) {
  const optionalColumns = columns.filter(([, , kind]) => kind?.includes("optional"));
  return (
    <div className={compact ? "table-wrap compact" : "table-wrap"}>
      <table>
        <thead>
          <tr>
            {ranked && <th className="rank-col">#</th>}
            {columns.map(([, label, kind]) => (
              <th key={label} className={cellClass(null, kind)}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <React.Fragment key={`${row.player || row.date_label || row.id}-${index}`}>
              <tr>
                {ranked && <td className="rank-col">{row.rank}</td>}
                {columns.map(([key, , kind]) => (
                  <td key={key} className={cellClass(row[key], kind)} data-label={key}>
                    {renderCell(row[key], kind)}
                  </td>
                ))}
              </tr>
              {compact && optionalColumns.length > 0 && (
                <tr className="mobile-detail-row">
                  <td colSpan={columns.length + (ranked ? 1 : 0)}>
                    <details>
                      <summary>More</summary>
                      <div>
                        {optionalColumns.map(([key, label, kind]) => (
                          <span key={key}>
                            <strong>{label}</strong>
                            {renderCell(row[key], kind)}
                          </span>
                        ))}
                      </div>
                    </details>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
        {footerRows.length > 0 && (
          <tfoot>
            {footerRows.map((row) => (
              <tr key={row.player}>
                {ranked && <td className="rank-col" />}
                {columns.map(([key, , kind]) => (
                  <td key={key} className={cellClass(row[key], kind)} data-label={key}>
                    {renderCell(row[key], kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Tabs({ tab, setTab, dark = false }) {
  return (
    <div className={dark ? "tabs dark" : "tabs"} role="tablist" aria-label="Leaderboard category">
      {TABS.map((item) => (
        <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function PageIntro({ eyebrow, title, copy, dark = false }) {
  return (
    <section className={dark ? "page-intro dark" : "page-intro"}>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{copy}</p>
    </section>
  );
}

function FormLine({ values, large = false }) {
  const recent = values;
  const max = Math.max(8, ...recent.map((value) => Math.abs(Number(value) || 0)));
  return (
    <span className={large ? "form-line large" : "form-line"} aria-label={`Last ${recent.length} innings form`}>
      <span className="baseline" />
      {recent.map((value, index) => {
        const height = Math.max(3, (Math.abs(value) / max) * (large ? 22 : 16));
        const style = value >= 0 ? { height, bottom: "50%" } : { height, top: "50%" };
        return <span key={`${value}-${index}`} className={value >= 0 ? "bar positive" : "bar negative"} style={style} />;
      })}
    </span>
  );
}

function buildPlayerHistories(data) {
  const matchesById = new Map(data.matches.map((match) => [match.id, match]));
  const histories = new Map();
  const addRow = (playerName, type, row) => {
    if (!histories.has(playerName)) histories.set(playerName, { batting: [], bowling: [], fielding: [] });
    histories.get(playerName)[type].push(row);
  };

  for (const row of mapRows(data.raw.batting)) {
    const match = matchesById.get(row.match);
    if (!match) continue;
    addRow(row.player, "batting", {
      ...matchMeta(match),
      runs: row.runs,
      balls_faced: row.balls_faced,
      out: row.out,
      side: display(row.side),
    });
  }

  for (const row of mapRows(data.raw.bowling)) {
    const match = matchesById.get(row.match);
    if (!match) continue;
    addRow(row.player, "bowling", {
      ...matchMeta(match),
      runs: row.runs,
      wickets: row.wickets,
      extras: row.wides,
      side: display(row.side),
    });
  }

  for (const row of mapRows(data.raw.fielding)) {
    const match = matchesById.get(row.match);
    if (!match) continue;
    const catches = toNumber(row.catches);
    const runouts = toNumber(row.runouts);
    const stumpings = toNumber(row.stumpings);
    addRow(row.player, "fielding", {
      ...matchMeta(match),
      catches,
      runouts,
      stumpings,
      dismissals: catches + runouts + stumpings,
      side: display(row.side),
    });
  }

  for (const history of histories.values()) {
    for (const key of Object.keys(history)) history[key].sort(sortMatchRows);
  }

  return histories;
}

function matchMeta(match) {
  const dated = hasRecordedDate(match.date);
  return {
    id: match.id,
    date: match.date,
    date_label: dated ? formatDate(match.date) : display(match.competition),
    season: display(match.season),
    competition: display(match.competition),
    result: matchResultText(match),
    undated: !dated,
  };
}

function sortMatchRows(a, b) {
  if (a.undated !== b.undated) return a.undated ? 1 : -1;
  return String(b.date || "").localeCompare(String(a.date || ""));
}

function mapRows(table) {
  return table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function leaderboardColumns(type) {
  if (type === "batting") {
    return [
      ["player", "Player"],
      ["matches_display", "Matches", "integer"],
      ["runs", "Runs", "integer"],
      ["runs_per_innings", "Runs / inn", "decimal optional"],
      ["strike_rate", "SR", "strike optional"],
      ["highest", "High", "integer optional"],
    ];
  }
  if (type === "bowling") {
    return [
      ["player", "Player"],
      ["matches_display", "Matches", "integer"],
      ["economy", "Econ", "decimal"],
      ["runs_conceded", "Runs", "integer optional"],
      ["wickets", "Wkts", "integer optional"],
      ["extras", "Extras", "integer optional"],
    ];
  }
  if (type === "fielding") {
    return [
      ["player", "Player"],
      ["matches_display", "Matches", "integer"],
      ["dismissals", "Dis", "integer"],
      ["catches", "Ct", "integer optional"],
      ["runouts", "RO", "integer optional"],
      ["catch_pct", "Ct%", "percent optional"],
    ];
  }
  return [
    ["player", "Player"],
    ["matches_display", "Matches", "matches"],
    ["mvp_score", "Score", "decimal"],
    ["runs_per_match", "Bat/M", "decimal optional"],
    ["conceded_per_match", "Bowl/M", "decimal optional"],
  ];
}

function primaryMetric(type, row) {
  if (type === "batting") return { label: "Runs / innings", value: row.runs_per_innings, kind: "decimal" };
  if (type === "bowling") return { label: "Economy", value: row.economy, kind: "decimal" };
  if (type === "fielding") return { label: "Dismissals", value: row.dismissals, kind: "integer" };
  return { label: "MVP score", value: row.mvp_score, kind: "decimal" };
}

function matchCount(row) {
  if (row.matches !== undefined) return row.matches;
  if (row.matches_batting !== undefined && row.matches_bowling !== undefined) {
    if (row.matches_batting === row.matches_bowling) return row.matches_batting;
    return `${row.matches_batting}/${row.matches_bowling}`;
  }
  return row.matches_batting ?? row.matches_bowling ?? null;
}

function matchResultText(match) {
  if (match.result === "Tie") return "Match tied";
  if (!match.winning_captain) return "Result not recorded";
  if (match.has_true_totals) return `${match.winning_captain}'s team won by ${formatStat(match.margin, "integer")} runs`;
  return `${match.winning_captain}'s team won`;
}

function scorecardFooters(match) {
  const batting = new Map();
  const bowling = new Map();
  if (!match.has_true_totals || !Array.isArray(match.innings)) return { batting, bowling };

  for (const innings of match.innings) {
    batting.set(innings.batting_slot, [
      { player: "Extras", runs: innings.batting_extras, balls_faced: "", out: "" },
      { player: "Total", runs: innings.total, balls_faced: "", out: "" },
    ]);
    bowling.set(innings.bowling_slot, [
      { player: "Run Outs", runs: innings.bowling_run_outs, wickets: "", extras: "" },
      { player: "Total", runs: innings.total, wickets: "", extras: "" },
    ]);
  }

  return { batting, bowling };
}

function sideLabel(match, teamSlot) {
  const captain = captainForSlot(match, teamSlot);
  return captain ? `${captain}${captain.endsWith("s") ? "'" : "'s"} team` : display(teamSlot);
}

function captainForSlot(match, teamSlot) {
  if (match.winner_slot === teamSlot) return match.winning_captain;
  if (match.winner_slot && match.winner_slot !== teamSlot) return match.losing_captain;
  return null;
}

function renderCell(value, kind = "") {
  if (kind.includes("integer") || kind.includes("decimal") || kind.includes("percent") || kind.includes("strike")) {
    return <span className="num">{formatStat(value, kind)}</span>;
  }
  return display(value);
}

function formatStat(value, kind = "integer") {
  if (value === null || value === undefined || value === "Unknown" || value === "—") return "—";
  if (typeof value === "string" && value.includes("/")) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return display(value);
  if (kind.includes("decimal")) return number.toFixed(2);
  if (kind.includes("percent")) return `${number.toFixed(0)}%`;
  if (kind.includes("strike")) return number.toFixed(1);
  return String(Math.trunc(number));
}

function numberClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "numeric";
  if (number < 0) return "numeric negative-number";
  if (number > 0) return "numeric positive-number";
  return "numeric";
}

function cellClass(value, kind = "") {
  const classes = [];
  if (kind.includes("integer") || kind.includes("decimal") || kind.includes("percent") || kind.includes("strike") || kind.includes("matches")) {
    classes.push(numberClass(value));
  }
  if (kind.includes("optional")) classes.push("optional");
  return classes.join(" ");
}

function display(value) {
  return value === null || value === undefined || value === "Unknown" || value === "" ? "—" : String(value);
}

function hasRecordedDate(value) {
  return /^\d{8}$/.test(String(value || ""));
}

function formatDate(value) {
  const raw = String(value || "");
  if (hasRecordedDate(raw)) {
    return new Intl.DateTimeFormat("en-SG", { day: "2-digit", month: "short", year: "numeric" }).format(
      new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00+08:00`),
    );
  }
  return display(value);
}

function formatDateOrCompetition(value) {
  return hasRecordedDate(value) ? formatDate(value) : display(value);
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-SG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function groupBy(rows, key) {
  return rows.reduce((groups, row) => {
    const groupKey = display(row[key]);
    groups[groupKey] = groups[groupKey] || [];
    groups[groupKey].push(row);
    return groups;
  }, {});
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

createRoot(document.getElementById("root")).render(<App />);
