'use strict';

const { getUserStats, turnStatsByUser } = require('./stats');

const MIN_GAMES = 1; // Rangliste ab dem ersten Spiel

/**
 * Rangliste für einen Spielmodus.
 * Siegquote = Siege / Spiele. Tiebreak: tieferer Rundendurchschnitt in gewonnenen Spielen,
 * danach mehr Spiele. Wer weniger als `minGames` Spiele hat, steht unter `unranked`.
 * Deaktivierte User werden nicht gewertet. Average (nur aus Spielen mit erfassten
 * Aufnahmen) und 180er sind Zusatzinfos und beeinflussen die Reihenfolge nicht.
 */
function getRanking(db, modeId, minGames = MIN_GAMES) {
  const turnStats = turnStatsByUser(db, modeId);

  const rows = db
    .prepare(
      `SELECT u.id AS user_id,
              u.name AS name,
              COUNT(*) AS games,
              SUM(mp.won) AS wins,
              AVG(CASE WHEN mp.won = 1 THEN mp.rounds END) AS avg_win_rounds
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         JOIN users u ON u.id = mp.user_id
        WHERE m.game_mode_id = ? AND u.aktiv = 1
        GROUP BY u.id`
    )
    .all(modeId)
    .map((r) => ({
      ...r,
      quote: r.games ? r.wins / r.games : 0,
      avg: turnStats.get(r.user_id)?.avg ?? null,
      n180: turnStats.get(r.user_id)?.n180 ?? 0,
    }));

  const cmp = (a, b) =>
    b.quote - a.quote ||
    (a.avg_win_rounds ?? Infinity) - (b.avg_win_rounds ?? Infinity) ||
    b.games - a.games ||
    a.name.localeCompare(b.name);

  const ranked = rows.filter((r) => r.games >= minGames).sort(cmp);
  const unranked = rows.filter((r) => r.games < minGames).sort(cmp);

  // Gleichplatzierung bei identischer Quote und identischem Rundendurchschnitt
  let lastKey = null;
  let lastRank = 0;
  ranked.forEach((r, i) => {
    const key = `${r.quote}|${r.avg_win_rounds}`;
    if (key !== lastKey) {
      lastRank = i + 1;
      lastKey = key;
    }
    r.rank = lastRank;
  });

  return { ranked, unranked, minGames, hasTurns: rows.some((r) => r.avg !== null || r.n180 > 0) };
}

module.exports = { getRanking, getUserStats, MIN_GAMES };
