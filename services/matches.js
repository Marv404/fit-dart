'use strict';

const EDIT_WINDOW_MIN = 30;
const PAGE_SIZE = 25;

// Pro Spieler: Aufnahmen-Kennzahlen aus der turns-Tabelle (NULL/0, wenn keine erfasst);
// die 180er stehen in match_players.n180 (aus den Aufnahmen berechnet oder direkt eingetragen)
const PLAYER_COLUMNS = `
  mp.id AS mp_id, mp.user_id, mp.rounds, mp.won, mp.n180, u.name,
  (SELECT COUNT(*) FROM turns t WHERE t.match_player_id = mp.id) AS visits,
  (SELECT SUM(punkte) FROM turns t WHERE t.match_player_id = mp.id) AS points`;

function withAverage(p) {
  p.avg = p.visits ? p.points / p.visits : null;
  return p;
}

function getMatch(db, id) {
  const match = db
    .prepare(
      `SELECT m.id, m.datum, m.game_mode_id, m.erfasst_von, m.erstellt_am,
              gm.name AS modus, u.name AS erfasst_von_name
         FROM matches m
         JOIN game_modes gm ON gm.id = m.game_mode_id
         JOIN users u ON u.id = m.erfasst_von
        WHERE m.id = ?`
    )
    .get(id);
  if (!match) return null;

  const getTurns = db.prepare('SELECT punkte FROM turns WHERE match_player_id = ? ORDER BY rundennummer');
  match.players = db
    .prepare(
      `SELECT ${PLAYER_COLUMNS}
         FROM match_players mp JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id = ?
        ORDER BY mp.won DESC, mp.rounds ASC, u.name`
    )
    .all(id)
    .map((p) => ({ ...withAverage(p), turns: getTurns.all(p.mp_id).map((t) => t.punkte) }));
  return match;
}

/** Admin darf immer, der Ersteller innerhalb von EDIT_WINDOW_MIN Minuten nach dem Speichern. */
function canEdit(user, match, now = Date.now()) {
  if (!user || !match) return false;
  if (user.role === 'admin') return true;
  if (match.erfasst_von !== user.id) return false;
  const created = Date.parse(`${match.erstellt_am.replace(' ', 'T')}Z`);
  return now - created <= EDIT_WINDOW_MIN * 60 * 1000;
}

function insertPlayers(db, matchId, players) {
  const insPlayer = db.prepare('INSERT INTO match_players (match_id, user_id, rounds, won, n180) VALUES (?, ?, ?, ?, ?)');
  const insTurn = db.prepare('INSERT INTO turns (match_player_id, rundennummer, punkte) VALUES (?, ?, ?)');
  for (const p of players) {
    const n180 = p.n180 ?? (p.turns || []).filter((t) => t === 180).length;
    const mpId = insPlayer.run(matchId, p.user_id, p.rounds, p.won, n180).lastInsertRowid;
    (p.turns || []).forEach((points, i) => insTurn.run(mpId, i + 1, points));
  }
}

function createMatch(db, { datum, game_mode_id, players }, erfasstVon) {
  const run = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO matches (datum, game_mode_id, erfasst_von) VALUES (?, ?, ?)')
      .run(datum, game_mode_id, erfasstVon);
    insertPlayers(db, lastInsertRowid, players);
    return Number(lastInsertRowid);
  });
  return run();
}

function updateMatch(db, id, { datum, game_mode_id, players }) {
  db.transaction(() => {
    db.prepare('UPDATE matches SET datum = ?, game_mode_id = ? WHERE id = ?').run(datum, game_mode_id, id);
    db.prepare('DELETE FROM match_players WHERE match_id = ?').run(id); // turns via ON DELETE CASCADE
    insertPlayers(db, id, players);
  })();
}

function deleteMatch(db, id) {
  db.prepare('DELETE FROM matches WHERE id = ?').run(id); // match_players und turns via ON DELETE CASCADE
}

/**
 * Spielverlauf mit optionalen Filtern.
 * filters: { modeId, userId, page }
 */
function listMatches(db, { modeId, userId, page = 1 } = {}) {
  const where = [];
  const params = [];
  if (modeId) {
    where.push('m.game_mode_id = ?');
    params.push(modeId);
  }
  if (userId) {
    where.push('EXISTS (SELECT 1 FROM match_players x WHERE x.match_id = m.id AND x.user_id = ?)');
    params.push(userId);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM matches m ${w}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);

  const rows = db
    .prepare(
      `SELECT m.id, m.datum, m.erfasst_von, m.erstellt_am, gm.name AS modus
         FROM matches m JOIN game_modes gm ON gm.id = m.game_mode_id
         ${w}
        ORDER BY m.datum DESC, m.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, (p - 1) * PAGE_SIZE);

  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const all = db
      .prepare(
        `SELECT mp.match_id, ${PLAYER_COLUMNS}
           FROM match_players mp JOIN users u ON u.id = mp.user_id
          WHERE mp.match_id IN (${marks})
          ORDER BY mp.won DESC, mp.rounds ASC, u.name`
      )
      .all(...ids);
    const byMatch = new Map(rows.map((r) => [r.id, (r.players = [])]));
    for (const a of all) byMatch.get(a.match_id).push(withAverage(a));
  }

  return { rows, total, page: p, pages };
}

/** Alle Spiele als CSV-Zeilen (eine Zeile pro Spieler). */
function exportRows(db) {
  return db
    .prepare(
      `SELECT m.id AS match_id, m.datum, gm.name AS modus, u.name AS spieler, mp.rounds AS runden, mp.won AS gewonnen, mp.n180 AS n180,
              (SELECT group_concat(punkte, ' ')
                 FROM (SELECT punkte FROM turns WHERE match_player_id = mp.id ORDER BY rundennummer)) AS aufnahmen
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         JOIN game_modes gm ON gm.id = m.game_mode_id
         JOIN users u ON u.id = mp.user_id
        ORDER BY m.datum, m.id, mp.won DESC, u.name`
    )
    .all();
}

module.exports = {
  getMatch,
  canEdit,
  createMatch,
  updateMatch,
  deleteMatch,
  listMatches,
  exportRows,
  EDIT_WINDOW_MIN,
};
