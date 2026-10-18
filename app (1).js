(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'criasom.repertorio.v1';
  const BASIC = ['C', 'D', 'Dm', 'E', 'Em', 'G', 'A', 'Am'];
  const BARRE = ['F', 'Bm', 'B', 'Bb', 'Cm', 'Fm', 'F#', 'F#m', 'C#', 'C#m', 'Eb', 'Ebm', 'Ab', 'Abm', 'Gm', 'Bbm'];
  const NAMES = {C:'Dó maior',D:'Ré maior',Dm:'Ré menor',E:'Mi maior',Em:'Mi menor',G:'Sol maior',A:'Lá maior',Am:'Lá menor',F:'Fá maior',Bm:'Si menor',B:'Si maior',Bb:'Si bemol',Cm:'Dó menor',Fm:'Fá menor','F#':'Fá sustenido','F#m':'Fá sustenido menor','C#':'Dó sustenido','C#m':'Dó sustenido menor',Eb:'Mi bemol',Ebm:'Mi bemol menor',Ab:'Lá bemol',Abm:'Lá bemol menor',Gm:'Sol menor',Bbm:'Si bemol menor'};
  const data = Array.isArray(window.CURADORIA) ? window.CURADORIA : [];
  const ids = new Set(data.map(s => s.id));
  const normalize = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const escape = (text) => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (_) {}
  const knownIds = new Set([...ids,...(window.REPERTORIO_ARCHIVED_IDS || [])]);
  function sharedTheme() { try { return window.REPERTORIO_HOST ? localStorage.getItem('criasom.ui.theme') : null; } catch (_) { return null; } }
  const favorites = new Set((Array.isArray(persisted.favorites) ? persisted.favorites : []).filter(id => knownIds.has(id)));
  const selected = new Set(BASIC);
  const calculatorShapes = new Set(BASIC);
  let level = 'open';
  let openSelection = new Set(BASIC);
  let showCurated = false;
  let view = 'library';
  let theme = (sharedTheme() || persisted.theme) === 'dark' ? 'dark' : 'light';
  let toastTimer;
  let calculatorUsed = false;
  let usingExample = false;
  const PAGE_SIZE = 24;
  let visibleMain = PAGE_SIZE, visibleOther = PAGE_SIZE, lastFilterKey = '';
  let arrangementCacheKey = '', arrangementCache = new Map();

  function announce(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.add('show');
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3300);
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({version:1, favorites:[...favorites], theme}));
      return true;
    } catch (_) { announce('A seleção vale nesta sessão. Este navegador não permitiu salvar.'); return false; }
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    if (window.REPERTORIO_HOST) try { localStorage.setItem('criasom.ui.theme',theme); } catch (_) {}
    $('theme-toggle').textContent = theme === 'dark' ? '☀' : '☾';
    $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro');
  }
  function chordButtons(container, chords, selection, change) {
    $(container).replaceChildren(...chords.map(chord => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chord-chip';
      button.dataset.chord = chord;
      button.setAttribute('aria-pressed', String(selection.has(chord)));
      button.setAttribute('aria-label', chord + ', ' + NAMES[chord]);
      button.innerHTML = '<span class="chord-check" aria-hidden="true">✓</span><b>' + escape(chord) + '</b><small>' + escape(NAMES[chord]) + '</small>';
      button.addEventListener('click', () => {
        selection.has(chord) ? selection.delete(chord) : selection.add(chord);
        button.setAttribute('aria-pressed', String(selection.has(chord)));
        change();
      });
      return button;
    }));
  }
  function syncChords(prefix, selection) {
    [prefix + '-chords', prefix + '-barre-chords'].forEach(id => {
      $(id)?.querySelectorAll('[data-chord]').forEach(button => button.setAttribute('aria-pressed', String(selection.has(button.dataset.chord))));
    });
  }
  function updateSelection() {
    $('selection-count').textContent = selected.size + (selected.size === 1 ? ' acorde marcado' : ' acordes marcados');
    $('clear-chords').disabled = selected.size === 0;
    $('select-basic').disabled = BASIC.every(chord => selected.has(chord));
    renderLibrary();
  }
  function syncLevelView() {
    const free = view === 'library' && level === 'barre';
    $('free-search').hidden = !free;
    $('basic-picker').hidden = view !== 'library' || level === 'barre';
    $('local-search').hidden = free && !showCurated;
    $('results').hidden = free && !showCurated;
    $('show-curated').setAttribute('aria-expanded', String(showCurated));
    $('show-curated').querySelector('.curated-toggle-icon').textContent = showCurated ? '−' : '+';
    $('show-curated').querySelector('span').textContent = showCurated ? 'Fechar seleção do curso' : 'Ver também a seleção do curso';
    $('local-search').querySelector('.step-number').textContent = level === 'barre' ? '＋' : '3';
    $('search-heading').textContent = level === 'barre' ? 'Na seleção do curso' : 'O que você quer tocar?';
    $('find-songs').querySelector('span').textContent = level === 'barre' ? 'Buscar na seleção do curso' : 'Encontrar minhas músicas';
    document.querySelector('.help-strip').hidden = view !== 'library' || level === 'barre';
  }
  function chooseLevel(next) {
    const newLevel = next === 'barre' ? 'barre' : 'open';
    if (newLevel !== level) {
      if (newLevel === 'barre') openSelection = new Set(selected);
      selected.clear();
      (newLevel === 'barre' ? [...BASIC,...BARRE] : [...openSelection]).forEach(chord => selected.add(chord));
      showCurated = false;
    }
    level = newLevel;
    document.querySelectorAll('[data-level]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.level === level)));
    syncChords('library', selected);
    syncLevelView();
    updateSelection();
  }
  function key(chord) {
    try { return window.RepertorioEngine.parseChord(chord).key; } catch (_) { return chord; }
  }
  function shapesAsSelected(option, selection) {
    const labels = new Map([...selection].map(chord => [key(chord),chord]));
    return {...option,shapes:option.shapes.map(chord => labels.get(key(chord)) || chord)};
  }
  function currentRecordingReview(review) {
    return review?.recordingReviewV11 || review?.recordingReviewV10 || review?.recordingReviewV9;
  }
  function beginnerRecordingRestriction(song) {
    const checked = currentRecordingReview(song.expansionReview);
    if (level !== 'open' || !checked) return null;
    if (checked.status === 'extra_tuning') return 'Esta gravação pede outra afinação. Escolha outra música para tocar junto.';
    if (checked.status === 'standard_not_supported') return 'Ainda não confirmamos o encaixe com esta gravação na afinação normal. Escolha outra música para tocar junto.';
    return null;
  }
  function calculatedArrangement(song, selection) {
    const selectionKey = level + '|' + [...selection].sort().join('|');
    if (selectionKey !== arrangementCacheKey) { arrangementCacheKey = selectionKey; arrangementCache = new Map(); }
    if (arrangementCache.has(song.id)) return arrangementCache.get(song.id);
    if (beginnerRecordingRestriction(song)) { arrangementCache.set(song.id,null); return null; }
    const review = song.expansionReview;
    if (song.barreAudit?.status !== 'verified' || !review || review.inventoryComplete !== true || !['notation_checked','study_checked'].includes(review.status) || !selection.size) return null;
    if (!review.adaptedSoundingChords?.length || review.adaptedSoundingChords.length !== review.referenceDisplayedChords?.length) return null;
    const exception = review.capoException?.maxCapo;
    const maxCapo = [8,9].includes(exception) ? exception : 7;
    const audioReview = currentRecordingReview(review);
    const requiredSounds = [...review.adaptedSoundingChords,...(audioReview?.additionalSoundingChords || [])];
    const result = window.RepertorioEngine.analyze(requiredSounds.join(' '),[...selection],maxCapo);
    const basicKeys = new Set(BASIC.map(key));
    const difficulty = option => new Set(option.shapes.filter(c => !basicKeys.has(key(c)))).size * 100 + option.capo;
    const solutions = result.solutions.filter(option=>audioReview?.requiredCapo == null || option.capo===audioReview.requiredCapo).sort((a,b) => difficulty(a) - difficulty(b));
    const arrangement = result.valid && solutions.length ? shapesAsSelected(solutions[0],selection) : null;
    arrangementCache.set(song.id,arrangement);
    return arrangement;
  }
  // A dica histórica isolada nunca prova o acompanhamento completo.
  function classify(song, selection) {
    if (song.barreAudit?.status !== 'verified') return 'unverified';
    return calculatedArrangement(song,selection) ? 'computed' : 'excluded';
  }
  function matchingRows(query, group, onlyFavorites) {
    const q = normalize(query.trim());
    return data.filter(song => {
      if (onlyFavorites && !favorites.has(song.id)) return false;
      if (group && song.group !== group) return false;
      const terms = [song.title, song.artist, ...(song.aliases || [])].join(' ');
      return !q || normalize(terms).includes(q);
    }).sort((a,b) => Number(Boolean(b.expansionReview)) - Number(Boolean(a.expansionReview)));
  }
  function countSongs(rows) {
    return new Set(rows.map(s => normalize(s.title + '|' + s.artist))).size;
  }
  function partitionRows(rows, selection, onlyFavorites) {
    if (onlyFavorites) return {main:rows,other:[]};
    const main = [], other = [];
    rows.forEach(song => {
      (classify(song,selection) === 'computed' ? main : other).push(song);
    });
    return {main,other};
  }
  function safeCifra(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && /^(www\.)?cifraclub\.com(\.br)?$/.test(parsed.hostname)) return url;
    } catch (_) {}
    return null;
  }
  function uiIcon(name) {
    const paths = {
      capo:'<path d="M5 5v14M9 5v14M13 5v14M17 5v14M4 9h14M4 15h14"/><path d="M3 11h16v3H3zM19 12h2v7"/>',
      check:'<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/>',
      swap:'<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
      arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
      audio:'<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12h3v8H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 1-2Zm16 0h-3v8h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-1-2Z"/>',
      bookmark:'<path d="M6 3h12v18l-6-4-6 4Z"/>',
      music:'<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
      clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      info:'<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6.5v.5"/>',
      external:'<path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/>',
      plus:'<path d="M12 5v14M5 12h14"/>'
    };
    return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">'+(paths[name]||paths.info)+'</svg>';
  }
  function recordingLink(review) {
    const url = review?.recordingCheck?.recordingUrl;
    try { const u=new URL(url); return u.protocol==='https:' && ['www.youtube.com','youtube.com','youtu.be'].includes(u.hostname) ? u.href : null; } catch (_) { return null; }
  }
  function shortChange(change) {
    if (changesTriad(change)) return 'Muda o acorde nesta passagem. Mantenha o tempo.';
    if (change.from?.includes('/')) return 'Mantém o acorde com um baixo mais simples.';
    if (/7/.test(change.from || '')) return 'Tira a sétima para facilitar.';
    return 'Usa o acorde simples nesta passagem.';
  }
  function changesTriad(change) {
    const from = /^([A-G][#b]?)(m(?!aj))?/.exec(change.from || '');
    const to = /^([A-G][#b]?)(m(?!aj))?/.exec(change.to || '');
    return !!(from && to && (from[1] !== to[1] || from[2] !== to[2]));
  }
  function controlInstructions(review) {
    const events = review?.controlEvents || [];
    let html = '';
    for (const kind of ['no_chord','hold']) {
      const group = events.filter(e=>e.kind===kind);
      if (!group.length) continue;
      const markers = [...new Set(group.map(e=>e.marker).filter(Boolean))];
      const label = kind==='no_chord' ? 'Pausa: não toque.' : 'Sustente o último acorde.';
      html += '<p class="section-note">'+uiIcon('clock')+'<span><strong>'+label+'</strong> Quando a cifra indicar '+escape(markers.join(' / '))+'.</span></p>';
    }
    return html;
  }
  function recordingInstructions(review, arrangement) {
    const checked = currentRecordingReview(review);
    if (!checked) return '';
    const notes = (checked.studentEvents || []).map(event => {
      const sounds = event.sequenceSounding || (event.soundingChord ? [event.soundingChord] : []);
      const position = sounds.map(chord=>window.RepertorioEngine.transposeChord(chord,-arrangement.capo)).join(' → ');
      const times=event.times?.length?'<small style="display:block">Na gravação, aproximadamente: '+event.times.map(t=>Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0')).join(' · ')+'.</small>':'';
      return '<p class="section-note">'+uiIcon(sounds.length?'swap':'clock')+'<span><strong>'+escape(event.label)+'</strong> '+escape(event.instruction)+(position?' <b>'+escape(position)+'</b>.':'')+times+'</span></p>';
    }).join('');
    const tuning = checked.status === 'extra_tuning' ? '<p class="version-alert">'+uiIcon('info')+' Esta gravação precisa de ajuste fino de afinação. Só o capotraste não basta.</p>' : '';
    const pending=['pending','standard_not_supported'].includes(checked.status)?'<p class="version-alert">'+uiIcon('info')+' '+escape(checked.headline)+'</p>':'';
    return notes+tuning+pending;
  }
  function selectiveStringGuide(checked) {
    const event=checked?.selectiveStringEvent;
    if(!event)return '';
    const strings=[6,5,4,3,2,1].map(n=>'<span class="string-row'+(event.strings.includes(n)?' play-string':'')+'"><b>'+n+'</b><i></i><span>'+(event.strings.includes(n)?'Toque':'—')+'</span></span>').join('');
    return '<aside class="selective-guide"><strong>'+uiIcon('info')+' Neste trecho, toque só duas cordas</strong><p><b>'+escape(event.timeLabel)+'</b> · Segure o desenho de <b>'+escape(event.shape)+'</b> e toque juntas as cordas <b>3 e 2</b>, com dois dedos. Deixe as outras quietas.</p><div class="string-guide" role="img" aria-label="Toque somente as cordas 3, Sol, e 2, Si. Não toque as cordas 6, 5, 4 e 1.">'+strings+'</div><small>1 = corda mais fina. Nesta passagem, não faça a batida nas cordas todas.</small><p>Depois, volte à posição <b>'+escape(event.nextShape)+'</b> e siga o mapa.</p></aside>';
  }
  function renderCard(song) {
    const saved = favorites.has(song.id), review = song.expansionReview;
    const recordingRestriction = beginnerRecordingRestriction(song);
    const arrangement = calculatedArrangement(song,selected);
    const shownShapes = arrangement ? [...new Set(arrangement.shapes)] : [];
    const colors = ['#7145ce', '#1766c8', '#a24f12', '#197466', '#b33d78'];
    const index = [...(song.group || '')].reduce((sum,c)=>sum+c.charCodeAt(0),0)%colors.length;
    const changes = review?.modifications || review?.changes || [];
    const changedSymbols = new Set(changes.map(m=>m.from));
    const capo = arrangement ? '<div class="capo-tag capo-visual">'+uiIcon('capo')+'<div><small>CAPOTRASTE</small><strong>'+(arrangement.capo ? arrangement.capo+'ª casa' : 'Não precisa')+'</strong>'+(arrangement.capo>5?'<span class="high-capo-note">Casas mais apertadas</span>':'')+'</div></div>' : '';
    const badges = arrangement
      ? '<span class="badge level-badge">'+uiIcon('check')+(shownShapes.every(c=>BASIC.includes(c))?'Sem pestana':'Com outros acordes')+'</span>'
      : '<span class="badge warning">'+uiIcon(recordingRestriction?'audio':'clock')+(recordingRestriction?'Fora da seleção iniciante':song.barreAudit?.status==='verified'?'Faltam acordes na seleção':'Em revisão')+'</span>';
    const shapes = arrangement ? '<div class="card-shapes"><span>Você toca</span>'+shownShapes.map(c=>'<b>'+escape(c)+'</b>').join('')+'</div>' : '';
    let guidance = '';
    if (arrangement) {
      const entries = new Map();
      review.referenceDisplayedChords.forEach((chord,i)=>{
        const relevantChanges=changes.filter(m=>m.from===chord && (!m.mappingIndices || m.mappingIndices.includes(i)));
        const scopeNeeded = review.referenceDisplayedChords.some((c,j)=>c===chord && arrangement.shapes[j]!==arrangement.shapes[i]);
        const scope = scopeNeeded ? review.mappingScopes?.[i] || 'Confira a parte nos detalhes' : '';
        const entryKey = chord+'|'+arrangement.shapes[i]+'|'+scope;
        if (!entries.has(entryKey)) entries.set(entryKey,{chord,shape:arrangement.shapes[i],scope,changed:relevantChanges.length>0,triadChange:relevantChanges.some(changesTriad)});
      });
      const mapping = '<div class="arrangement-mapping"><div class="mapping-heading"><span class="guidance-label">Como tocar</span><strong>Na cifra → você toca</strong></div><div class="chord-swaps">'+[...entries.values()].map(e=>'<div class="chord-swap'+(e.changed?' is-adapted':'')+(e.scope?' has-scope':'')+(e.chord.length>=4||e.shape.length>2?' long-chord':'')+'"><div class="swap-pair"><b class="source-chord">'+escape(e.chord)+'</b>'+uiIcon('arrow')+'<span class="sr-only"> toque </span><b class="target-chord">'+escape(e.shape)+'</b></div>'+(e.changed?'<small class="swap-change">'+uiIcon('swap')+(e.triadChange?'Troca de acorde':'Simplificado')+'</small>':'')+(e.scope?'<small class="swap-scope">'+escape(e.scope)+'</small>':'')+'</div>').join('')+'</div></div>';
      const audioCheck = review.recordingCheck;
      const audioReview = currentRecordingReview(review);
      const audioLabels = {accompanies:'Acompanha esta gravação · análise do áudio',accompanies_with_picking:'Acompanha com duas cordas no trecho final · veja a instrução',extra_tuning:'Gravação fora da seleção iniciante · outra afinação',standard_not_supported:'Encaixe com a gravação não confirmado · fora da seleção iniciante',does_not_fit:'Este arranjo não acompanha a gravação',pending:'Gravação em revisão · ainda não liberada'};
      const pitchLabel = audioReview ? audioLabels[audioReview.status]
        : review.originalRecordingVerified
        ? 'Tom da gravação conferido'
        : audioCheck?.pitchStatus === 'automatic_pitch_estimate' ? 'Altura estimada · MP3 em revisão'
        : audioCheck?.completeAudioMeasured ? 'Medição incerta · MP3 em revisão'
        : review.studyConfiguration?.writtenPitchShiftSemitones ? 'Versão de estudo · tom alterado'
        : review.status==='study_checked' ? 'Tom com o áudio a conferir' : 'Tom da cifra mantido · MP3 a conferir';
      const pitch = '<p class="pitch-line'+(review.status==='study_checked'?' needs-check':'')+'">'+uiIcon('audio')+'<span>'+pitchLabel+'</span></p>';
      const modifications = changes.length ? '<p class="detail-label">Trocas já aplicadas no mapa</p><ul class="change-list">'+changes.map(m=>{
        const scope=m.scopes||m.where||m.scope;
        const positions=[...new Set(review.referenceDisplayedChords.flatMap((c,i)=>c===m.from&&(!m.mappingIndices||m.mappingIndices.includes(i))?[arrangement.shapes[i]]:[]))];
        return '<li><strong>'+escape(m.from)+' → '+escape(positions.join(' / ')||'Veja o mapa')+'</strong><span>'+escape(m.selectiveStrings?'Neste trecho, toque somente as cordas 3 e 2.':shortChange(m))+'</span>'+(scope?'<small>'+escape(Array.isArray(scope)?scope.join(' · '):scope)+'</small>':'')+'</li>';
      }).join('')+'</ul>' : '<p>'+uiIcon('check')+' Nenhuma substituição harmônica.</p>';
      let special = controlInstructions(review)+recordingInstructions(review,arrangement);
      if (['2-acordes-f1ace4c7b6d6','2-acordes-bd41f22a7ecf'].includes(song.id)) special+='<p class="version-alert">'+uiIcon('info')+' O tom no cabeçalho da fonte diverge dos acordes. Este mapa é para estudo.</p>';
      if (song.id==='estilos-int-your-man' && !review.controlEvents?.some(e=>e.kind==='no_chord')) special+='<p class="section-note">'+uiIcon('clock')+'<span><strong>N.C. = pausa.</strong> Não toque nesse trecho.</span></p>';
      const inferredSections = audioReview?.introInstructionReplacesInferred ? [] : (review.referenceSections || []).filter(s=>s.harmonyInferredFromTab);
      for (const section of inferredSections) {
        const shapes = [...new Set(section.chords.map(c=>arrangement.shapes[review.referenceDisplayedChords.indexOf(c)]).filter(Boolean))];
        special += '<p class="section-note">'+uiIcon('music')+'<span><strong>Intro simples:</strong> acompanhe com '+escape(shapes.join(' · '))+'.</span></p>';
      }
      if (song.id==='estilos-int-the-gambler') special+='<p class="version-alert">Este mapa é da versão que começa com D#7/G#. Se a cifra começar com D/G, ela é diferente: não use este mapa.</p>';
      if (song.id==='estilos-int-love-yourself-justin-bieber') special+='<p class="version-alert">Se aparecer B9 na cifra, use a linha B2 deste mapa.</p>';
      const inheritedNote = !audioReview && review.substitutionReviewV8?.inheritedDifferences ? '<p><strong>Versão simplificada:</strong> há outras mudanças em relação à cifra principal. O encaixe delas na gravação está em revisão.</p>' : '';
      const recordingDetail = audioCheck ? '<p><strong>Gravação:</strong> '+escape(audioCheck.recordingLabel || 'Veja o link para ouvir')+'</p><p>'+escape(audioCheck.studentNote || 'A análise de altura não confirma o encaixe de todas as simplificações.')+'</p>' : review.originalRecordingVerified ? '' : '<p>O áudio original ainda não foi validado.</p>';
      if (audioCheck?.pitchCorrectionSemitones) special+='<p class="section-note">'+uiIcon('audio')+'<span>Mapa ajustado para a gravação indicada abaixo.</span></p>';
      if (audioCheck?.fineTuningNeedsReview && audioReview?.status !== 'extra_tuning') special+='<p class="version-alert">'+uiIcon('info')+' Para este MP3, a afinação fina ainda precisa ser conferida.</p>';
      const reviewDetail = audioReview ? '<p><strong>Conferência do áudio:</strong> '+escape(audioReview.reason)+'</p><p>Análise computacional de passagens, voz e acompanhamento. Não houve escuta humana. Vale para a gravação deste link.</p>' : '';
      const details = '<details class="guide-details"><summary>'+uiIcon(changes.length?'swap':'info')+'<span>'+(changes.length?'Ver '+changes.length+(changes.length===1?' simplificação':' simplificações'):'Ver detalhes')+'</span>'+uiIcon('plus')+'</summary><div class="guide-detail-body">'+modifications+'<p><strong>Versão:</strong> '+escape(review.referenceVersion || 'Indicada no link')+'</p><p>Siga a ordem da cifra e os ajustes de passagem indicados acima.</p>'+recordingDetail+reviewDetail+inheritedNote+(arrangement.capo>5?'<p>Capotraste alto: as casas ficam mais apertadas.</p>':'')+'</div></details>';
      guidance = selectiveStringGuide(audioReview)+mapping+pitch+special+details;
    } else {
      const reason = recordingRestriction ? currentRecordingReview(review).reason : song.barreAudit?.reason || 'Adaptação completa em conferência.';
      guidance = '<div class="pending-guide">'+uiIcon(recordingRestriction?'audio':'clock')+'<p>'+escape(recordingRestriction || (song.barreAudit?.status==='verified'?'Marque mais acordes que você já sabe.':'Ainda sem uma versão completa para estes acordes.'))+'</p></div><details class="guide-details"><summary>'+uiIcon('info')+'<span>Entender o motivo</span>'+uiIcon('plus')+'</summary><div class="guide-detail-body"><p>'+escape(reason)+'</p></div></details>';
    }
    const referenceUrl = safeCifra(arrangement ? review.evidenceUrl || song.cifraUrl : song.cifraUrl);
    const url = referenceUrl && arrangement ? (()=>{const u=new URL(referenceUrl);u.hash='';return u.href;})() : referenceUrl;
    const link = url ? '<a class="cifra-link button primary" href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">'+uiIcon('music')+(arrangement?'Abrir no Cifra Club':'Ver cifra original')+uiIcon('external')+'<span class="sr-only"> — '+escape(song.title)+'</span></a>' : '<span class="link-pending">Link em conferência</span>';
    const linkNote = '<p class="link-reference-note compact-note">'+uiIcon('info')+'<span>'+(arrangement?'A cifra abre sem as trocas. Use o mapa acima.':'A cifra original pode exigir pestanas.')+'</span></p>';
    const audioUrl = recordingLink(review);
    const listen = audioUrl ? '<a class="recording-link" href="'+escape(audioUrl)+'" target="_blank" rel="noopener noreferrer">'+uiIcon('audio')+'Ouvir esta gravação'+uiIcon('external')+'</a>' : '';
    return '<article class="song-card" data-song-id="'+escape(song.id)+'" style="--card-accent:'+colors[index]+'"><div class="card-top"><span class="card-category">'+escape(song.group)+'</span></div><h3>'+escape(song.title)+'</h3><p class="artist">'+escape(song.artist)+'</p>'+capo+'<div class="card-badges">'+badges+'</div>'+shapes+'<div class="song-guidance visual-guidance">'+guidance+'</div><div class="card-actions">'+link+linkNote+listen+'<button type="button" class="favorite-button'+(saved?' saved':'')+'" data-favorite="'+escape(song.id)+'" aria-pressed="'+saved+'" aria-label="'+(saved?'Remover ':'Guardar ')+escape(song.title)+(saved?' do':' no')+' meu repertório">'+uiIcon(saved?'check':'bookmark')+(saved?'No meu repertório':'Guardar música')+'</button></div></article>';
  }

  function renderLibrary() {
    const isFavorites = view === 'favorites';
    const filterKey = [view,level,$('search').value,$('group-filter').value,[...selected].sort().join(','),isFavorites?[...favorites].join(','):''].join('|');
    if (filterKey !== lastFilterKey) { visibleMain = PAGE_SIZE; visibleOther = PAGE_SIZE; lastFilterKey = filterKey; }
    const rows = matchingRows($('search').value, $('group-filter').value, isFavorites);
    const fullBasics = BASIC.every(chord => selected.has(chord));
    const {main,other} = partitionRows(rows,selected,isFavorites);
    $('favorite-count').textContent = String([...favorites].filter(id => ids.has(id)).length);
    $('library-heading').textContent = isFavorites ? 'Seu repertório. Suas próximas músicas.' : fullBasics ? 'Escolha sua próxima música' : main.length ? 'Comece por estas músicas' : 'Explore o repertório';
    $('results-eyebrow').textContent = isFavorites ? 'SUAS MÚSICAS GUARDADAS' : level === 'barre' ? 'SELEÇÃO DO CURSO' : 'REPERTÓRIO PARA SEUS ACORDES';
    $('results-count').textContent = isFavorites ? countSongs(main) + ' músicas guardadas' : countSongs(main) + (level === 'barre' ? ' músicas na seleção · ' : ' músicas para seus acordes · ') + main.length + ' mapas de acordes';
    $('clear-filters').disabled = !$('search').value && !$('group-filter').value;
    $('chord-filter-note').textContent = isFavorites
      ? 'Suas músicas continuam guardadas. As que saíram da seleção iniciante aparecem com aviso.'
      : selected.size === 0
        ? 'Marque os acordes que você sabe. Uma música só entra na lista quando todos os acordes da adaptação cabem na sua seleção.'
        : level === 'open' ? 'Só aparecem músicas que cabem nos acordes marcados. Gravações que pedem outra afinação ficam fora.' : 'Só aparecem músicas que cabem nos acordes marcados.';
    $('song-grid').innerHTML = main.slice(0,visibleMain).map(renderCard).join('');
    $('song-grid').hidden = main.length === 0;
    $('more-songs').hidden = main.length <= visibleMain;
    $('more-songs').textContent = 'Mostrar mais ' + Math.min(PAGE_SIZE,Math.max(0,main.length-visibleMain)) + ' músicas';
    $('visible-count').textContent = main.length > PAGE_SIZE ? 'Mostrando '+Math.min(visibleMain,main.length)+' de '+main.length+' orientações' : '';
    $('other-song-grid').innerHTML = $('catalog-archive').open ? other.slice(0,visibleOther).map(renderCard).join('') : '';
    $('more-other-songs').hidden = other.length <= visibleOther;
    $('more-other-songs').textContent = 'Mostrar mais ' + Math.min(PAGE_SIZE,Math.max(0,other.length-visibleOther)) + ' músicas';
    $('other-song-grid').hidden = other.length === 0;
    $('other-results-heading').hidden = other.length === 0;
    $('catalog-archive').hidden = other.length === 0;
    $('archive-count').textContent = other.length + ' orientações fora desta seleção ou em revisão';
    $('empty-state').hidden = main.length > 0;
    const excludedByRecording = !isFavorites && !main.length && rows.length && rows.every(song=>beginnerRecordingRestriction(song));
    $('empty-title').textContent = isFavorites && ![...favorites].some(id => ids.has(id)) ? 'Guarde sua primeira música!' : excludedByRecording ? 'Escolha outra música para tocar junto' : 'Vamos procurar de outro jeito?';
    $('empty-description').textContent = isFavorites && ![...favorites].some(id => ids.has(id)) ? 'Toque em “Guardar no meu repertório” na música que você gostar.' : excludedByRecording ? 'Esta busca encontrou gravações fora da seleção iniciante. Veja o motivo abaixo ou procure outra música.' : 'Não encontramos uma adaptação completa com estes filtros e acordes. Tente outro artista, estilo ou marque mais acordes que você já sabe.';
    $('empty-action').textContent = isFavorites && ![...favorites].some(id => ids.has(id)) ? 'Encontrar músicas' : 'Ver toda a seleção';
  }
  function clearSearch() {
    $('search').value = '';
    $('group-filter').value = '';
    renderLibrary();
  }
  function showView(next, updateHash = true) {
    if (next === 'favorites' && view !== 'favorites') {
      $('search').value = '';
      $('group-filter').value = '';
    }
    view = ['library','favorites','calculator'].includes(next) ? next : 'library';
    document.documentElement.dataset.view = view;
    document.querySelectorAll('[data-hide-on-favorites]').forEach(section => { section.hidden = view === 'favorites'; });
    $('library-view').hidden = view === 'calculator';
    $('calculator-view').hidden = view !== 'calculator';
    document.querySelectorAll('.main-tab[data-view]').forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle('active',active);
      if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    syncLevelView();
    if (view !== 'calculator') renderLibrary();
    if (updateHash) {
      try { history.replaceState(null,'',view === 'calculator' ? '#capotraste' : view === 'favorites' ? '#meu-repertorio' : '#repertorio'); } catch (_) {}
    }
  }
  function renderSolution(option, index, partial) {
    const capo = option.capo ? 'Capotraste na ' + option.capo + 'ª casa' : 'Sem capotraste';
    return '<article class="solution-card' + (!partial && index === 0 ? ' best' : '') + '"><h3>' + capo + '</h3><p>' + (partial ? 'Ainda faltam posições para tocar todos os acordes.' : 'Toque estas posições, na mesma ordem:') + '</p><div class="solution-chords">' + option.shapes.map(c => '<b>' + escape(c) + '</b>').join('') + '</div>' + (option.missingShapes.length ? '<p class="solution-missing"><strong>Ainda precisa saber:</strong> ' + option.missingShapes.map(escape).join(' · ') + '. Nenhum acorde foi retirado.</p>' : '') + '</article>';
  }
  function calculate() {
    calculatorUsed = true;
    $('calculator-error').hidden = true;
    if (!window.RepertorioEngine) {
      $('calculator-error').textContent = 'A calculadora não pôde ser carregada.';
      $('calculator-error').hidden = false; return;
    }
    const result = window.RepertorioEngine.analyze($('original-chords').value,[...calculatorShapes],Number($('max-capo').value));
    if (!result.valid) {
      $('calculator-error').textContent = result.errors.join(' ');
      $('calculator-error').hidden = false;
      $('calculator-results').textContent = 'Confira a sequência e tente novamente.'; return;
    }
    const complete = result.solutions;
    $('calculator-results').innerHTML = '<p>' + (usingExample ? 'Exemplo didático. ' : '') + (complete.length ? 'Estas opções mantêm todos os acordes informados.' : 'Não há uma opção completa com as posições escolhidas. A calculadora não troca nem omite acordes sozinha. Escolha outra música ou marque mais posições que você já saiba tocar.') + '</p>' + complete.map((o,i) => renderSolution(shapesAsSelected(o,calculatorShapes),i,false)).join('');
  }
  function updateCalculator() { if (calculatorUsed && $('original-chords').value.trim()) calculate(); }
  function favoriteClick(event) {
    const button = event.target.closest('[data-favorite]');
    if (!button) return;
    const id = button.dataset.favorite;
    const restore = document.activeElement === button;
    const before = [...document.querySelectorAll('[data-favorite]')].indexOf(button);
    const removing = favorites.has(id);
    removing ? favorites.delete(id) : favorites.add(id);
    const saved = save();
    renderLibrary();
    if (restore) {
      const buttons = [...document.querySelectorAll('[data-favorite]')];
      const target = buttons.find(b => b.dataset.favorite === id) || buttons[Math.min(before,buttons.length - 1)] || $('empty-action');
      target.focus({preventScroll:true});
    }
    if (saved) announce(removing ? 'Música removida do seu repertório.' : 'Pronto! Música guardada no seu repertório.');
  }
  const groups = [...new Set(data.map(s => s.group).filter(Boolean))].sort((a,b) => a.localeCompare(b,'pt-BR'));
  const minSongsPerGroup = Math.min(...groups.map(group => countSongs(data.filter(s => s.group === group))));
    $('catalog-summary').textContent = countSongs(data.filter(s=>s.barreAudit?.status==='verified')) + ' músicas com mapa e ' + countSongs(data.filter(s=>s.barreAudit?.status!=='verified')) + ' em revisão, em ' + groups.length + ' estilos.' + (minSongsPerGroup >= 15 ? ' O catálogo tem pelo menos 15 músicas por estilo; a quantidade compatível com seus acordes pode ser menor. ' : ' ') + 'Os mapas usam as cifras vinculadas. A conferência do áudio tem indicação própria em cada ficha.';
  groups.forEach(group => { const o = document.createElement('option'); o.value = group; o.textContent = group + ' (' + countSongs(data.filter(song => song.group === group)) + ')'; $('group-filter').append(o); });
  chordButtons('library-chords',BASIC,selected,updateSelection);
  $('show-curated').addEventListener('click', () => { showCurated = !showCurated; syncLevelView(); renderLibrary(); });
  $('cifra-query').addEventListener('input', () => $('cifra-query').setCustomValidity(''));
  $('cifra-search-form').addEventListener('submit', event => {
    const input = $('cifra-query');
    input.value = input.value.trim();
    if (!input.value) {
      event.preventDefault();
      input.setCustomValidity('Digite uma música ou um artista.');
      input.reportValidity();
    }
  });
  chordButtons('calculator-chords',BASIC,calculatorShapes,updateCalculator);
  chordButtons('calculator-barre-chords',BARRE,calculatorShapes,updateCalculator);
  document.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click',() => chooseLevel(b.dataset.level)));
  $('select-basic').addEventListener('click',() => { BASIC.forEach(c => selected.add(c)); syncChords('library',selected); updateSelection(); });
  $('clear-chords').addEventListener('click',() => { selected.clear(); syncChords('library',selected); updateSelection(); });
  $('search').addEventListener('input',renderLibrary);
  $('group-filter').addEventListener('change',renderLibrary);
  $('clear-filters').addEventListener('click',clearSearch);
  $('find-songs').addEventListener('click',() => {
    renderLibrary();
    $('results').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'start'});
    $('results').focus({preventScroll:true});
  });
  $('empty-action').addEventListener('click',() => { clearSearch(); BASIC.forEach(c => selected.add(c)); syncChords('library',selected); updateSelection(); showView('library'); });
  $('song-grid').addEventListener('click',favoriteClick);
  $('other-song-grid').addEventListener('click',favoriteClick);
  $('more-songs').addEventListener('click',()=>{ const before=visibleMain; visibleMain+=PAGE_SIZE; renderLibrary(); $('song-grid').children[before]?.querySelector('a,button')?.focus({preventScroll:true}); });
  $('more-other-songs').addEventListener('click',()=>{ const before=visibleOther; visibleOther+=PAGE_SIZE; renderLibrary(); $('other-song-grid').children[before]?.querySelector('a,button')?.focus({preventScroll:true}); });
  $('catalog-archive').addEventListener('toggle',renderLibrary);
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click',() => showView(b.dataset.view)));
  document.querySelectorAll('[data-navigate]').forEach(b => b.addEventListener('click',() => { showView(b.dataset.navigate); $('calculator-view').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',block:'start'}); }));
  $('theme-toggle').addEventListener('click',() => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); });
  $('calculator-form').addEventListener('submit',event => { event.preventDefault(); calculate(); });
  $('max-capo').addEventListener('change',updateCalculator);
  $('original-chords').addEventListener('input',() => {
    usingExample = false; calculatorUsed = false;
    $('calculator-error').hidden = true;
    $('calculator-results').textContent = 'Toque em “Encontrar posições” para conferir esta sequência.';
  });
  $('load-example').addEventListener('click',() => {
    usingExample = true; $('original-chords').value = 'C F G Am';
    calculatorShapes.clear(); ['G','C','D','Em'].forEach(c => calculatorShapes.add(c));
    $('max-capo').value = '5'; syncChords('calculator',calculatorShapes); calculate();
  });

  // Explicit, local transfer. Imported IDs are merged; archived favorites are retained.
  $('export-favorites').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify({schema:'criasom-repertoire-favorites/1',favorites:[...favorites]},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='meu-repertorio-criasom.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('import-favorites').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try { if(file.size>100000)throw Error();const payload=JSON.parse(await file.text());
      if(payload.schema!=='criasom-repertoire-favorites/1'||!Array.isArray(payload.favorites)||payload.favorites.length>10000||payload.favorites.some(id=>typeof id!=='string'||!knownIds.has(id)))throw Error();
      payload.favorites.forEach(id=>favorites.add(id));renderLibrary();if(save())announce('Seu repertório foi reunido com as músicas já guardadas.');
    } catch(_){announce('Escolha um arquivo de repertório exportado por este app.');} finally {event.target.value='';}
  });
  window.addEventListener('storage',event=>{
    if(window.REPERTORIO_HOST && event.key==='criasom.ui.theme'){theme=event.newValue==='dark'?'dark':'light';applyTheme();}
  });
  window.addEventListener('pageshow',()=>{if(window.REPERTORIO_HOST){theme=sharedTheme()==='dark'?'dark':'light';applyTheme();}});

  const initialView = () => location.hash === '#capotraste' ? 'calculator' : location.hash === '#meu-repertorio' ? 'favorites' : 'library';
  window.addEventListener('hashchange',() => showView(initialView(),false));
  applyTheme(); updateSelection(); showView(initialView(),false);
})();

