'use strict';

// Kennzahlen aus den erfassten Aufnahmen (turns); 180er aus match_players.n180
// (aus den Aufnahmen berechnet oder direkt eingetragen, zählt auch ohne Aufnahmen).
// Average = Punkte pro Aufnahme (3-Dart-Average). Nur Spiele mit erfassten Aufnahmen zählen.
// Eine Checkout-Quote braucht die Darts auf Doppel pro Runde und wird hier nicht erfasst;
// stattdessen gibt es das höchste Finish.

const MODE_FILTER = '(? IS NULL OR m.game_mode_id = ?)';

function turnTotals(db, userId, modeId = null) {
  const r = db
    .prepare(
      `SELECT COUNT(t.id) AS visits,
              COALESCE(SUM(t.punkte), 0) AS points,
              COUNT(DISTINCT mp.id) AS legs
         FROM turns t
         JOIN match_players mp ON mp.id = t.match_player_id
         JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ? AND ${MODE_FILTER}`
    )
    .get(userId, modeId, modeId);
  const n180 = db
    .prepare(
      `SELECT COALESCE(SUM(mp.n180), 0) AS n
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ? AND ${MODE_FILTER}`
    )
    .get(userId, modeId, modeId).n;
  return { ...r, n180, avg: r.visits ? r.points / r.visits : null };
}

/** Höchstes Finish = letzte Aufnahme eines gewonnenen Spiels (nur Spiele mit Aufnahmen). */
function highestFinish(db, userId, modeId = null) {
  return (
    db
      .prepare(
        `SELECT MAX(t.punkte) AS best
           FROM turns t
           JOIN match_players mp ON mp.id = t.match_player_id
           JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = ? AND mp.won = 1 AND ${MODE_FILTER}
            AND t.rundennummer = (SELECT MAX(rundennummer) FROM turns WHERE match_player_id = mp.id)`
      )
      .get(userId, modeId, modeId).best ?? null
  );
}

function bestLeg(db, userId, modeId = null) {
  return (
    db
      .prepare(
        `SELECT MIN(mp.rounds) AS best
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = ? AND mp.won = 1 AND ${MODE_FILTER}`
      )
      .get(userId, modeId, modeId).best ?? null
  );
}

/** Alle Kennzahlen eines Users, optional für einen Modus. */
function getUserStats(db, userId, modeId = null) {
  const g = db
    .prepare(
      `SELECT COUNT(*) AS games,
              COALESCE(SUM(mp.won), 0) AS wins,
              AVG(CASE WHEN mp.won = 1 THEN mp.rounds END) AS avg_win_rounds
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ? AND ${MODE_FILTER}`
    )
    .get(userId, modeId, modeId);

  const t = turnTotals(db, userId, modeId);
  return {
    games: g.games,
    wins: g.wins,
    quote: g.games ? g.wins / g.games : 0,
    avg_win_rounds: g.avg_win_rounds,
    best_leg: bestLeg(db, userId, modeId),
    visits: t.visits,
    legs_with_turns: t.legs,
    avg: t.avg,
    n180: t.n180,
    best_finish: highestFinish(db, userId, modeId),
  };
}

/** Übersicht aller aktiven Spieler mit erfassten Aufnahmen, bester Average zuerst. */
function getLeaders(db, modeId = null) {
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.name,
              COUNT(t.id) AS visits,
              SUM(t.punkte) AS points,
              COUNT(DISTINCT mp.id) AS legs
         FROM turns t
         JOIN match_players mp ON mp.id = t.match_player_id
         JOIN matches m ON m.id = mp.match_id
         JOIN users u ON u.id = mp.user_id
        WHERE u.aktiv = 1 AND ${MODE_FILTER}
        GROUP BY u.id`
    )
    .all(modeId, modeId);

  // 180er zählen auch ohne Aufnahmen: Spieler mit nur 180ern erscheinen ohne Average
  const n180s = db
    .prepare(
      `SELECT u.id AS user_id, u.name, SUM(mp.n180) AS n180
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         JOIN users u ON u.id = mp.user_id
        WHERE u.aktiv = 1 AND ${MODE_FILTER}
        GROUP BY u.id
       HAVING SUM(mp.n180) > 0`
    )
    .all(modeId, modeId);
  const byUser = new Map(rows.map((r) => [r.user_id, r]));
  for (const r of rows) r.n180 = 0;
  for (const c of n180s) {
    const r = byUser.get(c.user_id);
    if (r) r.n180 = c.n180;
    else rows.push({ user_id: c.user_id, name: c.name, visits: 0, points: 0, legs: 0, n180: c.n180 });
  }

  const finishes = new Map(
    db
      .prepare(
        `SELECT mp.user_id, MAX(t.punkte) AS best
           FROM turns t
           JOIN match_players mp ON mp.id = t.match_player_id
           JOIN matches m ON m.id = mp.match_id
          WHERE mp.won = 1 AND ${MODE_FILTER}
            AND t.rundennummer = (SELECT MAX(rundennummer) FROM turns WHERE match_player_id = mp.id)
          GROUP BY mp.user_id`
      )
      .all(modeId, modeId)
      .map((r) => [r.user_id, r.best])
  );

  return rows
    .map((r) => ({ ...r, avg: r.visits ? r.points / r.visits : null, best_finish: finishes.get(r.user_id) ?? null }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.n180 - a.n180 || a.name.localeCompare(b.name));
}

/** Average und 180er pro User in einem Modus (für die Rangliste), als Map user_id -> Werte. */
function turnStatsByUser(db, modeId) {
  const rows = db
    .prepare(
      `SELECT mp.user_id, COUNT(t.id) AS visits, SUM(t.punkte) AS points
         FROM turns t
         JOIN match_players mp ON mp.id = t.match_player_id
         JOIN matches m ON m.id = mp.match_id
        WHERE m.game_mode_id = ?
        GROUP BY mp.user_id`
    )
    .all(modeId);
  const out = new Map(rows.map((r) => [r.user_id, { avg: r.visits ? r.points / r.visits : null, n180: 0 }]));
  const counts = db
    .prepare(
      `SELECT mp.user_id, SUM(mp.n180) AS n180
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE m.game_mode_id = ?
        GROUP BY mp.user_id`
    )
    .all(modeId);
  for (const c of counts) {
    const o = out.get(c.user_id);
    if (o) o.n180 = c.n180;
    else out.set(c.user_id, { avg: null, n180: c.n180 });
  }
  return out;
}

module.exports = { getUserStats, getLeaders, turnStatsByUser, turnTotals, highestFinish, bestLeg };
