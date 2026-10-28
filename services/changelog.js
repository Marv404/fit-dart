'use strict';

// Neueste Version zuerst. Bei einem Release hier oben einen Eintrag ergänzen
// und `version` in package.json auf dieselbe Nummer setzen.
const CHANGELOG = [
  {
    version: '1.1.0',
    datum: '2026-10-28',
    neu: [
      'Aufnahmen-Rechner in jedem Spielmodus: pro Spieler die geworfenen Punkte eingeben, Rest und Runden werden mitgezählt.',
      'Überworfen und ungültige Finishes zählen automatisch als 0, unmögliche Aufnahmen (z. B. 179) werden abgelehnt.',
      'Ist ein Spieler auf 0, stehen seine Runden fest und die Sieger werden automatisch gesetzt.',
      'Das Feld «180er» zählt automatisch mit, sobald eine 180 eingegeben wird.',
      'Statistik: Ø Punkte pro Wurf, Ø der ersten 3 Aufnahmen, beste Aufnahme sowie Aufnahmen mit 60+, 100+ und 140+.',
      'Changelog-Seite und Versionsanzeige.',
    ],
    geaendert: [
      'Bei gleicher Rundenzahl gibt es mehrere Sieger. Das Sieger-Feld ist jetzt eine Checkbox statt eines Radio-Buttons.',
      'In der Tabelle «Alle Spieler» gibt es zusätzlich die Spalte «Ø pro Wurf».',
    ],
  },
  {
    version: '1.0.0',
    datum: null,
    neu: [
      'Spiele erfassen mit Modus, Datum, 2 bis 8 Spielern und Runden.',
      'Optionale Aufnahmen pro Spieler mit Average, 180ern und höchstem Finish.',
      'Spielverlauf mit Filter, Rangliste pro Modus, Statistik und Admin-Bereich.',
    ],
    geaendert: [],
  },
];

module.exports = { CHANGELOG };
