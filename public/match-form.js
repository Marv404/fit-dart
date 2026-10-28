// Formular «Spiel erfassen»:
// 1. Aufnahmen-Rechner pro Spieler: geworfene Punkte eingeben, Rest und Runden werden mitgezählt.
//    Das Feld «Aufnahmen» bleibt die Quelle der Wahrheit, der Rechner liest und schreibt es.
// 2. Sieger automatisch wählen: wer die wenigsten Runden hat, bei Gleichstand alle mit gleicher Rundenzahl.
//    Sobald jemand die Sieger selbst anklickt (oder beim Ändern schon welche gesetzt sind), greift die Automatik nicht mehr.
(function () {
  var rows = document.getElementById('rows');
  var modeSel = document.querySelector('select[name=game_mode_id]');
  if (!rows || !modeSel) return;
  var manual = !!rows.querySelector('input[name=winner]:checked');

  // wie in services/validate.js
  var IMPOSSIBLE = [163, 166, 169, 172, 173, 175, 176, 178, 179];
  var BOGEY = [159, 162, 163, 165, 166, 168, 169];

  function mode() {
    var o = modeSel.options[modeSel.selectedIndex];
    return { start: parseInt(o && o.dataset.start, 10) || 501, dout: !!o && o.dataset.dout === '1' };
  }

  function validFinish(points, dout) {
    if (!dout) return points >= 1 && points <= 180;
    return points >= 2 && points <= 170 && BOGEY.indexOf(points) < 0;
  }

  function q(row, sel) { return row.querySelector(sel); }

  function readTurns(row) {
    var tokens = q(row, 'input[name=turns]').value.split(/[\s,;]+/).filter(Boolean);
    var list = tokens.map(Number);
    var bad = list.some(function (n) { return !isFinite(n) || n < 0 || n > 180 || n % 1 !== 0; });
    var sum = bad ? 0 : list.reduce(function (a, b) { return a + b; }, 0);
    var start = mode().start;
    return { list: list, bad: bad, sum: sum, rest: start - sum, done: !bad && list.length > 0 && sum === start };
  }

  // 180er automatisch aus den Aufnahmen zählen (das Feld «180er» muss dazu passen)
  function syncN180(row) {
    var s = readTurns(row);
    if (s.bad) return;
    var n = s.list.filter(function (p) { return p === 180; }).length;
    q(row, 'input[name=n180]').value = n ? String(n) : '';
  }

  function writeTurns(row, list) {
    var s = list.reduce(function (a, b) { return a + b; }, 0);
    var turns = q(row, 'input[name=turns]');
    var rounds = q(row, 'input[name=rounds]');
    turns.value = list.join(' ');
    // Runden stehen erst fest, wenn der Spieler fertig ist
    rounds.value = list.length && s === mode().start ? String(list.length) : '';
    syncN180(row);
    turns.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function render(row, msg) {
    var calc = q(row, '[data-calc]');
    if (!calc) return;
    calc.hidden = false;
    var s = readTurns(row);
    var input = q(calc, '.calc-in');
    var add = q(calc, '.calc-add');
    var status = q(calc, '[data-status]');
    var locked = s.done || s.bad || s.rest < 0;
    input.disabled = add.disabled = locked;
    q(calc, '.calc-undo').disabled = !s.list.length || s.bad;
    if (s.bad) status.textContent = 'Aufnahmen-Feld prüfen';
    else if (s.rest < 0) status.textContent = 'Mehr als ' + mode().start + ' Punkte';
    else if (s.done) status.textContent = '✓ Fertig in ' + s.list.length + ' Runden';
    else status.textContent = 'Rest ' + s.rest + ' · Runde ' + (s.list.length + 1);
    q(calc, '[data-msg]').textContent = msg || '';
  }

  function renderAll() {
    rows.querySelectorAll('.player-row').forEach(function (row) { render(row); });
  }

  function addTurn(row) {
    var input = q(row, '.calc-in');
    var raw = input.value.trim();
    if (!/^\d{1,3}$/.test(raw) || parseInt(raw, 10) > 180) return render(row, 'Bitte 0 bis 180 eingeben.');
    var p = parseInt(raw, 10);
    if (IMPOSSIBLE.indexOf(p) >= 0) return render(row, p + ' ist mit drei Darts nicht möglich.');
    var s = readTurns(row);
    var m = mode();
    var left = s.rest - p;
    var msg = '';
    if (left < 0 || (m.dout && left === 1) || (left === 0 && !validFinish(p, m.dout))) {
      msg = p + ' ist überworfen – zählt als 0.';
      p = 0;
    }
    writeTurns(row, s.list.concat(p));
    input.value = '';
    render(row, msg);
    if (!input.disabled) input.focus();
  }

  function undoTurn(row) {
    var s = readTurns(row);
    if (s.bad || !s.list.length) return;
    writeTurns(row, s.list.slice(0, -1));
    render(row);
    q(row, '.calc-in').focus();
  }

  // Rundenzahl einer Zeile: eingetragene Runden, sonst Aufnahmen (nur wenn der Spieler fertig ist)
  function roundsOf(row) {
    var r = parseInt(q(row, 'input[name=rounds]').value, 10);
    if (r > 0) return r;
    var s = readTurns(row);
    return s.done ? s.list.length : null;
  }

  function pick() {
    if (manual) return;
    var best = null;
    var winners = [];
    rows.querySelectorAll('.player-row').forEach(function (row) {
      var r = roundsOf(row);
      if (!r || !q(row, 'select[name=user_id]').value) return;
      if (best === null || r < best) { best = r; winners = [row]; }
      else if (r === best) winners.push(row);
    });
    rows.querySelectorAll('.player-row').forEach(function (row) {
      q(row, 'input[name=winner]').checked = winners.indexOf(row) >= 0;
    });
  }

  rows.addEventListener('click', function (e) {
    var row = e.target.closest('.player-row');
    if (!row) return;
    if (e.target.closest('.calc-add')) addTurn(row);
    else if (e.target.closest('.calc-undo')) undoTurn(row);
  });

  rows.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.classList.contains('calc-in')) {
      e.preventDefault(); // nicht das ganze Formular abschicken
      addTurn(e.target.closest('.player-row'));
    }
  });

  rows.addEventListener('change', function (e) {
    if (e.target.name === 'winner') { manual = true; return; }
    pick();
  });

  rows.addEventListener('input', function (e) {
    if (e.target.name === 'rounds' || e.target.name === 'turns') {
      if (e.target.name === 'turns') {
        var row = e.target.closest('.player-row');
        if (e.target.value.trim()) syncN180(row); // ohne Aufnahmen bleibt die manuelle Eingabe
        render(row);
      }
      pick();
    }
  });

  modeSel.addEventListener('change', function () { renderAll(); pick(); });
  document.body.addEventListener('htmx:afterSwap', renderAll);

  renderAll();
})();
