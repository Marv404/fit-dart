'use strict';

const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Mit drei Darts nicht erreichbare Aufnahme-Summen
const IMPOSSIBLE_VISITS = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);
// Nicht auscheckbare Restwerte bei Double Out
const BOGEY_FINISHES = new Set([159, 162, 163, 165, 166, 168, 169]);

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "60 100, 140;180" -> { list: [60, 100, 140, 180] } oder { error } */
function parseTurns(raw) {
  const tokens = String(raw).split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { error: 'Keine Aufnahmen erkannt.' };
  if (tokens.length > 99) return { error: 'Maximal 99 Aufnahmen.' };
  const list = [];
  for (const t of tokens) {
    if (!/^\d{1,3}$/.test(t)) return { error: `"${t}" ist keine gültige Aufnahme.` };
    const n = Number.parseInt(t, 10);
    if (n > 180) return { error: `${n} ist zu hoch (maximal 180 pro Aufnahme).` };
    if (IMPOSSIBLE_VISITS.has(n)) return { error: `${n} ist mit drei Darts nicht möglich.` };
    list.push(n);
  }
  return { list };
}

/** Ist `points` als letzte Aufnahme ein gültiges Finish? */
function isValidFinish(points, doubleOut) {
  if (!doubleOut) return points >= 1 && points <= 180;
  return points >= 2 && points <= 170 && !BOGEY_FINISHES.has(points);
}

/**
 * Prüft das Formular "Spiel erfassen/ändern".
 * Formfelder: datum, game_mode_id, user_id[], rounds[], turns[] (optional), n180[] (optional), winner (Zeilenindex).
 * Leere Zeilen (kein Spieler gewählt) werden ignoriert.
 * Sind Aufnahmen angegeben, darf `rounds` leer sein (wird aus der Anzahl abgeleitet).
 */
function validateMatch(body, db, { allowInactiveModeId = null } = {}) {
  const errors = [];

  const datum = String(body.datum || '').trim();
  if (!isValidDate(datum)) errors.push('Datum ist ungültig.');
  else if (datum > todayISO()) errors.push('Das Datum darf nicht in der Zukunft liegen.');

  const modeId = Number.parseInt(body.game_mode_id, 10);
  const mode = Number.isInteger(modeId)
    ? db.prepare('SELECT id, aktiv, start_score, double_out FROM game_modes WHERE id = ?').get(modeId)
    : null;
  if (!mode) errors.push('Spielmodus ist ungültig.');
  else if (!mode.aktiv && mode.id !== allowInactiveModeId) errors.push('Der Spielmodus ist deaktiviert.');

  const userIds = toArray(body.user_id);
  const rounds = toArray(body.rounds);
  const turnsRaw = toArray(body.turns);
  const n180Raw = toArray(body.n180);
  const winnerIdx = Number.parseInt(body.winner, 10);

  const players = [];
  const seen = new Set();
  const getUser = db.prepare('SELECT id, aktiv FROM users WHERE id = ?');

  userIds.forEach((raw, idx) => {
    const s = String(raw).trim();
    if (s === '') return; // leere Zeile

    const row = `Zeile ${idx + 1}`;
    const uid = Number.parseInt(s, 10);
    const user = Number.isInteger(uid) ? getUser.get(uid) : null;
    if (!user) {
      errors.push(`${row}: Spieler ist ungültig.`);
      return;
    }
    if (seen.has(uid)) {
      errors.push(`${row}: Spieler ist doppelt aufgeführt.`);
      return;
    }
    seen.add(uid);

    let turns = null;
    const tRaw = String(turnsRaw[idx] ?? '').trim();
    if (tRaw !== '') {
      const parsed = parseTurns(tRaw);
      if (parsed.error) {
        errors.push(`${row}: ${parsed.error}`);
        return;
      }
      turns = parsed.list;
    }

    const r = String(rounds[idx] ?? '').trim();
    const n = r === '' && turns ? turns.length : /^\d+$/.test(r) ? Number.parseInt(r, 10) : Number.NaN;
    if (!(n >= 1 && n <= 99)) {
      errors.push(`${row}: Runden müssen zwischen 1 und 99 liegen.`);
      return;
    }
    if (turns && turns.length !== n) {
      errors.push(`${row}: ${turns.length} Aufnahmen, aber ${n} Runden angegeben.`);
      return;
    }

    // 180er: aus den Aufnahmen berechnet, sonst direkt eingetragen (leer = 0)
    const c = String(n180Raw[idx] ?? '').trim();
    if (c !== '' && !/^\d{1,2}$/.test(c)) {
      errors.push(`${row}: 180er müssen eine Zahl von 0 bis 99 sein.`);
      return;
    }
    let n180 = c === '' ? 0 : Number.parseInt(c, 10);
    if (turns) {
      const fromTurns = turns.filter((t) => t === 180).length;
      if (c !== '' && n180 !== fromTurns) {
        errors.push(`${row}: ${fromTurns}× 180 in den Aufnahmen, aber ${n180} bei «180er» angegeben.`);
        return;
      }
      n180 = fromTurns;
    }
    if (n180 > n) {
      errors.push(`${row}: Mehr 180er (${n180}) als Runden (${n}).`);
      return;
    }

    players.push({ idx, user_id: uid, rounds: n, won: idx === winnerIdx ? 1 : 0, turns, n180 });
  });

  if (players.length < 2) errors.push('Mindestens zwei Spieler sind nötig.');
  if (!players.some((p) => p.won)) errors.push('Es muss genau ein Gewinner gewählt sein.');

  // Aufnahmen gegen den Spielmodus prüfen
  if (mode) {
    for (const p of players) {
      if (!p.turns) continue;
      const row = `Zeile ${p.idx + 1}`;
      const sum = p.turns.reduce((a, b) => a + b, 0);
      const last = p.turns[p.turns.length - 1];
      if (sum > mode.start_score) {
        errors.push(`${row}: Die Aufnahmen ergeben ${sum} Punkte, mehr als ${mode.start_score}.`);
      } else if (p.won) {
        if (sum !== mode.start_score) {
          errors.push(`${row}: Der Sieger muss genau ${mode.start_score} Punkte erreichen (jetzt ${sum}).`);
        } else if (!isValidFinish(last, mode.double_out)) {
          errors.push(`${row}: ${last} ist als letzte Aufnahme kein gültiges Finish.`);
        }
      } else if (sum === mode.start_score) {
        errors.push(`${row}: Dieser Spieler hat ${mode.start_score} erreicht, ist aber nicht als Sieger gewählt.`);
      }
    }
  }

  return {
    errors,
    data: {
      datum,
      game_mode_id: mode ? mode.id : null,
      players,
    },
  };
}

function validateNewUser({ name, password, role }) {
  const errors = [];
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 30) errors.push('Name muss 2 bis 30 Zeichen lang sein.');
  if (String(password || '').length < 10) errors.push('Passwort muss mindestens 10 Zeichen haben.');
  if (!['admin', 'player'].includes(role)) errors.push('Rolle ist ungültig.');
  return { errors, name: n };
}

function validateMode(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const start = Number.parseInt(body.start_score, 10);
  if (name.length < 2 || name.length > 40) errors.push('Name muss 2 bis 40 Zeichen lang sein.');
  if (!Number.isInteger(start) || start < 1 || start > 1001) errors.push('Startscore muss zwischen 1 und 1001 liegen.');
  return {
    errors,
    data: {
      name,
      start_score: start,
      double_in: body.double_in ? 1 : 0,
      double_out: body.double_out ? 1 : 0,
    },
  };
}

module.exports = {
  validateMatch,
  validateNewUser,
  validateMode,
  parseTurns,
  isValidFinish,
  todayISO,
  isValidDate,
  toArray,
};
