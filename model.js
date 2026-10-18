/** Local pilot data only. Completion records self-report, never verified skill. */
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'criasom.pilot.v1';
const OUTCOMES = new Set(['complete', 'partial', 'repeat']);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: null, sessions: [], practices: [], repertoire: [] };
}

export const STUDY_AREAS = ['Repertório', 'Técnica', 'Mapeamento', 'Improvisação', 'Harmonia', 'Modelagem', 'Composição', 'Ouvido'];
export const STUDY_LABELS = {red:'Preciso trabalhar', yellow:'Em desenvolvimento', green:'Pronto para usar'};
const boundedText = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('Confira os textos do seu estudo.');
  return value.trim();
};
function personalData(input) {
  if (!input || (input.label != null && !Object.hasOwn(STUDY_LABELS, input.label))) fail('Escolha uma etiqueta válida.');
  if (input.repertoireId != null && !isText(input.repertoireId)) fail('A música vinculada não é válida.');
  return {title:boundedText(input.title,160,true), area:boundedText(input.area ?? '',60),
    notes:boundedText(input.notes ?? '',2000), label:input.label ?? null, repertoireId:input.repertoireId ?? null};
}
export function safeMusicLink(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('Confira o link da música.');
  let url; try {url = new URL(value.trim());} catch {fail('Use um link completo, começando com https://.');}
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) fail('Use um link de site ou música, começando com https://.');
  return url.href;
}
export function saveRepertoireSong(state, input) {
  if (!isText(input?.id) || !Object.hasOwn(STUDY_LABELS,input.label) || !Array.isArray(input.links) || input.links.length > 10) fail('Confira os dados da música.');
  const song = {id:input.id,title:boundedText(input.title,160,true),artist:boundedText(input.artist ?? '',160),
    notes:boundedText(input.notes ?? '',2000),label:input.label,links:[...new Set(input.links.filter(x=>typeof x==='string'&&x.trim()).map(safeMusicLink))]};
  const songs = state.repertoire || [];
  return {...state,repertoire:songs.some(x=>x.id===song.id)?songs.map(x=>x.id===song.id?song:x):[...songs,song]};
}
export function removeRepertoireSong(state,id) {
  if (!(state.repertoire||[]).some(x=>x.id===id)) fail('Esta música não está mais no repertório.');
  return {...state,repertoire:state.repertoire.filter(x=>x.id!==id),sessions:state.sessions.map(x=>x.personal?.repertoireId===id?{...x,personal:{...x.personal,repertoireId:null}}:x)};
}
export function labelRepertoireSong(state,id,label) {
  const song=(state.repertoire||[]).find(x=>x.id===id);
  if(!song) fail('Esta música não está mais no repertório.');
  return saveRepertoireSong(state,{...song,label});
}
export function planPersonalSession(state,input) {
  const personal=personalData(input.personal);
  if(personal.repertoireId && !(state.repertoire||[]).some(x=>x.id===personal.repertoireId)) fail('A música escolhida não está mais no repertório.');
  return planSession(state,{...input,date:input.date ?? null,time:input.time ?? null,minutes:input.minutes ?? null,courseId:'personal',moduleId:'personal',practiceId:'personal-'+input.id,personal});
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function checkMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1440) fail('Escolha um tempo entre 1 e 1.440 minutos.');
}

function checkSchedule({ date, time, minutes, moduleId }) {
  const optional = moduleId === 'personal';
  if (!(optional && date == null) && !isValidDate(date)) fail('Escolha uma data válida.');
  if (!(optional && time == null) && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) fail('Escolha um horário válido.');
  if (!(optional && minutes == null)) checkMinutes(minutes);
}

function calendarStartMinutes(session) {
  const [year, month, day] = session.date.split('-').map(Number);
  const [hours, minutes] = session.time.split(':').map(Number);
  // UTC is only an ordinal for calendar dates here, not a conversion of local time.
  return Date.UTC(year, month - 1, day) / 60000 + hours * 60 + minutes;
}

function checkScheduleOverlap(state, candidate, excludeId = null) {
  if (!candidate.date || !candidate.time || !candidate.minutes) return;
  const start = calendarStartMinutes(candidate);
  const end = start + candidate.minutes;
  const overlap = state.sessions.some(session => {
    if (session.id === excludeId || session.status !== 'planned' || session.checked || !session.date || !session.time || !session.minutes) return false;
    const otherStart = calendarStartMinutes(session);
    return start < otherStart + session.minutes && end > otherStart;
  });
  if (overlap) fail('Esse horário já tem um estudo planejado. Escolha outro horário ou remarque o anterior.');
}

function checkIdentity(value) {
  if (!value || !isText(value.id) || !isText(value.courseId) || !isText(value.moduleId)) fail('Não foi possível identificar este estudo.');
}

export function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !isCount(state.revision) ||
      !Array.isArray(state.sessions) || !Array.isArray(state.practices) ||
      !(state.updatedAt === null || isText(state.updatedAt))) fail('O formato dos dados salvos não é compatível com este piloto.');
  if(state.introductionSeen!==undefined&&typeof state.introductionSeen!=='boolean') fail('Apresentação inválida.');
  if(state.studyProfile!==undefined)validateStudyProfile(state.studyProfile);
  if(state.profileApplied!==undefined&&(typeof state.profileApplied!=='string'||state.profileApplied.length>1000))fail('Orientação inválida.');
  const sessionIds = new Set();
  for (const session of state.sessions) {
    checkIdentity(session);
    checkSchedule(session);
    if (session.checked !== undefined && typeof session.checked !== 'boolean') fail('A marcação da tarefa não é válida.');
    if (sessionIds.has(session.id)) fail('Há sessões repetidas nos dados salvos.');
    sessionIds.add(session.id);
    if (!['planned', 'completed'].includes(session.status)) fail('O estado de uma sessão não é válido.');
    if (session.practiceId !== null && !isText(session.practiceId)) fail('Uma prática planejada não é válida.');
    if (session.status === 'completed' && !OUTCOMES.has(session.outcome)) fail('O resultado de uma sessão não é válido.');
    if(session.moduleId==='personal') {
      if(session.courseId!=='personal') fail('Estudo pessoal inválido.');
      personalData(session.personal);
    }
  }
  const practiceIds = new Set();
  for (const practice of state.practices) {
    checkIdentity(practice);
    checkMinutes(practice.minutes);
    if (!isText(practice.practiceId) || practiceIds.has(practice.id)) fail('Há treinos inválidos ou repetidos nos dados salvos.');
    practiceIds.add(practice.id);
    if (!isCount(practice.elapsedSeconds) || !isCount(practice.stepIndex) ||
        !['active', 'completed'].includes(practice.status) || !Array.isArray(practice.attempts)) fail('O progresso de um treino não é válido.');
    const budgetStartSeconds = practice.budgetStartSeconds === undefined ? 0 : practice.budgetStartSeconds;
    if (!isCount(budgetStartSeconds) || budgetStartSeconds > practice.elapsedSeconds) fail('O tempo reservado para esta retomada não é válido.');
    if (practice.status === 'completed' && !OUTCOMES.has(practice.outcome)) fail('O resultado de um treino não é válido.');
    if (practice.sessionId !== null && !isText(practice.sessionId)) fail('O vínculo de um treino não é válido.');
    if (typeof practice.selfReport !== 'string') fail('A percepção registrada não é válida.');
    for (const attempt of practice.attempts) {
      if (!attempt || !OUTCOMES.has(attempt.outcome) || typeof attempt.selfReport !== 'string' ||
          !isCount(attempt.elapsedSeconds) || !isCount(attempt.stepIndex)) fail('O histórico de um treino não é válido.');
    }
    if(practice.moduleId==='personal') {
      if(practice.courseId!=='personal') fail('Registro pessoal inválido.');
      personalData(practice.personal);
    }
  }
  if(state.repertoire!==undefined) {
    if(!Array.isArray(state.repertoire)) fail('O repertório salvo não é válido.');
    const ids=new Set();
    for(const song of state.repertoire){
      if(!isText(song?.id)||ids.has(song.id)||!Array.isArray(song.links)||song.links.length>10||!Object.hasOwn(STUDY_LABELS,song.label)) fail('Há músicas inválidas ou repetidas no repertório.');
      ids.add(song.id);boundedText(song.title,160,true);boundedText(song.artist,160);boundedText(song.notes,2000);song.links.forEach(safeMusicLink);
    }
  }
  if (state.studyClock !== undefined) {
    const clock = state.studyClock;
    if (!clock || !isText(clock.id) || !isCount(clock.baselineSeconds) || clock.baselineSeconds > totalPracticeSeconds(state)) fail('O relógio da sessão não é válido.');
    checkMinutes(clock.minutes);
    if (clock.free !== undefined && typeof clock.free !== 'boolean') fail('O modo do relógio não é válido.');
  }
  return state;
}

/** One study budget across practices. The baseline never rewrites practice history. */
export function totalPracticeSeconds(state) {
  return state.practices.reduce((total, practice) => total + practice.elapsedSeconds, 0);
}

export function startStudyClock(state, { id, minutes, carrySeconds = 0, free = false }, { restart = false } = {}) {
  if (state.studyClock && !restart) return state;
  checkMinutes(minutes);
  if (!isText(id) || !isCount(carrySeconds) || carrySeconds > totalPracticeSeconds(state)) fail('Não foi possível iniciar o relógio da sessão.');
  return { ...state, studyClock: { id, minutes, free: !!free, baselineSeconds: totalPracticeSeconds(state) - carrySeconds } };
}

export function setStudyClockMinutes(state, minutes) {
  checkMinutes(minutes);
  return state.studyClock ? { ...state, studyClock: { ...state.studyClock, minutes, free: false } } : state;
}

/** Caller supplies stable IDs so replaying a transaction cannot duplicate records. */
export function planSession(state, input) {
  checkIdentity(input);
  checkSchedule(input);
  if (state.sessions.some(item => item.id === input.id)) fail('Esta sessão já está no cronograma.');
  checkScheduleOverlap(state, input);
  const session = {
    id: input.id, courseId: input.courseId, moduleId: input.moduleId,
    practiceId: input.practiceId || null, date: input.date, time: input.time,
    minutes: input.minutes, status: 'planned', outcome: null, practiceRunId: null
  };
  if(input.moduleId==='personal') session.personal=personalData(input.personal);
  return { ...state, sessions: [...state.sessions, session] };
}

export function rescheduleSession(state, id, input) {
  const existing = state.sessions.find(item => item.id === id);
  if (!existing) fail('Esta sessão não está mais no cronograma.');
  if (existing.status === 'completed') fail('Esse estudo já foi registrado. Planeje uma nova sessão para estudar novamente.');
  const updated = {
    ...existing, date: input.date ?? existing.date, time: input.time ?? existing.time,
    minutes: input.minutes ?? existing.minutes
  };
  if(existing.moduleId==='personal' && input.personal) {
    updated.personal=personalData(input.personal);
    if(updated.personal.repertoireId && !(state.repertoire||[]).some(x=>x.id===updated.personal.repertoireId)) fail('A música escolhida não está mais no repertório.');
  }
  checkSchedule(updated);
  checkScheduleOverlap(state, updated, id);
  return { ...state, sessions: state.sessions.map(item => item.id === id ? updated : item) };
}

export function deleteSession(state, id) {
  if (!state.sessions.some(item => item.id === id)) fail('Esta sessão não está mais no cronograma.');
  return {
    ...state, sessions: state.sessions.filter(item => item.id !== id),
    practices: state.practices.map(item => item.sessionId === id ? { ...item, sessionId: null } : item)
  };
}

export function startPractice(state, input) {
  checkIdentity(input);
  checkMinutes(input.minutes);
  if (!isText(input.practiceId)) fail('Escolha uma prática para começar.');
  if (state.practices.some(item => item.id === input.id)) fail('Este treino já foi iniciado. Use Continuar.');
  const session = input.sessionId ? state.sessions.find(item => item.id === input.sessionId) : null;
  if (input.sessionId && !session) fail('A sessão escolhida não está mais no cronograma.');
  if (session && (session.courseId !== input.courseId || session.moduleId !== input.moduleId ||
      (session.practiceId && session.practiceId !== input.practiceId))) fail('A prática não corresponde à sessão escolhida.');
  if (session?.status === 'completed') fail('Essa sessão já foi registrada. Comece um novo treino ou retome o registro existente.');
  if (state.practices.some(item => item.status === 'active' && item.courseId === input.courseId &&
      item.moduleId === input.moduleId && item.practiceId === input.practiceId)) fail('Você já começou esta prática. Use Continuar para preservar seu progresso.');
  const practice = {
    id: input.id, courseId: input.courseId, moduleId: input.moduleId,
    practiceId: input.practiceId, sessionId: input.sessionId || null,
    minutes: input.minutes, elapsedSeconds: 0, budgetStartSeconds: 0, stepIndex: 0,
    status: 'active', outcome: null, selfReport: '', attempts: []
  };
  if(input.moduleId==='personal') practice.personal=personalData(session?.personal || input.personal);
  return { ...state, practices: [...state.practices, practice] };
}

export function updatePractice(state, id, input) {
  const existing = state.practices.find(item => item.id === id);
  if (!existing) fail('Este treino não foi encontrado.');
  if (existing.status !== 'active') fail('Retome o treino antes de mudar seu progresso.');
  const elapsedSeconds = input.elapsedSeconds ?? existing.elapsedSeconds;
  const stepIndex = input.stepIndex ?? existing.stepIndex;
  if (!isCount(elapsedSeconds) || !isCount(stepIndex)) fail('O tempo ou a etapa do treino não é válido.');
  // A stale tab's timer cannot move a newer elapsed value backwards.
  const updated = { ...existing, elapsedSeconds: Math.max(existing.elapsedSeconds, elapsedSeconds), stepIndex };
  return { ...state, practices: state.practices.map(item => item.id === id ? updated : item) };
}

export function completePractice(state, id, { outcome, selfReport = '' }) {
  const existing = state.practices.find(item => item.id === id);
  if (!existing) fail('Este treino não foi encontrado.');
  if (existing.status !== 'active') fail('Este treino já foi registrado.');
  if (!OUTCOMES.has(outcome) || typeof selfReport !== 'string') fail('Escolha como foi a prática.');
  const report = selfReport.trim().slice(0, 2000);
  const attempt = { outcome, selfReport: report, elapsedSeconds: existing.elapsedSeconds, stepIndex: existing.stepIndex };
  const updated = { ...existing, status: 'completed', outcome, selfReport: report, attempts: [...existing.attempts, attempt] };
  return {
    ...state, practices: state.practices.map(item => item.id === id ? updated : item),
    sessions: state.sessions.map(item => item.id === existing.sessionId && item.status === 'planned' ?
      { ...item, status: 'completed', outcome, practiceRunId: id, ...(item.moduleId==='personal'?{checked:true}:{}) } : item)
  };
}

export function resumePractice(state, id, { minutes } = {}) {
  const existing = state.practices.find(item => item.id === id);
  if (!existing) fail('Este treino não foi encontrado.');
  if (existing.status === 'active') {
    if (minutes === undefined) return state;
    checkMinutes(minutes);
    const updated = { ...existing, minutes, budgetStartSeconds: existing.elapsedSeconds };
    return { ...state, practices: state.practices.map(item => item.id === id ? updated : item) };
  }
  if (existing.outcome === 'complete') fail('Este treino está concluído. Comece outro para praticar novamente.');
  if (minutes !== undefined) checkMinutes(minutes);
  if (state.practices.some(item => item.id !== id && item.status === 'active' &&
      item.courseId === existing.courseId && item.moduleId === existing.moduleId &&
      item.practiceId === existing.practiceId)) fail('Já existe uma retomada ativa desta prática.');
  // A new attempt cannot rewrite the already registered session's day or result.
  // Explicitly choosing minutes starts a new budget without erasing total practice time.
  const updated = {
    ...existing, status: 'active', outcome: null, sessionId: null,
    minutes: minutes ?? existing.minutes,
    budgetStartSeconds: minutes === undefined ? existing.budgetStartSeconds ?? 0 : existing.elapsedSeconds
  };
  return { ...state, practices: state.practices.map(item => item.id === id ? updated : item) };
}

/** Local calendar strings intentionally avoid UTC conversion and DST surprises. */
export function sessionTiming(session, today) {
  if (!isValidDate(today)) fail('A data de hoje não é válida.');
  if (session.status === 'completed') return 'completed';
  if (!session.date) return 'unscheduled';
  return session.date < today ? 'past' : session.date > today ? 'future' : 'today';
}

export function makeId(prefix = 'item') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function stampRecords(previous, next, timestamp) {
  const stampList = name => next[name].map(item => {
    const old = previous[name].find(record => record.id === item.id);
    if (old && JSON.stringify(old) === JSON.stringify(item)) return item;
    const stamped = {
      ...item, createdAt: old?.createdAt || timestamp, updatedAt: timestamp,
      completedAt: item.status === 'completed' ?
        (old?.status === 'completed' ? old.completedAt || timestamp : timestamp) : null
    };
    if (name === 'practices') {
      stamped.attempts = item.attempts.map((attempt, index) => ({
        ...attempt, recordedAt: old?.attempts[index]?.recordedAt || attempt.recordedAt || timestamp
      }));
    }
    return stamped;
  });
  return { ...next, sessions: stampList('sessions'), practices: stampList('practices') };
}

/**
 * localStorage provides no cross-tab atomic compare-and-swap. Each operation reads
 * the latest record and checks it again before saving; a storage event should make
 * the UI re-read. A server is still required for accounts and multi-device sync.
 */
export function createStore(options = {}) {
  const key = options.key || STORAGE_KEY;
  const now = options.now || (() => new Date().toISOString());
  let memory = emptyState();
  let memoryOnly = false;
  let memoryWarning = null;
  let storage;
  try {
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('unavailable');
  } catch {
    memoryOnly = true;
    memoryWarning = 'O navegador não permite salvar neste dispositivo. Seu progresso fica apenas nesta tela e será perdido ao fechá-la.';
  }

  function toMemory(warning) {
    memoryOnly = true;
    memoryWarning = warning;
  }

  function load() {
    if (memoryOnly) return { state: clone(memory), persisted: false, warning: memoryWarning, raw: null };
    let raw;
    try { raw = storage.getItem(key); } catch {
      toMemory('Não foi possível ler os dados deste dispositivo. O progresso desta sessão ficará apenas nesta tela; mantenha-a aberta.');
      return load();
    }
    if (raw === null) {
      memory = emptyState();
      return { state: clone(memory), persisted: false, warning: null, raw };
    }
    try {
      const state = validateState(JSON.parse(raw));
      memory = clone(state);
      return { state: clone(state), persisted: true, warning: null, raw };
    } catch {
      toMemory('Os dados salvos não puderam ser lidos e foram preservados sem alteração. Você pode testar nesta tela, mas o novo progresso não será salvo.');
      return load();
    }
  }

  function read() {
    const { raw, ...result } = load();
    return result;
  }

  function transact(mutator) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = load();
      let next;
      try {
        next = mutator(clone(current.state));
        if (!next || typeof next.then === 'function') fail('A alteração precisa ser concluída antes de salvar.');
        if (next.revision !== current.state.revision) fail('Esses dados mudaram em outra aba. Atualize a tela e tente novamente.');
        const timestamp = now();
        next = stampRecords(current.state, next, timestamp);
        next = { ...next, schemaVersion: SCHEMA_VERSION, revision: current.state.revision + 1, updatedAt: timestamp };
        validateState(next);
        next = clone(next);
      } catch (error) {
        return { ok: false, state: current.state, persisted: current.persisted, warning: error.message || 'Não foi possível registrar esta alteração.' };
      }
      if (memoryOnly) {
        memory = next;
        return { ok: true, state: clone(memory), persisted: false, warning: memoryWarning };
      }
      try {
        // Replay the pure operation against newer data, preserving other tabs' edits.
        if (storage.getItem(key) !== current.raw) continue;
        storage.setItem(key, JSON.stringify(next));
      } catch {
        memory = next;
        toMemory('Não foi possível salvar neste dispositivo. Esta alteração fica apenas nesta tela e será perdida ao fechá-la.');
        return { ok: true, state: clone(memory), persisted: false, warning: memoryWarning };
      }
      memory = next;
      return { ok: true, state: clone(next), persisted: true, warning: null };
    }
    const current = read();
    return { ok: false, ...current, warning: 'Outra aba está alterando o estudo agora. Nenhum dado foi substituído; tente novamente.' };
  }

  return { read, transact, key };
}

let defaultStore;
const store = () => defaultStore || (defaultStore = createStore());
export const readState = () => store().read();
export const transact = mutator => store().transact(mutator);

// Direct editing shares the existing session IDs and account persistence.
export function patchStudyTask(state, id, patch) {
  const item = state.sessions.find(s => s.id === id);
  if (!item || item.moduleId !== 'personal') fail('Esta tarefa não está mais na lista.');
  const personal = personalData({...item.personal, ...patch.personal});
  if (personal.repertoireId && !(state.repertoire || []).some(s => s.id === personal.repertoireId)) fail('A música escolhida não está mais no repertório.');
  const updated = {...item, personal};
  for (const key of ['date','time','minutes']) if (Object.hasOwn(patch,key)) updated[key] = patch[key];
  checkSchedule(updated);
  if (['date','time','minutes'].some(key=>Object.hasOwn(patch,key)&&updated[key]!==item[key]) && !taskIsChecked(updated)) checkScheduleOverlap(state,updated,id);
  return {...state,sessions:state.sessions.map(s=>s.id===id?updated:s)};
}

export function taskIsChecked(item) {
  return item.checked ?? item.status === 'completed';
}

export function checkStudyTask(state,id,checked) {
  const item=state.sessions.find(s=>s.id===id);
  if(!item || item.moduleId!=='personal' || typeof checked!=='boolean') fail('Esta tarefa não está mais na lista.');
  // A check is organization only; musical attempts remain exclusively in practices.
  const updated={...item,checked};
  if(!checked && item.status==='completed') Object.assign(updated,{status:'planned',outcome:null,practiceRunId:null});
  return {...state,sessions:state.sessions.map(s=>s.id===id?updated:s)};
}

export function moveStudyTask(state,id,targetId,after=false) {
  const source=state.sessions.find(s=>s.id===id),target=state.sessions.find(s=>s.id===targetId);
  if(!source || !target || source.moduleId!=='personal' || target.moduleId!=='personal') fail('A lista mudou. Escolha novamente a posição.');
  if(id===targetId)return state;
  const items=state.sessions.filter(s=>s.id!==id),index=items.findIndex(s=>s.id===targetId);
  items.splice(index+(after?1:0),0,source);
  return {...state,sessions:items};
}


// First access and the optional beta profile belong to this learner's study state.
export const PROFILE_OPTIONS = {
  experience:['starting','returning','comfortable'],
  instrument:['guitar','acoustic','other'],
  goal:['songs','improvise','harmony','ear','rhythm'],
  obstacle:['start','time','stuck','apply'],
  availability:['free','short','medium','long']
};
export function validateStudyProfile(profile) {
  if(!profile || typeof profile!=='object') fail('Confira suas respostas.');
  for(const [key,options] of Object.entries(PROFILE_OPTIONS)) if(profile[key]!==null && !options.includes(profile[key])) fail('Uma resposta do personalizador não é válida.');
  return profile;
}
export function saveStudyProfile(state,profile) {
  validateStudyProfile(profile);
  return {...state,studyProfile:Object.fromEntries(Object.keys(PROFILE_OPTIONS).map(key=>[key,profile[key]]))};
}
export function markIntroduction(state) { return {...state,introductionSeen:true}; }
export function freshStudy(state) {return {...emptyState(),revision:state.revision};}
export function restoreStudy(state,backup) {
  validateState(backup);
  return {...clone(backup),revision:state.revision};
}
export function studySuggestions(profile) {
  validateStudyProfile(profile);
  const starting=profile.experience==='starting';
  const focus={songs:['Escolher um trecho de uma música que quero tocar','Repertório'],improvise:['Cantar uma frase curta e responder no instrumento','Improvisação'],harmony:['Explorar o som dos acordes de uma música','Harmonia'],ear:['Ouvir uma frase e procurar suas notas com calma','Ouvido'],rhythm:['Tocar uma levada simples mantendo o pulso','Técnica']}[profile.goal]||['Escolher uma música e tocar um trecho com atenção','Repertório'];
  const barrier={start:'Começar por um trecho pequeno, sem obrigação de terminar a música.',time:'Deixar o instrumento pronto e escolher uma tarefa pequena para o tempo disponível.',stuck:'Diminuir a dificuldade e observar uma coisa de cada vez.',apply:'Levar uma ideia da aula para uma música ou criação própria.'}[profile.obstacle]||'Escolha uma intenção pequena para este encontro com o instrumento.';
  return [
    {title:focus[0],area:focus[1],notes:barrier},
    {title:starting?'Rever uma demonstração e experimentar um trecho':'Rever uma ideia da aula e criar uma variação',area:'Exploração',notes:'A aula é a referência. Pause a tela e passe tempo explorando o instrumento, sem pressa.'},
    {title:'Tocar livremente e anotar o que quero retomar',area:'Musicalidade',notes:'O foco é a constância e a atenção. Ao acabar, registre uma descoberta ou dificuldade, sem se dar uma nota.'}
  ];
}
