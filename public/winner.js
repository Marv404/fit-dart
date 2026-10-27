// Sieger automatisch wählen: wer die wenigsten Runden hat (bei Gleichstand bleibt die Wahl offen).
// Sobald jemand den Sieger selbst anklickt (oder beim Ändern schon einer gesetzt ist), greift die Automatik nicht mehr.
(function () {
  var rows = document.getElementById('rows');
  if (!rows) return;
  var manual = !!rows.querySelector('input[name=winner]:checked');

  function roundsOf(row) {
    var r = parseInt(row.querySelector('input[name=rounds]').value, 10);
    if (r > 0) return r;
    var t = row.querySelector('input[name=turns]').value.split(/[\s,;]+/).filter(Boolean);
    return t.length || null;
  }

  function pick() {
    if (manual) return;
    var best = null;
    var tie = false;
    rows.querySelectorAll('.player-row').forEach(function (row) {
      var r = roundsOf(row);
      if (!r || !row.querySelector('select[name=user_id]').value) return;
      if (best === null || r < best.r) { best = { r: r, row: row }; tie = false; }
      else if (r === best.r) tie = true;
    });
    if (best && !tie) best.row.querySelector('input[name=winner]').checked = true;
  }

  rows.addEventListener('change', function (e) {
    if (e.target.name === 'winner') { manual = true; return; }
    pick();
  });
  rows.addEventListener('input', function (e) {
    if (e.target.name === 'rounds' || e.target.name === 'turns') pick();
  });
})();
