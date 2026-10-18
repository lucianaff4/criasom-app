/* Repertório: cálculo de capotraste sem inferir o tom de uma gravação. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RepertorioEngine = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SUFFIXES = {
    '': 'major', maj: 'major', m: 'minor', '7': '7', m7: 'm7',
    maj7: 'maj7', '7M': 'maj7', sus2: 'sus2', sus4: 'sus4',
    add9: 'add9', '9': '9', dim: 'dim', aug: 'aug', m7b5: 'm7b5'
  };

  function modulo(n) { return ((n % 12) + 12) % 12; }
  function normalize(text) { return text.replace(/♯/g, '#').replace(/♭/g, 'b').trim(); }
  function pitch(note) {
    return modulo(NATURAL[note[0]] + (note[1] === '#' ? 1 : note[1] === 'b' ? -1 : 0));
  }
  function chordKey(rootPc, quality, bassPc) {
    return rootPc + ':' + quality + ':' + (bassPc === null ? '-' : bassPc);
  }

  /** Parse explícito. Símbolos fora do contrato provocam Error; nenhum acorde é descartado. */
  function parseChord(value) {
    if (typeof value !== 'string') throw new Error('Cada acorde deve ser um texto.');
    var text = normalize(value);
    var parts = /^([A-G](?:#|b)?)([^/]*)(?:\/([A-G](?:#|b)?))?$/.exec(text);
    if (!parts || !Object.prototype.hasOwnProperty.call(SUFFIXES, parts[2])) {
      throw new Error('Acorde não reconhecido: “' + value + '”. Use um símbolo suportado, sem omitir seus acordes difíceis.');
    }
    var rootPc = pitch(parts[1]);
    var bassPc = parts[3] ? pitch(parts[3]) : null;
    var quality = SUFFIXES[parts[2]];
    return {
      text: text, root: parts[1], rootPc: rootPc,
      suffix: parts[2], quality: quality,
      bass: parts[3] || null, bassPc: bassPc,
      key: chordKey(rootPc, quality, bassPc)
    };
  }

  function transposeParsed(chord, semitones) {
    return NOTES[modulo(chord.rootPc + semitones)] + chord.suffix +
      (chord.bassPc === null ? '' : '/' + NOTES[modulo(chord.bassPc + semitones)]);
  }

  /** Transpõe fundamental e baixo pelo mesmo número inteiro de semitons. Saída usa sustenidos. */
  function transposeChord(value, semitones) {
    if (!Number.isInteger(semitones)) throw new Error('A transposição deve usar semitons inteiros.');
    return transposeParsed(parseChord(value), semitones);
  }

  function emptyResult(errors) {
    return {
      schemaVersion: 1, valid: false, compatible: false,
      errors: errors, originalChords: [], originals: [], allowedShapes: [],
      solutions: [], bestOptions: [], options: [], missingShapes: []
    };
  }

  /**
   * analyze(chordString, allowedShapes, maxCapo = 7)
   * chordString: acordes separados por espaços, vírgulas, ponto e vírgula ou |.
   * allowedShapes: símbolos completos que o aluno sabe tocar, incluindo baixos invertidos.
   * Cada opção transpõe TODOS os acordes por -capo; o capotraste repõe +capo.
   * score é somente o custo da casa: menor é preferível entre soluções completas.
   * Não verifica gravação, afinação, tonalidade original, digitação ou nível pedagógico.
   */
  function analyze(chordString, allowedShapes, maxCapo) {
    if (maxCapo === undefined) maxCapo = 7;
    var errors = [];
    if (typeof chordString !== 'string' || !chordString.trim()) {
      errors.push('Informe pelo menos um acorde.');
    }
    if (!Array.isArray(allowedShapes)) errors.push('Informe os shapes como uma lista de acordes.');
    if (!Number.isInteger(maxCapo) || maxCapo < 0 || maxCapo > 11) {
      errors.push('A casa máxima do capotraste deve ser um inteiro entre 0 e 11.');
    }
    if (errors.length) return emptyResult(errors);

    var tokens = chordString.trim().split(/[\s,;|]+/).filter(Boolean);
    if (!tokens.length) return emptyResult(['Informe pelo menos um acorde.']);
    var originals = [];
    var shapes = [];
    tokens.forEach(function (token, i) {
      try { originals.push(parseChord(token)); }
      catch (error) { errors.push('Acorde ' + (i + 1) + ': ' + error.message); }
    });
    allowedShapes.forEach(function (shape, i) {
      try { shapes.push(parseChord(shape)); }
      catch (error) { errors.push('Shape ' + (i + 1) + ': ' + error.message); }
    });
    if (errors.length) return emptyResult(errors);

    var allowed = new Set(shapes.map(function (shape) { return shape.key; }));
    var options = [];
    for (var capo = 0; capo <= maxCapo; capo += 1) {
      var moved = originals.map(function (chord) { return parseChord(transposeParsed(chord, -capo)); });
      var seenMissing = new Set();
      var missing = moved.filter(function (chord) {
        if (allowed.has(chord.key) || seenMissing.has(chord.key)) return false;
        seenMissing.add(chord.key);
        return true;
      }).map(function (chord) { return chord.text; });
      options.push({
        capo: capo, score: capo, compatible: missing.length === 0,
        shapes: moved.map(function (chord) { return chord.text; }),
        soundingChords: moved.map(function (chord) { return transposeParsed(chord, capo); }),
        missingShapes: missing
      });
    }
    var solutions = options.filter(function (option) { return option.compatible; });
    var ranked = options.slice().sort(function (a, b) {
      return a.missingShapes.length - b.missingShapes.length || a.score - b.score;
    });
    var bestOptions = ranked.slice(0, 3);
    return {
      schemaVersion: 1, valid: true, compatible: solutions.length > 0, errors: [],
      originalChords: originals.map(function (chord) { return chord.text; }),
      originals: originals, allowedShapes: shapes.map(function (shape) { return shape.text; }),
      maxCapo: maxCapo, solutions: solutions, bestOptions: bestOptions, options: options,
      missingShapes: solutions.length ? [] : bestOptions[0].missingShapes.slice()
    };
  }

  return Object.freeze({ analyze: analyze, parseChord: parseChord, transposeChord: transposeChord });
});
