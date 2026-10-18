import {createStore, STORAGE_KEY, makeId, planSession, rescheduleSession, deleteSession, startPractice, updatePractice, completePractice, resumePractice, sessionTiming, startStudyClock, setStudyClockMinutes, totalPracticeSeconds, STUDY_AREAS, STUDY_LABELS, safeMusicLink, saveRepertoireSong, removeRepertoireSong, labelRepertoireSong, planPersonalSession, patchStudyTask, checkStudyTask, taskIsChecked, moveStudyTask, validateState, markIntroduction, freshStudy, restoreStudy, saveStudyProfile, studySuggestions} from './model.js';

const data = window.CRIASOM_DATA || await fetch('data.json').then(r=>{if(!r.ok)throw Error('Conteúdo indisponível');return r.json()});
const account=window.CRIASOM_ACCOUNT||null;
const store=account?.store||createStore();
let state, persisted=true, route='hoje', moduleId='dap:modulo:03', minutes=10, runId=null, weekOffset=0, tool=null, bpm=60;
let running=false, elapsedBase=0, startedAt=0, timerInterval=null, lastSavedSecond=0;
let audioCtx=null, metroInterval=null, nextBeat=0, beat=0, metroRunning=false;
let selectedBookPage=15, bookPages=[], bookZoom=100, lastFocused=null, toastTimeout;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const asset=p=>window.CRIASOM_ASSETS?.[p]||p;
const mod=id=>id==='personal'?personalModule():data.modules.find(m=>m.id===id);
const allowedModule=id=>id==='personal'?(!account||account.has('app')):!!mod(id)&&(!account||account.has('course:'+mod(id).courseId));
const availableModules=()=>data.modules.filter(m=>allowedModule(m.id));
const visibleSessions=()=>account?state.sessions.filter(s=>allowedModule(s.moduleId)):state.sessions;
const visiblePractices=()=>account?state.practices.filter(p=>allowedModule(p.moduleId)):state.practices;
const saveMessage=(saved,local)=>account?(persisted?saved:'Salvando na sua conta…'):persisted?saved:local;
function accountUnavailable(title='Este conteúdo não está liberado para sua conta.'){return `<section class="card"><h1>${esc(title)}</h1><p>Você pode consultar o catálogo. Seus registros confirmados permanecem na sua conta.</p><a class="button" href="#cursos">Ver cursos</a></section>`}
function accountCommunity(){return '<div class="community-page" id="account-forum-root"><p role="status">Abrindo a comunidade…</p></div>'}
const practice=(id,mid=moduleId)=>mod(mid)?.practices.find(p=>p.id===id);
const currentRun=()=>state.practices.find(p=>p.id===runId);
const currentPractice=()=>practice(currentRun()?.practiceId,currentRun()?.moduleId);
const dateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today=()=>dateKey(new Date());
const dateObj=s=>new Date(`${s}T12:00:00`);
const dayName=s=>dateObj(s).toLocaleDateString('pt-BR',{weekday:'short'}).replace('.','');
const fmtDate=s=>dateObj(s).toLocaleDateString('pt-BR',{day:'numeric',month:'short'});
const fmtTime=s=>`${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
function weekDates(offset=weekOffset){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7)+offset*7);return Array.from({length:7},(_,i)=>{const v=new Date(d);v.setDate(d.getDate()+i);return dateKey(v)})}
function toast(t){$('#toast').textContent=t;$('#toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('#toast').classList.remove('visible'),4500)}
function applyResult(r){state=r.state;persisted=r.persisted;const warning=$('#storage-warning');warning.hidden=!r.warning;warning.textContent=r.warning||'';if(r.ok===false){toast(r.warning||'Não foi possível guardar a mudança.');return false}return true}
function tx(fn){try{return applyResult(store.transact(fn))}catch(e){toast(e.message);return false}}
applyResult(store.read());
minutes=state.studyClock?.minutes||[...state.practices].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))[0]?.minutes||10;
const accountPreferences=new Map();
function preference(key,value){if(account&&key.startsWith('guide.')){if(value!==undefined)accountPreferences.set(key,value);return accountPreferences.get(key)||null}try{if(value!==undefined)localStorage.setItem(`criasom.ui.${key}`,value);return localStorage.getItem(`criasom.ui.${key}`)}catch{return null}}
if(account&&!allowedModule(moduleId))moduleId=availableModules()[0]?.id||'';
document.documentElement.dataset.theme=preference('theme')||'light';
let fontSize=Number(preference('font')||0);if(![0,1,2].includes(fontSize))fontSize=0;
function applyPrefs(){requestAnimationFrame(resizeTaskTitles);document.documentElement.style.fontSize=`${17+fontSize*2}px`;$('#font').textContent=['A+','A++','A−'][fontSize];$('#font').setAttribute('aria-label',fontSize===2?'Voltar ao tamanho padrão do texto':'Aumentar tamanho do texto');$('#theme').setAttribute('aria-label',document.documentElement.dataset.theme==='dark'?'Ativar tema claro':'Ativar tema escuro')}
applyPrefs();
$('#font').onclick=()=>{fontSize=(fontSize+1)%3;preference('font',fontSize);applyPrefs()};
$('#theme').onclick=()=>{const t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=t;preference('theme',t);applyPrefs()};
// Repertório stays on a separate same-origin page: no route/style globals are shared.
const REPERTOIRE_RETURN_KEY='criasom.repertoire.return.v1';
function safeStudyReturnHash(hash){
 return typeof hash==='string'&&hash.length<=256&&/^#(?:hoje|semana|cursos|academia|como|progresso|curso|modulo|pratica|comunidade|envio|compartilhar)(?:\/[A-Za-z0-9:_%~-]+)*$/.test(hash)?hash:'#hoje';
}
function prepareRepertoireEntry(event){
 const link=event.target.closest('a[data-repertoire-entry]');if(!link)return;
 if(account){event.preventDefault();toast(account.has('repertoire')?'O Repertório está preservado, mas seus favoritos ainda não foram conectados à conta.':'O Repertório não está liberado para esta conta.');return;}
 if(!saveTimerProgress()){event.preventDefault();return;}
 pauseTimer(false);stopSounds();
 if(!persisted&&(state.practices.length||state.sessions.length)){
  event.preventDefault();toast('Seu progresso está só nesta tela. Exporte seus registros em Sobre este teste antes de sair.');return;
 }
 try{sessionStorage.setItem(REPERTOIRE_RETURN_KEY,JSON.stringify({version:1,hash:safeStudyReturnHash(location.hash),updatedAt:new Date().toISOString()}));}catch{}
}
document.addEventListener('click',prepareRepertoireEntry);
function syncSharedPreferences(){
 document.documentElement.dataset.theme=preference('theme')==='dark'?'dark':'light';
 const value=Number(preference('font')||0);fontSize=[0,1,2].includes(value)?value:0;applyPrefs();
}
window.addEventListener('pageshow',syncSharedPreferences);
window.addEventListener('storage',event=>{if(event.key==='criasom.ui.theme'||event.key==='criasom.ui.font')syncSharedPreferences();});
const routeArt='<svg class="route-art" viewBox="0 0 100 160" aria-hidden="true"><g fill="none" stroke="white" stroke-width="1">'+[10,25,40,55,70,85].map(x=>`<path d="M${x} 0v160"/>`).join('')+[20,50,80,110,140].map(y=>`<path d="M0 ${y}h100"/>`).join('')+'</g><path d="M10 30L10 120L25 30L25 90L40 30L40 90" stroke="white" stroke-width="3" fill="none"/></svg>';
const recentPractices=()=>[...visiblePractices()].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
$('.skip').onclick=e=>{e.preventDefault();$('#main').focus();$('#main').scrollIntoView()};
function suggested(mid=moduleId){const m=mod(mid);if(m.guide)return guideSuggestion(m);const latest=recentPractices().find(r=>r.moduleId===mid);if(latest){const p=practice(latest.practiceId,mid);if(latest.status==='active'||latest.outcome!=='complete')return{p,run:latest};return{p:practice(p?.nextPracticeId,mid)||p,run:null}}return{p:m.practices[0],run:null}}
function navigate(to){location.hash=to;if(location.hash.slice(1)===to&&route===to)render()}
function go(to){if(route==='pratica'){pauseTimer();stopSounds()}if($('#dialog').open)closeDialog();location.hash=to;}
function render(){account?.forum?.clear();communityBeforeRender();let hash;try{hash=decodeURIComponent(location.hash.slice(1)||'hoje')}catch{hash='cursos'}const parts=hash.split('/');route=parts[0];
 if(account){
  const denied=route==='curso'&&!account.has('course:'+parts[1])||route==='modulo'&&!allowedModule(parts[1]);
  if(denied){pauseTimer(false);stopSounds();$('#main').className='';$('#main').innerHTML=accountUnavailable();return;}
  if(route==='pratica'){const requested=state.practices.find(p=>p.id===parts[1]);if(requested&&!allowedModule(requested.moduleId)){$('#main').className='';$('#main').innerHTML=accountUnavailable();return;}}
  if(['hoje','semana','repertorio','personalizador'].includes(route)&&!account.has('app')){$('#main').innerHTML=accountUnavailable('Sua conta ainda não tem acesso ao app.');return;}
 }
 if(parts[1]&&mod(parts[1]))moduleId=parts[1];if(route==='pratica'){runId=parts[1];const r=currentRun();if(!r||r.status!=='active'){route='hoje';history.replaceState(null,'','#hoje')}else moduleId=r.moduleId;}
 $('#main').className=route==='pratica'?'practice-main':'';
 document.querySelectorAll('.header nav a').forEach(a=>{if(a.hash===`#${route}`||(communityScopes.includes(communityScope())&&a.hash==='#comunidade/geral')||(route==='modulo'||route==='curso')&&a.hash==='#cursos')a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
 const views={hoje:home,semana:calendar,repertorio:personalRepertoire,cursos:catalog,curso:course,modulo:moduleView,pratica:practiceView,como:experienceHelp,personalizador:personalizer,progresso:progress,comunidade:account?accountCommunity:communityShell,academia:account?accountCommunity:communityShell,envio:account?accountCommunity:communityShell,compartilhar:account?accountCommunity:communityShell};
 $('#main').innerHTML=(views[route]||home)();
 resizeTaskTitles();
 if(route==='pratica'){paintTimer();if(tool)renderTool()}
 if(account&&['comunidade','academia','envio','compartilhar'].includes(route))void account.forum.mount($('#account-forum-root'));
 if(!account&&['comunidade','academia','envio','compartilhar'].includes(route))void communityMount();
}
window.addEventListener('hashchange',()=>{if(route==='pratica'&&!location.hash.startsWith('#pratica/')){pauseTimer();stopSounds()}tool=null;render();window.scrollTo({top:0,behavior:'instant'});$('#main').focus({preventScroll:true})});
window.addEventListener('storage',e=>{if(account||e.key!==STORAGE_KEY)return;pauseTimer(false);stopSounds();applyResult(store.read());render();toast('Carreguei o progresso mais recente da outra aba.');});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(!saveTimerProgress()){pauseTimer(false);stopSounds()}}else{const result=store.read();if(state.revision!==result.state.revision){pauseTimer(false);stopSounds();applyResult(result);minutes=state.studyClock?.minutes||minutes;render()}else paintTimer()}});
window.addEventListener('pagehide',()=>{pauseTimer();stopSounds()});
function labelBadge(label){if(!label)return '';return `<span class="study-label label-${label}"><i aria-hidden="true"></i>${esc(STUDY_LABELS[label])}</span>`}
function personalDefinition(pid){
 const run=state?.practices.find(x=>x.moduleId==='personal'&&x.practiceId===pid);
 const session=state?.sessions.find(x=>x.moduleId==='personal'&&x.practiceId===pid);
 const item=session?.personal||run?.personal;if(!item)return null;
 const song=(state.repertoire||[]).find(x=>x.id===item.repertoireId);
 return {id:pid,title:item.title,displayTitle:item.title,objective:item.notes||(item.area?`Seu estudo de ${item.area.toLowerCase()}.`:'Seu estudo livre.'),personal:item,song,
  steps:[{title:item.title,instruction:item.notes||'Escolha um foco pequeno, toque com atenção e registre o que quer retomar.'}],
  help:'Diminua a velocidade ou escolha uma parte menor. Você pode ajustar seu cronograma.',
  check:'O que você conseguiu experimentar hoje? Este registro é para orientar seu próximo estudo.',
  ifReady:'Use sua percepção para decidir quando repetir, mudar o foco ou revisar uma aula.',lessonIds:[],pages:[],positionIds:[]};
}
function personalModule(){return {id:'personal',courseId:'personal',title:'Meu estudo',practices:[...new Set([...state.sessions,...state.practices].filter(x=>x.moduleId==='personal').map(x=>x.practiceId))].map(personalDefinition).filter(Boolean)}}
function sessionTitle(s){return s.personal?.title||practice(s.practiceId,s.moduleId)?.displayTitle||practice(s.practiceId,s.moduleId)?.title||mod(s.moduleId)?.title||'Estudo'}
function courseSessionRow(s){return `<article class="study-row"><div class="study-row-main"><span class="small muted">${esc(s.time)} · ${s.minutes} min · ${esc(s.personal?.area||courseOf(s.moduleId).title)}</span><h3>${esc(sessionTitle(s))}</h3>${s.personal?labelBadge(s.personal.label):'<span class="small muted">Apoio do curso</span>'}${s.status==='completed'?'<p class="small muted">✓ Estudo registrado</p>':''}</div><div class="actions">${s.status==='completed'?'<a class="text-button" href="#progresso">Ver registro</a>':`<button class="button primary" data-action="begin-session" data-id="${esc(s.id)}">Começar</button><button class="text-button" data-action="edit-plan" data-id="${esc(s.id)}">Editar</button>`}</div></article>`}
function quickTaskForm(date='',suffix='main') {
 return `<form class="quick-task" data-quick-task data-date="${esc(date)}"><span aria-hidden="true">＋</span><label class="sr-only" for="quick-${suffix}">Nova tarefa</label><input id="quick-${suffix}" name="title" maxlength="160" autocomplete="off" placeholder="Escreva uma tarefa…" required><button class="text-button" type="submit">Adicionar</button></form>`;
}
function taskRow(s) {
 const checked=taskIsChecked(s),extra=[s.date?fmtDate(s.date):'',s.time||'',s.minutes?`${s.minutes} min`:'',s.personal.area].filter(Boolean);
 return `<article class="task-line ${checked?'is-checked':''}" data-task-id="${esc(s.id)}"><div class="task-main"><button class="task-grip" draggable="true" data-drag-task="${esc(s.id)}" data-action="task-options" data-id="${esc(s.id)}" aria-label="Organizar tarefa: ${esc(s.personal.title)}" title="Arraste ou abra as opções">⠿</button><label class="task-check"><input type="checkbox" data-task-check="${esc(s.id)}" ${checked?'checked':''} aria-label="Marcar tarefa: ${esc(s.personal.title)}"></label><textarea class="task-title" data-task-title="${esc(s.id)}" rows="1" maxlength="160" aria-label="Editar tarefa: ${esc(s.personal.title)}">${esc(s.personal.title)}</textarea>${!checked?`<button class="task-play" data-action="begin-session" data-id="${esc(s.id)}" aria-label="Começar: ${esc(s.personal.title)}">Tocar <span aria-hidden="true">▷</span></button>`:''}<button class="task-more" data-action="task-options" data-id="${esc(s.id)}" aria-label="Opções de ${esc(s.personal.title)}" aria-expanded="false">•••</button></div>${extra.length||s.personal.label?`<div class="task-meta">${extra.length?`<span>${esc(extra.join(' · '))}</span>`:''}${labelBadge(s.personal.label)}</div>`:''}<div class="task-options" id="options-${esc(s.id)}" hidden></div></article>`;
}
function sessionRow(s) {return s.moduleId==='personal'?taskRow(s):courseSessionRow(s)}
function home(){
 if(account&&!account.has('app'))return accountUnavailable('Sua conta ainda não tem acesso ao app.');
 const items=visibleSessions(),open=items.filter(s=>!taskIsChecked(s)),done=items.filter(taskIsChecked);
 const active=recentPractices().find(r=>r.status==='active');
 return `<section class="study-notebook"><div class="page-title"><div><p class="eyebrow">Seu espaço de música</p><h1>Meu estudo</h1><p class="muted">Escreva, organize e toque.</p></div><a class="text-button" href="#como">Preciso de ajuda</a></div><div class="study-shortcuts"><a href="#repertorio">Meu repertório <span>${(state.repertoire||[]).length}</span></a><a href="#semana">Minha semana →</a><a href="#progresso" title="Como foram as práticas que você registrou">Meus registros</a></div>${active?`<div class="task-resume"><span>◷ ${fmtTime(state.studyClock?Math.max(0,totalPracticeSeconds(state)-state.studyClock.baselineSeconds):active.elapsedSeconds)} estudados · ${esc(active.personal?.title||practice(active.practiceId,active.moduleId)?.title||'Prática')}</span><button class="text-button" data-action="begin" data-run="${esc(active.id)}" data-module="${esc(active.moduleId)}" data-practice="${esc(active.practiceId)}">Continuar →</button></div>`:''}${!open.length&&!done.length?`<section class="empty-start"><h2>Seu estudo começa com uma linha.</h2><p>Escreva abaixo o que quer tocar. Pode ser uma música, um trecho ou uma ideia.</p><p class="small">Sem datas obrigatórias. Sem tarefas preenchidas por nós. <a href="#personalizador">Quero uma sugestão</a></p></section>`:''}<div class="task-list" aria-label="Tarefas de estudo">${open.map(sessionRow).join('')}${quickTaskForm()}</div><p class="task-hint">Enter adiciona. Clique no texto para editar. ⠿ e ••• organizam sua tarefa.<br>Esta lista reúne seus planos. Em <a href="#progresso">Meus registros</a>, você vê como foram as práticas.</p>${done.length?`<details class="completed-tasks"><summary>Marcadas (${done.length})</summary><div class="task-list">${done.map(sessionRow).join('')}</div></details>`:''}<div class="course-footnote"><span>Apoio para tocar melhor</span><a href="#cursos">Consultar meus cursos →</a></div></section>`;
}
function calendar(){
 const dates=weekDates(),free=visibleSessions().filter(s=>!s.date&&!taskIsChecked(s));
 return `<section class="study-notebook"><div class="page-title"><div><p class="eyebrow">Meu estudo</p><h1>Minha semana</h1><p class="muted">Com data ou sem data. Você escolhe.</p></div><a class="text-button" href="#hoje">Voltar à lista</a></div><div class="week-header"><button class="icon" data-action="week-prev" aria-label="Semana anterior">←</button><span>${fmtDate(dates[0])} — ${fmtDate(dates[6])}</span><button class="icon" data-action="week-next" aria-label="Semana seguinte">→</button><button class="text-button" data-action="week-today">Esta semana</button></div><section class="free-tasks"><h2>Sem data</h2><div class="task-list">${free.map(sessionRow).join('')}${quickTaskForm('','free')}</div></section><div class="simple-week">${dates.map(d=>`<section class="simple-day ${d===today()?'today':''}" data-task-date="${d}"><h2>${dayName(d)} <span>${Number(d.slice(-2))}${d===today()?' · hoje':''}</span></h2><div class="task-list">${visibleSessions().filter(s=>s.date===d).map(sessionRow).join('')}${quickTaskForm(d,d)}</div></section>`).join('')}</div></section>`;
}
function resizeTaskTitles(){document.querySelectorAll('[data-task-title]').forEach(el=>{el.style.height='auto';el.style.height=el.scrollHeight+'px'})}
window.addEventListener('resize',()=>requestAnimationFrame(resizeTaskTitles));
function taskOptions(id){
 const s=state.sessions.find(x=>x.id===id),box=document.getElementById('options-'+id);if(!s||!box)return;
 if(!box.hidden){box.hidden=true;box.previousElementSibling?.querySelector('[aria-expanded]')?.setAttribute('aria-expanded','false');return;}
 document.querySelectorAll('.task-options').forEach(x=>x.hidden=true);
 document.querySelectorAll('.task-more').forEach(x=>x.setAttribute('aria-expanded','false'));
 const peers=[...box.closest('.task-list').querySelectorAll('[data-task-id]')].map(el=>el.dataset.taskId),index=peers.indexOf(id);
 box.innerHTML=`<div class="task-option-actions"><button class="text-button" data-action="task-move" data-id="${esc(id)}" data-target="${esc(peers[index-1]||'')}" ${index===0?'disabled':''}>↑ Subir</button><button class="text-button" data-action="task-move" data-id="${esc(id)}" data-target="${esc(peers[index+1]||'')}" data-after="true" ${index===peers.length-1?'disabled':''}>↓ Descer</button><button class="text-button" data-action="task-options" data-id="${esc(id)}">Fechar</button></div><form data-task-details="${esc(id)}"><div class="task-dates"><label>Data <input type="date" name="date" value="${esc(s.date||'')}"></label><label>Hora <input type="time" name="time" value="${esc(s.time||'')}"></label><label>Minutos <input type="number" name="minutes" min="1" max="1440" placeholder="Livre" value="${s.minutes||''}"></label></div><details class="task-extra"><summary>Categoria, etiqueta e repertório</summary><label>Categoria <input name="area" list="task-areas-${esc(id)}" maxlength="60" value="${esc(s.personal.area)}" placeholder="Opcional"></label><datalist id="task-areas-${esc(id)}">${STUDY_AREAS.map(a=>`<option value="${esc(a)}">`).join('')}</datalist><label>Etiqueta <select name="label"><option value="">Sem etiqueta</option>${Object.entries(STUDY_LABELS).map(([k,v])=>`<option value="${k}" ${s.personal.label===k?'selected':''}>${esc(v)}</option>`).join('')}</select></label><label>Música <select name="repertoireId"><option value="">Sem vínculo</option>${(state.repertoire||[]).map(song=>`<option value="${esc(song.id)}" ${s.personal.repertoireId===song.id?'selected':''}>${esc(song.title)}</option>`).join('')}</select></label><label>Anotações <textarea name="notes" maxlength="2000">${esc(s.personal.notes)}</textarea></label></details><button class="text-button" type="submit">Guardar opções</button><span class="small muted">Tudo opcional</span></form>`;
 box.hidden=false;box.closest('.task-line').querySelector('.task-more').setAttribute('aria-expanded','true');
}
function saveTaskTitle(el){
 const s=state.sessions.find(x=>x.id===el.dataset.taskTitle);if(!s)return true;
 const title=el.value.trim();if(title===s.personal.title){el.removeAttribute('aria-invalid');return true;}
 if(!title){el.setAttribute('aria-invalid','true');toast('Escreva um nome para a tarefa. O texto anterior está guardado.');return false;}
 const ok=tx(state=>patchStudyTask(state,s.id,{personal:{title}}));
 if(ok){el.removeAttribute('aria-invalid');el.setAttribute('aria-label','Editar tarefa: '+title);const row=el.closest('.task-line');row.querySelector('[data-task-check]').setAttribute('aria-label','Marcar tarefa: '+title);row.querySelector('.task-play')?.setAttribute('aria-label','Começar: '+title);row.querySelector('.task-more').setAttribute('aria-label','Opções de '+title)}
 return ok;
}
document.addEventListener('input',event=>{if(event.target.matches('[data-task-title]')){resizeTaskTitles()}});
document.addEventListener('focusout',event=>{if(event.target.matches('[data-task-title]'))saveTaskTitle(event.target)});
window.addEventListener('pagehide',()=>{document.querySelectorAll('[data-task-title]').forEach(saveTaskTitle)});
document.addEventListener('keydown',event=>{
 const el=event.target;if(!el.matches('[data-task-title]')||event.isComposing)return;
 if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(saveTaskTitle(el))el.closest('.task-list').querySelector('[data-quick-task] input')?.focus()}
 if(event.key==='Escape'){event.preventDefault();el.value=state.sessions.find(s=>s.id===el.dataset.taskTitle)?.personal.title||el.value;el.removeAttribute('aria-invalid');resizeTaskTitles();el.blur()}
});
document.addEventListener('change',event=>{const el=event.target;if(el.matches('[data-task-check]')){const id=el.dataset.taskCheck;if(tx(s=>checkStudyTask(s,id,el.checked))){render();const row=document.querySelector(`[data-task-id="${CSS.escape(id)}"]`);const details=row?.closest('.completed-tasks');if(details)details.open=true;row?.querySelector('[data-task-check]')?.focus()}else el.checked=!el.checked;}});
document.addEventListener('submit',event=>{
 const f=event.target;if(f.matches('[data-quick-task]')){event.preventDefault();const title=f.elements.title.value.trim();if(!title)return;const id=makeId('plan'),date=f.dataset.date||null,suffix=f.elements.title.id;if(tx(s=>planPersonalSession(s,{id,date,personal:{title}}))){render();document.getElementById(suffix)?.focus()}}
 if(f.matches('[data-task-details]')){event.preventDefault();const v=new FormData(f),id=f.dataset.taskDetails;const patch={date:v.get('date')||null,time:v.get('time')||null,minutes:v.get('minutes')?Number(v.get('minutes')):null,personal:{area:v.get('area'),label:v.get('label')||null,repertoireId:v.get('repertoireId')||null,notes:v.get('notes')}};if(tx(s=>patchStudyTask(s,id,patch))){render();document.querySelector(`[data-task-id="${CSS.escape(id)}"] .task-more`)?.focus();toast(saveMessage('Opções guardadas.','Opções só nesta tela.'))}}
});
document.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b||b.disabled)return;if(b.dataset.action==='task-options')taskOptions(b.dataset.id);if(b.dataset.action==='task-move'&&tx(s=>moveStudyTask(s,b.dataset.id,b.dataset.target,b.dataset.after==='true'))){render();document.querySelector(`[data-task-id="${CSS.escape(b.dataset.id)}"] .task-grip`)?.focus();toast('Ordem ajustada.')}});
let draggedTask=null;
document.addEventListener('dragstart',event=>{const handle=event.target.closest('[data-drag-task]');if(!handle)return;draggedTask=handle.dataset.dragTask;event.dataTransfer.setData('text/plain',draggedTask);event.dataTransfer.effectAllowed='move';handle.closest('.task-line').classList.add('is-dragging')});
document.addEventListener('dragover',event=>{if(draggedTask&&event.target.closest('[data-task-id]')){event.preventDefault();event.dataTransfer.dropEffect='move'}});
document.addEventListener('drop',event=>{const row=event.target.closest('[data-task-id]');if(!draggedTask||!row)return;event.preventDefault();const id=draggedTask;draggedTask=null;const after=event.clientY>row.getBoundingClientRect().top+row.getBoundingClientRect().height/2;if(tx(s=>moveStudyTask(s,id,row.dataset.taskId,after))){render();toast('Ordem ajustada.')}});
document.addEventListener('dragend',()=>{draggedTask=null;document.querySelectorAll('.is-dragging').forEach(x=>x.classList.remove('is-dragging'))});

function personalRepertoire(){return `<div class="page-title"><div><p class="eyebrow">Meu estudo</p><h1>Meu repertório</h1><p class="muted">Guarde as músicas que você quer tocar e leve-as para sua semana.</p></div><button class="button primary" data-action="song-new">+ Adicionar música</button></div><div class="repertoire-filters"><label for="song-search">Buscar música ou artista<input type="search" id="song-search" placeholder="Qual música?" autocomplete="off"></label><label for="song-filter">Etiqueta<select id="song-filter"><option value="">Todas</option>${Object.entries(STUDY_LABELS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></label></div><div id="personal-songs">${songList()}</div>${!account?'<details class="card study-course-support"><summary>Repertório do curso Do Zero às Músicas Favoritas</summary><p class="muted">O catálogo didático e seus diagramas continuam disponíveis separadamente.</p><a class="button" href="./repertorio/index.html" data-repertoire-entry>Abrir catálogo do curso →</a></details>':''}`}
function musicLinks(song){return song?.links?.length?`<ul class="music-links">${song.links.map((url,i)=>`<li><a href="${esc(safeMusicLink(url))}" target="_blank" rel="noopener noreferrer">${song.links.length===1?'Abrir música':'Abrir link '+(i+1)} <small>· ${esc(new URL(url).hostname.replace(/^www\./,''))} ↗</small></a></li>`).join('')}</ul>`:''}
function songList(query='',label=''){
 const all=state.repertoire||[],q=query.toLocaleLowerCase('pt-BR');const songs=all.filter(s=>(!label||s.label===label)&&`${s.title} ${s.artist}`.toLocaleLowerCase('pt-BR').includes(q));
 if(!songs.length)return `<section class="card study-empty"><h2>${all.length?'Nenhuma música neste filtro.':'Seu repertório começa com uma música.'}</h2><p class="muted">${all.length?'Mude a busca ou a etiqueta.':'Pode ser uma música do seu show, uma que você está aprendendo ou uma composição sua.'}</p>${all.length?'':'<button class="button" data-action="song-new">Adicionar minha primeira música</button>'}</section>`;
 return `<div class="personal-song-grid">${songs.map(s=>`<article class="card personal-song" data-song="${esc(s.id)}"><div class="row"><h2>${esc(s.title)}</h2><button class="text-button" data-action="song-edit" data-id="${esc(s.id)}">Editar</button></div>${s.artist?`<p class="muted">${esc(s.artist)}</p>`:''}${musicLinks(s)}${s.notes?`<p class="personal-notes">${esc(s.notes)}</p>`:''}<label class="small" for="label-${esc(s.id)}">Meu momento nesta música</label><select class="label-select label-${s.label}" id="label-${esc(s.id)}" data-song-label="${esc(s.id)}">${Object.entries(STUDY_LABELS).map(([k,v])=>`<option value="${k}" ${k===s.label?'selected':''}>${esc(v)}</option>`).join('')}</select><button class="button" data-action="song-plan" data-id="${esc(s.id)}">Adicionar ao meu estudo →</button></article>`).join('')}</div><p class="small muted">As etiquetas são suas. Você pode mudar quando quiser; elas não avaliam automaticamente o que você toca.</p>`;
}
function songDialog(id=null){const s=(state.repertoire||[]).find(x=>x.id===id);showDialog(s?'Editar música':'Adicionar música',`<form id="song-form" data-id="${esc(s?.id||'')}"><label for="song-title">Música ou composição</label><input id="song-title" name="title" maxlength="160" required value="${esc(s?.title||'')}"><label for="song-artist">Artista (opcional)</label><input id="song-artist" name="artist" maxlength="160" value="${esc(s?.artist||'')}"><label for="song-links">Links (opcionais, um por linha)</label><textarea id="song-links" name="links" placeholder="https://…">${esc(s?.links.join('\n')||'')}</textarea><label for="song-label">Meu momento</label><select id="song-label" name="label">${Object.entries(STUDY_LABELS).map(([k,v])=>`<option value="${k}" ${k===(s?.label||'red')?'selected':''}>${esc(v)}</option>`).join('')}</select><label for="song-notes">O que quero trabalhar (opcional)</label><textarea id="song-notes" name="notes" maxlength="2000" placeholder="Ex.: entrada do refrão, levada e final.">${esc(s?.notes||'')}</textarea><div class="actions">${s?`<button class="text-button" type="button" data-action="song-remove" data-id="${esc(s.id)}">Remover música</button>`:''}<button class="button primary" type="submit">Guardar música</button></div></form>`)}
function planDialog(date=today(),id=null,seed={}){
 const s=id?state.sessions.find(x=>x.id===id):null,personal=s?.personal||seed.personal||{title:'',area:'Repertório',label:'red',notes:'',repertoireId:null};
 const modules=availableModules(),mid=s?.moduleId!=='personal'&&s?.moduleId?s.moduleId:(modules.find(x=>x.id===moduleId)?.id||modules[0]?.id),m=mod(mid);
 const kind=s?(s.moduleId==='personal'?'personal':'course'):(seed.kind||(['modulo','curso'].includes(route)?'course':'personal'));
 showDialog(s?'Editar meu estudo':'Planejar meu estudo',`<form id="plan-form" data-id="${esc(id||'')}"><label for="plan-kind">O que vou estudar?</label><select id="plan-kind" name="kind" ${s?'disabled':''}><option value="personal" ${kind==='personal'?'selected':''}>Meu estudo livre</option><option value="course" ${kind==='course'?'selected':''} ${modules.length?'':'disabled'}>Apoio de um curso</option></select><fieldset id="plan-personal"><label for="plan-area">Área de estudo</label><input id="plan-area" name="area" list="study-areas" maxlength="60" required value="${esc(personal.area)}"><datalist id="study-areas">${STUDY_AREAS.map(a=>`<option value="${esc(a)}">`).join('')}</datalist><label for="plan-song">Música do meu repertório (opcional)</label><select id="plan-song" name="song"><option value="">Sem música vinculada</option>${(state.repertoire||[]).map(x=>`<option value="${esc(x.id)}" ${x.id===personal.repertoireId?'selected':''}>${esc(x.title)}</option>`).join('')}</select><label for="plan-title">O que vou praticar?</label><input id="plan-title" name="title" maxlength="160" required placeholder="Ex.: tocar três músicas do meu show" value="${esc(personal.title)}"><label for="plan-label">Meu momento neste estudo</label><select id="plan-label" name="label">${Object.entries(STUDY_LABELS).map(([k,v])=>`<option value="${k}" ${k===personal.label?'selected':''}>${esc(v)}</option>`).join('')}</select><label for="plan-notes">Meu foco (opcional)</label><textarea id="plan-notes" name="notes" maxlength="2000" placeholder="Uma coisa para lembrar na hora de tocar.">${esc(personal.notes)}</textarea></fieldset><fieldset id="plan-course"><p class="small muted">Assista às aulas e use o guia como apoio para praticar.</p><label for="plan-module">Módulo</label><select id="plan-module" name="module" ${s?'disabled':''}>${modules.map(x=>`<option value="${esc(x.id)}" ${x.id===mid?'selected':''}>${esc(courseOf(x.id).title)} · ${esc(x.title)}</option>`).join('')}</select><label for="plan-practice">Prática</label><select id="plan-practice" name="practice" ${s?'disabled':''}>${(m?.practices||[]).map(x=>`<option value="${esc(x.id)}" ${x.id===s?.practiceId?'selected':''}>${esc(x.displayTitle||x.title)}</option>`).join('')}</select></fieldset><div class="form-row"><div><label for="plan-date">Dia</label><input id="plan-date" name="date" type="date" required value="${esc(s?.date||date)}"></div><div><label for="plan-time">Horário</label><input id="plan-time" name="time" type="time" required value="${esc(s?.time||seed.time||'19:00')}"></div></div><label for="plan-minutes">Tempo disponível (minutos)</label><input id="plan-minutes" name="minutes" type="number" min="1" max="180" required value="${s?.minutes||seed.minutes||15}"><div class="actions">${s?`<button class="text-button" type="button" data-action="remove-plan" data-id="${esc(s.id)}">Remover horário</button>`:''}<button class="button primary" type="submit">Guardar estudo</button></div></form>`);
 const chooseKind=()=>{const isPersonal=$('#plan-kind').value==='personal';for(const [sel,enabled] of [['#plan-personal',isPersonal],['#plan-course',!isPersonal]]){$(sel).hidden=!enabled;$(sel).disabled=!enabled;}};$('#plan-kind').onchange=chooseKind;chooseKind();
 $('#plan-module').onchange=e=>{$('#plan-practice').innerHTML=(mod(e.target.value)?.practices||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.displayTitle||x.title)}</option>`).join('')};
 $('#plan-song').onchange=e=>{const song=(state.repertoire||[]).find(x=>x.id===e.target.value);if(song){$('#plan-title').value='Praticar '+song.title;$('#plan-area').value='Repertório';$('#plan-notes').value=song.notes;$('#plan-label').value=song.label;}};
}
function submitStudyPlan(f){const v=new FormData(f),old=state.sessions.find(x=>x.id===f.dataset.id),isPersonal=old?old.moduleId==='personal':v.get('kind')==='personal';const input={date:v.get('date'),time:v.get('time'),minutes:Number(v.get('minutes'))};if(isPersonal)input.personal={title:v.get('title'),area:v.get('area'),notes:v.get('notes'),label:v.get('label'),repertoireId:v.get('song')||null};const ok=old?tx(x=>rescheduleSession(x,old.id,input)):isPersonal?tx(x=>planPersonalSession(x,{...input,id:makeId('plan')})):tx(x=>planSession(x,{id:makeId('plan'),courseId:recordCourseId(v.get('module')),moduleId:v.get('module'),practiceId:v.get('practice'),...input}));if(ok){closeDialog();render();toast(saveMessage('Estudo guardado. Você pode ajustar quando precisar.','Estudo disponível só nesta sessão.'))}}
function personalPracticeView(){const r=currentRun(),p=currentPractice();return `<div class="timer-bar"><div><div class="timer" id="timer">${fmtTime(Math.max(0,studyRemaining()))}</div><div class="timer-label" id="timer-label">deste bloco de estudo</div></div><button class="button" data-action="timer" id="timer-toggle">${running?'Pausar':'Iniciar relógio'}</button><button class="text-button timer-reset" data-action="reset-study-clock">Reiniciar</button><button class="text-button exit" data-action="save-exit">Guardar e sair</button></div><div class="crumb"><a href="#hoje">Meu estudo</a><span>/</span><span>${esc(p.personal.area)}</span></div><article class="practice-sheet personal-practice"><p class="eyebrow">Meu treino · ${esc(p.personal.area)}</p><h1>${esc(p.title)}</h1>${labelBadge(p.personal.label)}<p class="instruction personal-notes">${esc(p.personal.notes||'Escolha um foco pequeno e toque com atenção. Ao terminar, registre o que quer retomar.')}</p>${p.song?`<section class="personal-song-reference"><h2>${esc(p.song.title)}</h2>${musicLinks(p.song)}</section>`:''}<button class="button primary" data-action="finish">Registrar como foi</button><p class="small muted">Seu registro mostra sua percepção. Você escolhe quando repetir ou mudar o foco.</p></article><div class="tools"><button data-action="tool" data-tool="metro" aria-pressed="${tool==='metro'}">◷ Metrônomo</button></div><div id="tool-content"></div>`}
document.addEventListener('input',e=>{if(e.target.id==='song-search')$('#personal-songs').innerHTML=songList(e.target.value,$('#song-filter').value)});
document.addEventListener('change',e=>{if(e.target.id==='song-filter')$('#personal-songs').innerHTML=songList($('#song-search').value,e.target.value);if(e.target.dataset.songLabel){if(tx(s=>labelRepertoireSong(s,e.target.dataset.songLabel,e.target.value))){const q=$('#song-search')?.value||'',filter=$('#song-filter')?.value||'';$('#personal-songs').innerHTML=songList(q,filter);toast(saveMessage('Etiqueta guardada.','Etiqueta disponível só nesta sessão.'))}}});
document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const a=b.dataset.action;if(a==='song-new')songDialog();else if(a==='song-edit')songDialog(b.dataset.id);else if(a==='song-plan'){const song=(state.repertoire||[]).find(x=>x.id===b.dataset.id);if(song){const id=makeId('plan');if(tx(s=>planPersonalSession(s,{id,personal:{title:'Praticar '+song.title,area:'Repertório',notes:song.notes,label:song.label,repertoireId:song.id}}))){go('hoje');toast(saveMessage('Música adicionada ao meu estudo.','Tarefa só nesta tela.'))}} }else if(a==='song-remove'){const id=b.dataset.id,song=(state.repertoire||[]).find(x=>x.id===id);showDialog('Remover esta música?',`<p>${esc(song?.title)} sairá da sua lista. Os estudos e registros que você já criou continuam guardados.</p><div class="actions"><button class="button" data-action="close-dialog">Cancelar</button><button class="button" data-action="song-remove-confirm" data-id="${esc(id)}">Remover música</button></div>`)}else if(a==='song-remove-confirm'){if(tx(s=>removeRepertoireSong(s,b.dataset.id))){closeDialog();render();toast(saveMessage('Música removida. Seus estudos foram preservados.','Mudança disponível só nesta sessão.'))}}});
document.addEventListener('submit',e=>{if(e.target.id!=='song-form')return;e.preventDefault();const f=e.target,v=new FormData(f);if(tx(s=>saveRepertoireSong(s,{id:f.dataset.id||makeId('song'),title:v.get('title'),artist:v.get('artist'),notes:v.get('notes'),label:v.get('label'),links:v.get('links').split('\n')}))){closeDialog();render();toast(saveMessage('Música guardada no repertório.','Música disponível só nesta sessão.'))}});

function catalog(){return `<div class="page-title"><div><p class="eyebrow">Cursos Criasom</p><h1>Escolha seu caminho.</h1><p class="muted">${account?'O catálogo completo fica visível. Entre nos cursos liberados para sua conta.':'Neste piloto: Penta, módulos 3, 4 e 5; Harmonia I, Arpejos.'}</p></div></div><div class="catalog">${data.courses.map(c=>`<article class="course-card"><img loading="lazy" src="${asset(c.cover)}" alt="Capa: ${esc(c.title)}"><div class="body"><h2>${esc(c.title)}</h2><p>${esc(c.summary)}</p>${data.modules.some(m=>m.courseId===c.id)&&(!account||account.has('course:'+c.id))?`<a class="button primary" href="#curso/${c.id}">Entrar no curso →</a>`:`<button class="button" data-action="course-info" data-id="${esc(c.id)}">${account&&!account.has('course:'+c.id)?'Conhecer este curso':'Ver apresentação'}</button>`}</div></article>`).join('')}</div><section class="card agd"><p class="eyebrow">Academia Guitarra Desbloqueada</p><h2>Um espaço para tocar junto.</h2><p class="muted">Desafios, mentorias e devolutivas em um espaço separado dos cursos. ${account?'Esta área será conectada à conta em uma próxima etapa.':'Explore a demonstração local da Academia.'}</p><a class="button" href="#academia">Ver a Academia →</a></section>`;}
function course(){const id=decodeURIComponent(location.hash.split('/')[1]||courseOf().id);const c=data.courses.find(x=>x.id===id)||courseOf();const modules=data.moduleCatalog.filter(m=>m.courseId===c.id);return `<div class="crumb"><a href="#cursos">Cursos</a><span>/</span><span>${esc(c.title)}</span></div><div class="page-title"><div><p class="eyebrow">${esc(c.title)}</p><h1>Qual módulo você está estudando?</h1><p class="muted">Seu guia de prática fica dentro de cada módulo.</p></div></div><div class="card"><ol class="module-nav">${modules.map(m=>`<li class="module-row"><span class="module-num">${m.number?String(m.number).padStart(2,'0'):'♪'}</span><div class="grow"><h3>${esc(m.title)}</h3><p>${m.lessonCount} aulas · ${mod(m.id)?'Práticas disponíveis no piloto':'Guia ainda não preparado neste piloto'}</p></div>${mod(m.id)?`<a class="button" href="#modulo/${esc(m.id)}">Abrir →</a>`:''}</li>`).join('')}</ol></div>`;}
function moduleView(){const m=mod(moduleId),c=courseOf();if(m.guide)return moduleGuide(m);return `<div class="crumb"><a href="#cursos">Cursos</a><span>/</span><a href="#curso/${c.id}">${esc(c.title)}</a><span>/</span><span>${esc(moduleLabel(m))}</span></div><div class="page-title"><div><p class="eyebrow">Seu guia de prática</p><h1>${esc(m.title)}</h1><p class="muted">${esc(m.goal)}</p></div></div><div class="two-col"><section class="card"><div class="row"><h2 class="no-margin">O que praticar</h2><span class="pill">${m.practices.length} propostas</span></div><ol class="practice-list">${m.practices.map((p,i)=>{const registered=state.practices.some(r=>r.moduleId===m.id&&r.practiceId===p.id&&r.attempts.length);return `<li><span class="number">${String(i+1).padStart(2,'0')}</span><div class="grow"><h3>${esc(p.displayTitle||p.title)}${p.optional?' · opcional':''}</h3><p>${registered?'Já tem um registro seu':esc(p.objective)}</p></div><button class="button" data-action="begin" data-practice="${esc(p.id)}" data-module="${esc(m.id)}">Praticar →</button></li>`}).join('')}</ol><p class="small muted" style="margin:20px 0 0">Você pode repetir e explorar. O registro mostra sua percepção; não avalia automaticamente o que você toca.</p></section><aside class="stack"><section class="card"><h2>Rever uma aula</h2><ul class="lesson-list">${m.lessons.map(l=>`<li>${lessonLink(l)}<p>${esc(l.focus||'Veja a demonstração e experimente uma parte de cada vez.')}</p></li>`).join('')}</ul><p class="small muted" style="margin:16px 0 0">As videoaulas abrem no Hotmart Club, com seu acesso ao curso.</p></section><section class="card"><h3>Coloque o estudo na sua semana.</h3><p class="small muted">Escolha um horário possível e ajuste quando precisar.</p><button class="button" data-action="plan">Planejar uma prática</button></section></aside></div>`;}
function practiceView(){const r=currentRun(),p=currentPractice();if(r.moduleId==='personal')return personalPracticeView();const step=p.steps[Math.min(r.stepIndex,p.steps.length-1)];return `<div class="timer-bar"><div><div class="timer" id="timer">${fmtTime(Math.max(0,studyRemaining()))}</div><div class="timer-label" id="timer-label">deste bloco de estudo</div></div><button class="button" data-action="timer" id="timer-toggle">${running?'Pausar':'Iniciar relógio'}</button><button class="text-button timer-reset" data-action="reset-study-clock">Reiniciar</button><button class="text-button exit" data-action="save-exit">Guardar e sair</button></div><div class="crumb"><a href="#modulo/${esc(r.moduleId)}">${esc(mod(r.moduleId).number?moduleLabel(mod(r.moduleId))+' · '+mod(r.moduleId).title:mod(r.moduleId).title)}</a><span>/</span><span>${esc(p.displayTitle||p.title)}</span></div><article class="practice-sheet"><div class="step-head"><span class="eyebrow no-margin">Passo ${r.stepIndex+1} de ${p.steps.length}</span><div class="step-dots" aria-hidden="true">${p.steps.map((_,i)=>`<i class="step-dot ${i<=r.stepIndex?'current':''}"></i>`).join('')}</div></div><h1>${esc(step.title)}</h1><p class="instruction">${esc(step.instruction)}</p>${courseSupport(p,r,step)}${p.prerequisite&&r.stepIndex===0?`<p class="small muted">Antes: ${esc(p.prerequisite)}</p>`:''}<details><summary>Ficou difícil? Simplifique por aqui.</summary><p>${esc(p.help)}</p></details>${p.ifReady?`<details data-practice-deepen><summary>Ficou fácil? Aprofunde este treino.</summary><p>${esc(p.ifReady)}</p></details>`:''}<div class="step-actions"><button class="text-button" data-action="step-prev" ${r.stepIndex===0?'disabled':''}>← Anterior</button><button class="button primary" data-action="${r.stepIndex===p.steps.length-1?'finish':'step-next'}">${r.stepIndex===p.steps.length-1?'Registrar como foi':'Próximo passo →'}</button></div></article><div class="tools" aria-label="Apoios de prática"><button data-action="tool" data-tool="metro" aria-pressed="${tool==='metro'}">◷ Metrônomo</button>${p.backingTrackId?`<button data-action="tool" data-tool="backing" aria-pressed="${tool==='backing'}">♫ Backing</button>`:''}${p.pages?.some(pg=>data.pages[pg])?`<button data-action="book" data-page="${step.pageKey||step.printedPage||p.pages[0]}">▤ Diagramas da prática</button>`:''}${p.positionIds?.length?`<button data-action="tool" data-tool="map" aria-pressed="${tool==='map'}">⌁ Mapa das notas</button>`:''}</div><div id="tool-content"></div><div class="row wrap"><button class="text-button" data-action="finish">Já deu por hoje? Registrar agora</button>${p.lessonIds.map(id=>lessonLink(mod(r.moduleId).lessons.find(l=>l.id===id))).join(' · ')}</div>${communityEntry(r.moduleId,p.id)}`}
function progress(){const records=visiblePractices().flatMap(r=>r.attempts.map((a,i)=>({r,a,duration:Math.max(0,a.elapsedSeconds-(r.attempts[i-1]?.elapsedSeconds||0)),isLast:i===r.attempts.length-1}))).sort((x,y)=>(y.a.recordedAt||'').localeCompare(x.a.recordedAt||''));return `<div class="page-title"><div><p class="eyebrow">Minha evolução</p><h1>Veja o que está construindo.</h1><p class="muted">Compare suas próprias tentativas. Cada observação ajuda a escolher o próximo passo.</p></div></div><section class="card">${records.length?`<ul class="history">${records.map(({r,a,duration,isLast})=>`<li><div class="row wrap"><h3>${esc(r.personal?.title||practice(r.practiceId,r.moduleId)?.title||r.practiceId)}</h3><span class="small muted">${a.recordedAt?new Date(a.recordedAt).toLocaleDateString('pt-BR'):''} · ${fmtTime(duration)} neste registro</span></div><p>${{complete:'Ficou confortável',partial:'Conseguiu uma parte',repeat:'Quer repetir'}[a.outcome]}</p>${a.selfReport?`<p class="reflection">“${esc(a.selfReport)}”</p>` : ''}${isLast&&r.outcome!=='complete'?`<button class="text-button" data-action="begin" data-run="${esc(r.id)}" data-practice="${esc(r.practiceId)}" data-module="${esc(r.moduleId)}">Retomar este ponto →</button>`:''}</li>`).join('')}</ul>`:'<h2>Seu primeiro registro começa tocando.</h2><p class="muted">Depois da prática, conte o que ficou mais fácil e o que quer repetir.</p><a class="button primary" href="#hoje">Escolher minha prática →</a>'}</section>`}

function howTo(){return `<div class="page-title"><div><p class="eyebrow">Como estudar</p><h1>Menos preparação. Mais guitarra.</h1><p class="muted">Monte uma rotina possível para o dia que você tem.</p></div></div><div class="guide-grid">${[
 ['Escolha um horário real.','Escolha uma área: repertório, técnica, improvisação ou outra. Comece com 10 ou 15 minutos em dois ou três dias possíveis. Evite preencher toda a semana de uma vez.','Ir para minha semana','#semana'],
 ['Deixe tudo ao alcance.','Guitarra afinada, som em um volume confortável e uma tarefa escolhida. Se puder, silencie as notificações. Se não puder, faça um bloco mais curto.','Escolher uma prática','#hoje'],
 ['Assista, pause e experimente.','Na aula, observe uma ideia. Pause o vídeo e toque essa parte. Use o guia do módulo antes, durante ou depois da aula.','Ver meu módulo',`#modulo/${moduleId}`],
 ['Monte seu repertório.','Guarde suas músicas e links, escolha uma etiqueta e leve uma delas para sua semana. O catálogo do curso Do Zero tem seu próprio espaço.','Organizar meu repertório','#repertorio'],
 ['Termine sabendo onde voltar.','Registre uma percepção: uma nota mais clara, um pulso mais firme, uma dificuldade específica. Quando não der para terminar, guarde o ponto e retome.','Ver meus registros','#progresso']
 ].map((g,i)=>`<article class="card"><div class="guide-num">0${i+1}</div><h2>${g[0]}</h2><p class="muted">${g[1]}</p><a class="text-button" href="${g[3]}" ${g[3]==='./repertorio/index.html'?'data-repertoire-entry':''}>${g[2]} →</a></article>`).join('')}</div><section class="card" style="margin-top:25px"><h2>Como usar este piloto</h2><ol class="help-list"><li><strong>Meu estudo:</strong> escolha o que quer praticar e reserve seu tempo.</li><li><strong>No treino:</strong> veja uma instrução por vez. Os apoios ficam logo abaixo.</li><li><strong>Minha semana:</strong> adicione um horário e ajuste quando a vida mudar.</li><li><strong>Meu repertório:</strong> adicione músicas, links e etiquetas. Use Adicionar ao meu estudo para planejar o treino.</li><li><strong>Guardar e sair:</strong> mantém o passo e o tempo para a próxima visita.</li></ol><p class="small muted">${account?'O progresso confirmado fica na sua conta no banco local de teste. Comunidade e favoritos do Repertório ainda não estão conectados.':'Os dados ficam neste navegador. Não há login, sincronização entre aparelhos ou comunidade conectada nesta versão.'}</p><button class="button" data-action="visual-manual">Como usar este piloto</button></section>`}
function showDialog(title,html,cls=''){lastFocused=document.activeElement;$('#dialog').className=cls;$('#dialog-content').innerHTML=`<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon" data-action="close-dialog" aria-label="Fechar janela">×</button></div>${html}`;if(!$('#dialog').open)$('#dialog').showModal()}
function closeDialog(){$('#dialog').close();$('#dialog-content').innerHTML='';lastFocused?.focus?.()}
$('#dialog').addEventListener('close',()=>lastFocused?.focus?.());
function begin(pid,rid=null,session=null){
 if(account&&(!allowedModule(moduleId)||!practice(pid,moduleId))){toast('Esta prática não está liberada para sua conta.');return;}
 pauseTimer();stopSounds();
 const existing=rid?state.practices.find(r=>r.id===rid):recentPractices().find(r=>r.moduleId===moduleId&&r.practiceId===pid&&(r.status==='active'||r.outcome==='partial'||r.outcome==='repeat'));
 const nextRunId=existing?.id||makeId('practice'),clockId=makeId('study');
 if(!tx(s=>{
  const source=existing?s.practices.find(r=>r.id===existing.id):null;
  const carry=source&&source.status==='active'?source.elapsedSeconds-(source.budgetStartSeconds||0):0;
  let next=startStudyClock(s,{id:clockId,minutes:session?.minutes||minutes,carrySeconds:carry,free:moduleId==='personal'&&!session?.minutes});
  if(existing){
   next=resumePractice(next,existing.id);
   if(session){const target=next.sessions.find(x=>x.id===session.id);if(!target||target.status!=='planned'||target.moduleId!==existing.moduleId||(target.practiceId&&target.practiceId!==pid))throw Error('Este horário mudou. Volte à semana e escolha novamente.');next={...next,practices:next.practices.map(r=>r.id===existing.id?{...r,sessionId:target.id}:r)}}
  }else next=startPractice(next,{id:nextRunId,courseId:recordCourseId(moduleId),moduleId,practiceId:pid,sessionId:session?.id||null,minutes:next.studyClock.minutes});
  return next;
 }))return;
 runId=nextRunId;minutes=state.studyClock.minutes;moduleId=currentRun().moduleId;
 if(mod(moduleId).guide)preference('guide.'+moduleId,pid);
 tool=null;location.hash='pratica/'+runId;render();startTimer();
}
function elapsed(){return Math.floor(elapsedBase+(running?(performance.now()-startedAt)/1000:0))}
function studySeconds(){
 const r=currentRun(),liveDelta=running&&r?Math.max(0,elapsed()-r.elapsedSeconds):0;
 return state.studyClock?Math.max(0,totalPracticeSeconds(state)+liveDelta-state.studyClock.baselineSeconds):r?Math.max(0,(running?elapsed():r.elapsedSeconds)-(r.budgetStartSeconds||0)):0;
}
function studyRemaining(){return (state.studyClock?.minutes||currentRun()?.minutes||minutes)*60-studySeconds()}
function studyClockSummary(){if(state.studyClock?.free)return `<p class="small muted study-clock-summary">Tempo livre · ${fmtTime(studySeconds())} estudados. <button class="text-button" data-action="custom-time">Definir duração</button></p>`;return state.studyClock?`<p class="small muted study-clock-summary">Sessão: ${fmtTime(studySeconds())} estudados · meta de ${state.studyClock.minutes} min. Trocar de prática mantém o relógio.</p>`:''}
function chooseStudyMinutes(value){
 const next=Math.min(180,Math.max(1,Number(value)||10));
 if(state.studyClock&&!tx(s=>setStudyClockMinutes(s,next)))return;
 minutes=next;render();
}
function saveTimerProgress(){
 if(!running||!currentRun())return true;
 const sec=elapsed();lastSavedSecond=sec;
 return tx(s=>updatePractice(s,runId,{elapsedSeconds:sec}));
}
function startTimer(){
 const r=currentRun();if(!r||r.status!=='active'||running)return;
 if(!state.studyClock&&!tx(s=>startStudyClock(s,{id:makeId('study'),minutes:r.minutes,carrySeconds:r.elapsedSeconds-(r.budgetStartSeconds||0)})))return;
 elapsedBase=r.elapsedSeconds;startedAt=performance.now();lastSavedSecond=r.elapsedSeconds;running=true;
 clearInterval(timerInterval);timerInterval=setInterval(()=>{paintTimer();if(elapsed()-lastSavedSecond>=5&&!saveTimerProgress()){pauseTimer(false);stopSounds()}},250);paintTimer();
}
function pauseTimer(save=true){
 if(!running)return;
 const sec=elapsed();running=false;elapsedBase=sec;clearInterval(timerInterval);timerInterval=null;
 if(save&&runId)tx(s=>updatePractice(s,runId,{elapsedSeconds:sec}));paintTimer();
}
function paintTimer(){
 if(!currentRun()||!$('#timer'))return;
 const remaining=studyRemaining(),spent=studySeconds();
 $('#timer').textContent=fmtTime(state.studyClock?.free?spent:Math.abs(remaining));
 $('#timer-label').textContent=`${state.studyClock?.free?'tempo livre · ':remaining<0?'além da meta · ':''}${fmtTime(spent)} estudados${running?'':' · pausado'}`;
 $('#timer-toggle').textContent=running?'Pausar':'Iniciar relógio';
}
function resetStudyClockDialog(){
 showDialog('Começar um novo tempo de estudo?',`<p>Isso zera apenas o relógio da sessão. Suas práticas e seu progresso continuam guardados.</p><form id="reset-clock-form"><label for="reset-clock-minutes">Minutos para esta sessão</label><input id="reset-clock-minutes" type="number" min="1" max="180" required value="${state.studyClock?.minutes||minutes}"><div class="actions"><button class="text-button" type="button" data-action="close-dialog">Cancelar</button><button class="button primary" type="submit">Reiniciar relógio</button></div></form>`);
}
function confirmStudyClockReset(){
 const next=Math.min(180,Math.max(1,Number($('#reset-clock-minutes').value)||10)),wasRunning=running;
 pauseTimer();const id=makeId('study');
 if(tx(s=>startStudyClock(s,{id,minutes:next},{restart:true}))){minutes=next;closeDialog();paintTimer();if(wasRunning)startTimer()}
}

function stopMetro(){clearInterval(metroInterval);metroInterval=null;metroRunning=false;if(audioCtx)audioCtx.suspend().catch(()=>{});document.querySelectorAll('.beat-lights i').forEach(x=>x.classList.remove('on'));if($('#metro-toggle'))$('#metro-toggle').textContent='Ouvir metrônomo';}
function stopSounds(){stopMetro();const a=$('#backing-audio');if(a)a.pause();const frame=$('#yt-frame');if(frame)frame.remove();}
async function toggleMetro(){if(metroRunning){stopMetro();return;}try{const backing=$('#backing-audio');if(backing)backing.pause();$('#yt-frame')?.remove();audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();await audioCtx.resume();metroRunning=true;nextBeat=audioCtx.currentTime+.04;beat=0;const schedule=()=>{while(metroRunning&&nextBeat<audioCtx.currentTime+.1){const t=nextBeat;const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();osc.frequency.value=beat%4===0?1150:820;gain.gain.setValueAtTime(.13,t);gain.gain.exponentialRampToValueAtTime(.001,t+.055);osc.connect(gain).connect(audioCtx.destination);osc.start(t);osc.stop(t+.06);const light=beat%4;setTimeout(()=>{if(metroRunning)document.querySelectorAll('.beat-lights i').forEach((el,i)=>el.classList.toggle('on',i===light))},Math.max(0,(t-audioCtx.currentTime)*1000));beat++;nextBeat+=60/bpm;}};schedule();metroInterval=setInterval(schedule,25);$('#metro-toggle').textContent='Parar metrônomo';}catch{stopMetro();toast('O navegador não liberou o áudio. Tente novamente após tocar na tela.')}}
function renderTool(){const target=$('#tool-content');if(!target)return;if(tool==='metro'){target.innerHTML=`<section class="tool-panel"><div class="row"><h3>Metrônomo</h3><button class="text-button" data-action="close-tool">Fechar</button></div><div class="beat-lights" aria-hidden="true"><i></i><i></i><i></i><i></i></div><label class="tempo" for="bpm">Andamento <input type="number" id="bpm" min="30" max="220" value="${bpm}"> BPM</label><button class="button" data-action="metro" id="metro-toggle">Ouvir metrônomo</button><p class="small muted" style="margin:15px 0 0">Comece confortável. O primeiro pulso tem um som mais agudo.</p></section>`;$('#bpm').onchange=e=>{bpm=Math.min(220,Math.max(30,Number(e.target.value)||60));e.target.value=bpm;if(metroRunning){stopMetro();toggleMetro()}};}else if(tool==='backing'){renderBacking(target);}else if(tool==='map'){target.innerHTML=`<section class="tool-panel"><div class="row"><h3>Mapa desta prática</h3><button class="text-button" data-action="close-tool">Fechar</button></div><p class="small muted" style="margin-top:12px">Afinação padrão. A corda mais grossa está embaixo.</p>${fretboard(currentPractice().positionIds)}</section>`}else target.innerHTML='';}
function fretboard(ids){const colors={green:'#287655',yellow:'#a17615',blueStart:'#2469a3',blueTarget:'#2469a3',orange:'#ae5f23'};const notes=ids.flatMap(id=>(Array.isArray(data.positions[id])?data.positions[id]:[data.positions[id]]).filter(Boolean).map(n=>({...n,color:colors[id]||'#287655'})));return `<div class="fretboard"><svg viewBox="0 0 610 240" role="img" aria-label="${esc(notes.map(n=>`${n.note}: corda ${n.string}, casa ${n.fret}`).join('; '))}">${[1,2,3,4,5,6].map(s=>`<line class="wire" x1="56" y1="${30+s*27}" x2="590" y2="${30+s*27}" stroke-width="${.6+s*.25}"/><text x="18" y="${34+s*27}" font-size="12">${s}ª</text>`).join('')}${[4,5,6,7,8,9,10].map((f,i)=>`<line class="wire" x1="${60+i*84}" y1="52" x2="${60+i*84}" y2="197" opacity=".4"/><text x="${102+i*84}" y="225" font-size="12" text-anchor="middle">${f}</text>`).join('')}${notes.map(n=>`<g class="note"><circle cx="${102+(n.fret-4)*84}" cy="${30+n.string*27}" r="13" fill="${n.color}"/><text x="${102+(n.fret-4)*84}" y="${34+n.string*27}" text-anchor="middle">${esc(n.note)}</text></g>`).join('')}</svg></div><p class="small muted">${notes.some(n=>n.bendFrom)?'A casa 9 é referência de altura. No bend, o dedo continua na casa 7.':'Siga a ordem da instrução acima. O desenho mostra as posições.'}</p>`}
function openBook(page){bookPages=(currentPractice()?.pages||[]).filter(pg=>data.pages[pg]);if(!bookPages.length){toast('As páginas desta prática ainda não estão disponíveis no piloto.');return}selectedBookPage=bookPages.find(pg=>String(pg)===String(page))||bookPages[0];bookZoom=100;showDialog('Apostila',`<div class="book-controls"><button class="button" data-action="book-prev">← Página</button><button class="button" data-action="book-next">Página →</button><button class="icon" data-action="zoom-out" aria-label="Diminuir zoom">−</button><span id="zoom-label">100%</span><button class="icon" data-action="zoom-in" aria-label="Aumentar zoom">+</button></div><p class="small muted">Pode estudar com a apostila aberta. Feche esta janela para voltar à prática.</p><div class="book-scroll"><img id="book-image" src="${asset(data.pages[selectedBookPage].file)}" alt="Página da apostila"></div>`,'book-dialog');paintBook();}
function paintBook(){const p=data.pages[selectedBookPage],label=p.label||`p. ${selectedBookPage}`;$('#dialog-title').textContent=`Apostila · ${label}`;$('#book-image').src=asset(p.file);$('#book-image').alt=`${courseOf().title} · ${label}: ${p.title}`;$('#book-image').style.width=bookZoom+'%';$('#zoom-label').textContent=bookZoom+'%';document.querySelector('[data-action=book-prev]').disabled=bookPages.indexOf(selectedBookPage)===0;document.querySelector('[data-action=book-next]').disabled=bookPages.indexOf(selectedBookPage)===bookPages.length-1;}
function finishDialog(){pauseTimer();stopSounds();const p=currentPractice();showDialog('Como foi hoje?',`<p>${esc(p.check)}</p><form id="finish-form"><div class="choices"><label><input type="radio" name="outcome" value="complete" required><span>Ficou confortável<small>Posso experimentar o próximo passo.</small></span></label><label><input type="radio" name="outcome" value="partial" required><span>Consegui uma parte<small>Quero continuar deste ponto.</small></span></label><label><input type="radio" name="outcome" value="repeat" required><span>Quero repetir com calma<small>Uma versão menor pode ajudar.</small></span></label></div><label for="reflection">Uma observação para você (opcional)</label><textarea id="reflection" name="reflection" maxlength="300" placeholder="Ex.: o Ré ficou mais claro; quero manter o pulso.">${esc(currentRun()?.selfReport||'')}</textarea><div class="actions"><button class="button primary" type="submit">Guardar meu registro</button></div></form>`)}
function registered(r){if(r.moduleId==='personal'){showDialog(saveMessage('Seu registro está guardado.','Seu registro está só nesta sessão.'),`<div class="feedback-emblem" aria-hidden="true">✓</div><h3>${esc(r.personal.title)}</h3><p>${esc(r.selfReport||'Você deixou um ponto de partida para o próximo estudo.')}</p><p class="small muted">${fmtTime(r.elapsedSeconds)} com o cronômetro. Sua etiqueta continua sendo uma escolha sua.</p><div class="actions"><button class="button primary" data-action="go-home">Voltar ao meu estudo</button><a class="button" href="#semana" data-action="close-dialog">Ver minha semana</a></div>`);return;}if(mod(r.moduleId)?.guide)return registeredGuide(r);const p=practice(r.practiceId,r.moduleId);showDialog(saveMessage('Seu registro está guardado.','Seu registro está só nesta sessão.'),`<div class="feedback-emblem" aria-hidden="true">✓</div><p>${r.outcome==='complete'?esc(p.ifReady||'Você pode experimentar outra prática ou repetir esta com uma nova intenção.'):esc(p.help)}</p>${r.selfReport?`<p class="soft-note">${esc(r.selfReport)}</p>`:''}<p class="small muted">${fmtTime(r.elapsedSeconds)} de cronômetro · progresso pela sua própria percepção.</p><div class="stack">${r.outcome==='complete'&&p.nextPracticeId?`<button class="button primary" data-action="begin" data-practice="${esc(p.nextPracticeId)}" data-module="${esc(r.moduleId)}">Experimentar a próxima prática →</button>`:`<button class="button primary" data-action="plan">Escolher quando voltar</button>`}<button class="button" data-action="go-home">Voltar ao meu espaço</button></div>`)}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const a=b.dataset.action;
 if(a==='minutes')chooseStudyMinutes(b.dataset.minutes)
 else if(a==='custom-time')showDialog('Quanto tempo cabe hoje?',`<form id="minutes-form"><label for="custom-minutes">Minutos disponíveis</label><input id="custom-minutes" type="number" min="1" max="180" required value="${minutes}"><div class="actions"><button class="button primary" type="submit">Usar este tempo</button></div></form>`);
 else if(a==='module')go('cursos');
 else if(a==='begin'){if(b.dataset.module)moduleId=b.dataset.module;closeDialog();begin(b.dataset.practice,b.dataset.run)}
 else if(a==='begin-session'){const s=state.sessions.find(x=>x.id===b.dataset.id);moduleId=s.moduleId;minutes=s.minutes||state.studyClock?.minutes||10;begin(s.practiceId||suggested(moduleId).p.id,null,s)}
 else if(a==='plan')planDialog(b.dataset.date||today());
 else if(a==='edit-plan')planDialog(today(),b.dataset.id);
 else if(a==='remove-plan'){const s=state.sessions.find(x=>x.id===b.dataset.id);if(tx(v=>deleteSession(v,s.id))){closeDialog();render();toast(saveMessage('Horário removido. Seus registros de prática continuam.','Mudança feita só nesta sessão.'))}}
 else if(a==='week-prev'){weekOffset--;render()}
 else if(a==='week-next'){weekOffset++;render()}
 else if(a==='week-today'){weekOffset=0;render()}
 else if(a==='close-dialog')closeDialog();
 else if(a==='timer'){if(running)pauseTimer();else startTimer()}
 else if(a==='reset-study-clock')resetStudyClockDialog()
 else if(a==='save-exit'){pauseTimer();stopSounds();if(account&&!(await account.flush()))return;go(mod(moduleId)?.guide?'modulo/'+moduleId:'hoje');toast(saveMessage('Seu ponto ficou guardado. Volte quando puder.','Seu ponto está só na memória desta sessão.'))}
 else if(a==='step-next'||a==='step-prev'){const wasRunning=running;pauseTimer();const r=currentRun();if(tx(s=>updatePractice(s,r.id,{stepIndex:Math.max(0,Math.min(currentPractice().steps.length-1,r.stepIndex+(a==='step-next'?1:-1)))}))){stopSounds();tool=null;render();if(wasRunning)startTimer()}}
 else if(a==='tool'){stopSounds();tool=tool===b.dataset.tool?null:b.dataset.tool;document.querySelectorAll('.tools [data-tool]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.tool===tool)));renderTool()}
 else if(a==='close-tool'){stopSounds();tool=null;document.querySelectorAll('.tools [data-tool]').forEach(x=>x.setAttribute('aria-pressed','false'));renderTool()}
 else if(a==='metro')toggleMetro();
 else if(a==='book')openBook(b.dataset.page);
 else if(a==='book-prev'||a==='book-next'){selectedBookPage=bookPages[Math.max(0,Math.min(bookPages.length-1,bookPages.indexOf(selectedBookPage)+(a==='book-next'?1:-1)))];paintBook();$('.book-scroll').scrollTo(0,0)}
 else if(a==='zoom-in'||a==='zoom-out'){bookZoom=Math.min(250,Math.max(75,bookZoom+(a==='zoom-in'?25:-25)));paintBook()}
 else if(a==='finish')finishDialog();
 else if(a==='go-home'){closeDialog();go('hoje')}
 else if(a==='guide-lessons'){const review=$('#guide-review');review.open=true;review.querySelector('summary').focus({preventScroll:true});review.scrollIntoView({block:'center',behavior:'instant'})}
 else if(a==='guide-select')guideSelect(b.dataset.practice);
 else if(a==='guide-stage'){const m=mod(moduleId),s=m.guide?.stages.find(s=>s.id===b.dataset.stage);if(s){const current=guideSuggestion(m);const r=recentPractices().find(r=>r.moduleId===m.id&&s.practiceIds.includes(r.practiceId)&&(r.status==='active'||r.outcome!=='complete'));guideSelect(s.practiceIds.includes(current.p.id)?current.p.id:r?.practiceId||s.defaultPracticeId)}}
 else if(a==='guide-return'){closeDialog();moduleId=b.dataset.module;go('modulo/'+moduleId);render()}
 else if(a==='guide-repeat'){closeDialog();moduleId=b.dataset.module;preference('guide.'+moduleId,b.dataset.practice);go('modulo/'+moduleId);render()}
 else if(a==='course-info'){const c=data.courses.find(x=>x.id===b.dataset.id);showDialog(esc(c.title),`<p>${esc(c.summary)}</p><p class="muted">${account&&!account.has('course:'+c.id)?'Este curso não está liberado para sua conta. A apresentação não libera seus materiais.':'O guia deste curso ainda não foi preparado para este teste. A vitrine não libera acesso a materiais.'}</p>${c.salesUrl?`<a class="button" href="${esc(c.salesUrl)}" target="_blank" rel="noopener noreferrer">Conhecer o curso no site ↗</a>`:''}`)}
 else if(a==='agd-info')showDialog('Academia em um espaço próprio',`<p>O estudo dos cursos fica no seu cronograma. Desafios mensais, mentorias e análises ficam na Academia, conforme a assinatura.</p><p class="muted">A proposta de comunidade inclui envios de vídeo com escolha de privacidade e comentários. Esse recurso ainda será testado com contas e permissões reais.</p>`);
 else if(a==='about')showDialog('Um piloto para testar o uso',`<p>Conteúdo real de Penta e Harmonia, organizado em práticas para revisão musical e teste de uso.</p><ul class="help-list small"><li>${account?'Login e progresso conectados ao banco local de teste. Não é uma publicação.':'Registros locais, sem conta ou sincronização entre aparelhos.'}</li><li>${account?'Repertório preservado, com conexão dos favoritos à conta ainda pendente.':'Repertório integrado ao menu: busca de músicas, capotraste e favoritos locais. As orientações e limitações de cada música continuam visíveis.'}</li><li>Catálogo de referência com 11 cursos; Penta 3, 4 e 5 e Harmonia Arpejos disponíveis.</li><li>Sem cobrança, publicação comercial ou acesso de compradores conectado.</li><li>Apostila revisada usada no piloto; ocultar o botão de download não impede cópias.</li><li>Sem análise automática do que você toca.</li></ul><button class="button" data-action="export">Exportar meus registros</button>`);
 else if(a==='export'){const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),state},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='meu-estudo-criasom.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 else if(a==='visual-manual'){showDialog('Como usar este piloto',data.manual?.length?data.manual.map(s=>`<section style="margin-bottom:25px"><h3>${esc(s.title)}</h3><p class="small muted">${esc(s.text)}</p><img style="width:100%;border:1px solid var(--line);border-radius:10px" src="${asset(s.file)}" alt="${esc(s.alt)}"></section>`).join(''):`<ol class="help-list"><li>Em Meu estudo, toque em <strong>Planejar estudo</strong> e escolha sua área e seu foco.</li><li>No topo da prática, você pode pausar o relógio e guardar seu ponto.</li><li>Em Minha semana, use <strong>+ Horário</strong> para reservar seu tempo.</li></ol>`) }
});
document.addEventListener('submit',e=>{const f=e.target;if(!['plan-form','minutes-form','finish-form','youtube-form','reset-clock-form'].includes(f.id))return;e.preventDefault();
 if(f.id==='reset-clock-form')confirmStudyClockReset()
 else if(f.id==='minutes-form'){const value=$('#custom-minutes').value;closeDialog();chooseStudyMinutes(value)}
 else if(f.id==='plan-form')submitStudyPlan(f)
 else if(f.id==='finish-form'){const v=new FormData(f);if(tx(s=>completePractice(s,runId,{outcome:v.get('outcome'),selfReport:v.get('reflection')}))){const r=currentRun();closeDialog();history.replaceState(null,'','#hoje');route='hoje';render();registered(r)}}
 else if(f.id==='youtube-form'){try{const u=new URL($('#youtube-url').value);let id;if(u.protocol!=='https:')throw Error();if(u.hostname==='youtu.be')id=u.pathname.slice(1);else if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname))id=u.searchParams.get('v')||u.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)?.[1];if(!/^[A-Za-z0-9_-]{11}$/.test(id||''))throw Error();stopSounds();$('#video').innerHTML=`<div class="video-wrap"><iframe id="yt-frame" title="Backing escolhida no YouTube" src="https://www.youtube-nocookie.com/embed/${id}?playsinline=1" allow="encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;}catch{toast('Cole um link válido de vídeo do YouTube.')}}
});
function courseOf(mid=moduleId){if(mid==='personal')return {id:'personal',title:'Meu estudo'};return data.courses.find(c=>c.id===(mod(mid)?.courseId||'penta'))||data.courses[0];}
function moduleLabel(m){return m.number?`Módulo ${m.number}`:m.title;}
function recordCourseId(mid=moduleId){if(mid==='personal')return 'personal';return courseOf(mid).id==='penta'?'dap':'dah';}
function lessonLink(l,label){return l?.url?`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(label||l.title)} ↗</a>`:`<span>${esc(label||l?.title||'Aula')} <small class="muted">· link a vincular</small></span>`;}
function renderBacking(target){const p=currentPractice(),ids=p.backingTrackIds||[p.backingTrackId];const tracks=ids.map(id=>data.tracks.find(t=>t.id===id)).filter(Boolean);if(!tracks.length){target.innerHTML='<p class="muted">Esta prática pode ser feita sem backing.</p>';return}const t=tracks[0];target.innerHTML=`<section class="tool-panel"><div class="row"><h3>Backing</h3><button class="text-button" data-action="close-tool">Fechar</button></div>${tracks.length>1?`<label for="backing-select">Escolha o acorde para praticar</label><select id="backing-select">${tracks.map(t=>`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select>`:''}<p id="backing-title" class="muted small" style="margin-top:15px">${esc(t.title)}</p>${p.backingNote?`<p class="small">${esc(p.backingNote)}</p>`:''}<audio id="backing-audio" controls preload="metadata" controlslist="nodownload" src="${asset(t.file)}"></audio><label class="small"><input type="checkbox" id="audio-loop"> Repetir a faixa</label><details><summary>Usar outra backing</summary><form id="youtube-form"><label for="youtube-url">Link do YouTube com tom e harmonia compatíveis</label><input id="youtube-url" type="url" required placeholder="https://www.youtube.com/watch?v=…"><button class="button" type="submit" style="margin-top:12px">Carregar aqui</button></form><div id="video"></div><p class="small muted">O vídeo precisa permitir incorporação.</p></details></section>`;const audio=$('#backing-audio');audio.onplay=()=>{stopMetro();$('#yt-frame')?.remove()};audio.onerror=()=>toast('A faixa não carregou. Seus registros continuam guardados.');$('#audio-loop').onchange=e=>audio.loop=e.target.checked;if($('#backing-select'))$('#backing-select').onchange=e=>{audio.pause();const next=tracks.find(t=>t.id===e.target.value);audio.src=asset(next.file);audio.load();$('#backing-title').textContent=next.title;};}
// START MODULE STAGE GUIDE
// Module-stage guide: module entry only; the practice screen stays shared.
function guideSuggestion(m){
 const saved=preference('guide.'+m.id),recent=recentPractices().filter(r=>r.moduleId===m.id);
 let p=m.practices.find(p=>p.id===saved);
 if(!p){const last=recent[0];p=last?m.practices.find(p=>p.id===(last.status==='active'||last.outcome!=='complete'?last.practiceId:practice(last.practiceId,m.id)?.nextPracticeId))||practice(last.practiceId,m.id):null;}
 p ||= practice(m.guide.defaultPracticeIds[0],m.id)||m.practices[0];
 const latest=recent.find(r=>r.practiceId===p.id);
 return {p,run:latest&&(latest.status==='active'||latest.outcome!=='complete')?latest:null};
}
function guideSelect(pid){
 const m=mod(moduleId);if(!m.guide||!m.practices.some(p=>p.id===pid))return;
 preference('guide.'+m.id,pid);render();
 $('#guide-current-title').focus({preventScroll:true});$('#guide-current').scrollIntoView({block:'start',behavior:'instant'});
}
function guideLessonList(m,ids){return `<ul class="lesson-list">${m.lessons.filter(l=>!ids||ids.includes(l.id)).map(l=>`<li>${lessonLink(l)}<p>${esc(l.focus||'Veja a demonstração e experimente uma parte de cada vez.')}</p></li>`).join('')}</ul>`;}
function moduleGuide(m){
 const c=courseOf(m.id),g=m.guide,{p,run}=guideSuggestion(m),stage=g.stages.find(s=>s.practiceIds.includes(p.id)),index=g.stages.indexOf(stage);
 const variations=stage.practiceIds.filter(id=>id!==p.id).map(id=>practice(id,m.id));
 const practiced=state.practices.some(r=>r.moduleId===m.id&&r.practiceId===p.id&&r.attempts.length);
 return `<div class="module-guide"><div class="crumb"><a href="#cursos">Cursos</a><span>/</span><a href="#curso/${esc(c.id)}">${esc(c.title)}</a><span>/</span><span>${esc(moduleLabel(m))}</span></div>
 <div class="page-title"><div><p class="eyebrow">Seu guia por etapas</p><h1>${esc(m.title)}</h1><p class="muted">${esc(g.intro)}</p></div></div>
 <section class="card guide-current" id="guide-current" aria-labelledby="guide-current-title">
 <p class="eyebrow guide-position">Etapa ${index+1} de ${g.stages.length} · ${esc(stage.title)}</p>
 <h2 id="guide-current-title" tabindex="-1">${esc(p.displayTitle||p.title)}${p.optional?' · opcional':''}</h2><p class="guide-objective">${esc(p.objective)}</p>
 <p class="small muted guide-lesson-reminder">Este treino complementa a videoaula. Antes de tocar, entenda a demonstração. <button class="text-button" data-action="guide-lessons">Ver as aulas deste treino</button></p>
 ${run?`<p class="small muted guide-resume">Seu ponto está guardado: passo ${Math.min(run.stepIndex+1,p.steps.length)} de ${p.steps.length}.</p>`:''}
 <fieldset class="guide-time"><legend>Quanto tempo cabe agora?</legend><div class="time-options">${[10,15,30].map(n=>`<button data-action="minutes" data-minutes="${n}" aria-pressed="${n===minutes}">${n} min</button>`).join('')}<button data-action="custom-time" aria-pressed="${![10,15,30].includes(minutes)}">${![10,15,30].includes(minutes)?`${minutes} min`:'Outro tempo'}</button></div></fieldset>${studyClockSummary()}
 <button class="button primary guide-start" data-action="begin" data-practice="${esc(p.id)}" data-module="${esc(m.id)}" ${run?`data-run="${esc(run.id)}"`:''}>${run?'Continuar de onde parei':practiced?'Praticar novamente':'Começar esta prática'} →</button>
 <p class="small muted guide-repeat">${esc(g.repeatNote)}</p>
 ${variations.length?`<details id="guide-variations"><summary>Outra prática desta etapa</summary><ul class="guide-options">${variations.map(v=>`<li><div><strong>${esc(v.displayTitle||v.title)}</strong>${v.optional?'<span class="small muted">Reforço opcional</span>':''}</div><button class="button" data-action="guide-select" data-practice="${esc(v.id)}">Escolher</button></li>`).join('')}</ul></details>`:''}
 </section>
 <div class="guide-support"><details id="guide-review"><summary>Aulas que explicam este treino</summary>${guideLessonList(m,p.lessonIds)}<p class="small muted">Abrem no Hotmart Club, com seu acesso ao curso. Assista à explicação e à demonstração; volte a elas quando a prática não estiver clara.</p></details><button id="guide-plan" class="text-button" data-action="plan">Colocar este treino na semana</button></div>
 ${communityEntry(m.id,p.id)}
 <details class="card guide-path" id="guide-path"><summary>Ver caminho completo</summary><p class="small muted">Você pode escolher qualquer etapa e voltar quando precisar.</p><ol>${g.stages.map((s,i)=>`<li ${s.id===stage.id?'aria-current="step"':''}><span class="guide-stage-number" aria-hidden="true">${i+1}</span><div class="grow"><h3>${esc(s.title)}</h3><p class="small muted">${esc(s.objective)}</p></div><button class="button" data-action="guide-stage" data-stage="${esc(s.id)}">${s.id===stage.id?'Ver esta etapa':'Escolher etapa'}</button></li>`).join('')}</ol><p class="small muted">${esc(g.guideNote)}</p></details>
 <details class="guide-all-lessons" id="guide-all-lessons"><summary>Todas as aulas do módulo (${m.lessons.length})</summary>${guideLessonList(m)}<p class="small muted">As videoaulas abrem no Hotmart Club.</p></details></div>`;
}
function registeredGuide(r){
 const p=practice(r.practiceId,r.moduleId),next=r.outcome==='complete'?practice(p.nextPracticeId,r.moduleId):null;
 preference('guide.'+r.moduleId,next?.id||p.id);
 render();
 showDialog(saveMessage('Seu registro está guardado.','Seu registro está só nesta sessão.'),`<div class="feedback-emblem" aria-hidden="true">✓</div><p>${esc(r.outcome==='complete'?(p.ifReady||'Você pode experimentar o próximo treino ou repetir este com uma nova intenção.'):p.help)}</p>${r.selfReport?`<p class="soft-note">${esc(r.selfReport)}</p>`:''}<p class="small muted">Seu registro expressa como você se sentiu. As etapas continuam livres para escolher.</p><div class="stack"><button class="button primary" data-action="guide-return" data-module="${esc(r.moduleId)}">Voltar ao guia</button>${next?`<button class="text-button" data-action="guide-repeat" data-module="${esc(r.moduleId)}" data-practice="${esc(p.id)}">Quero repetir esta prática</button>`:''}</div>`);
}

// END MODULE STAGE GUIDE
// START LOCAL COMMUNITY
/* Comunidade do piloto: armazenamento local, sem autenticação nem envio à internet. */
function createCommunityStore(options) {
  'use strict';
  options = options || {};
  const DB_NAME = options.dbName || 'criasom.community.pilot.v1';
  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_SECONDS = 180;
  const SCOPES = ['geral','penta-m05', 'agd'];
  const VISIBILITIES = ['turma', 'equipe'];
  const memoryPosts = new Map();
  const memoryVideos = new Map();
  let db = null;
  let disposed = false;
  let state = { persisted: false, storage: 'memory', warning: '' };

  function fail(message, code = 'validation', cause) {
    const error = new Error(message);
    error.name = 'CommunityStoreError';
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }
  function storageError(error) {
    if (error && error.name === 'CommunityStoreError') return error;
    if (error && error.name === 'QuotaExceededError') {
      return fail('O navegador ficou sem espaço. Esta alteração não foi salva. Remova um vídeo local e tente novamente.', 'quota', error);
    }
    return fail('Não foi possível salvar ou ler a comunidade neste navegador. A alteração não foi confirmada.', 'storage', error);
  }
  function text(value, label, max, required = true) {
    if (typeof value !== 'string') {
      if (!required && value == null) return '';
      throw fail(label + ' precisa ser um texto.');
    }
    const result = value.trim();
    if ((required && !result) || result.length > max) throw fail(label + ' deve ter ' + (required ? '1 a ' : 'até ') + max + ' caracteres.');
    return result;
  }
  function id(value, label = 'Identificador') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw fail(label + ' inválido.');
    return value;
  }
  function newId(prefix) {
    return prefix + '-' + (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  }
  function scopeOf(value) {
    if (!SCOPES.includes(value)) throw fail('Escolha uma comunidade válida.');
    return value;
  }
  function visibilityOf(value) {
    if (!VISIBILITIES.includes(value)) throw fail('Escolha compartilhar com a turma ou com a equipe.');
    return value;
  }
  function authorOf(value) {
    if (!value || typeof value !== 'object' || !['student', 'teacher'].includes(value.role)) throw fail('Autor inválido.');
    return { id: id(value.id, 'Autor'), name: text(value.name, 'Nome', 80), role: value.role };
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function dateOf(value, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('Data inválida.');
    return new Date(value).toISOString();
  }
  function commentOf(value, timestamp) {
    if (!value || typeof value !== 'object') throw fail('Comentário inválido.');
    return {
      id: value.id == null ? newId('comment') : id(value.id),
      author: authorOf(value.author),
      body: text(value.body, 'Comentário', 2000),
      createdAt: dateOf(value.createdAt, timestamp),
      demo: value.demo === true
    };
  }
  function videoOf(metadata, blob) {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw fail('Selecione um arquivo de vídeo.');
    if (blob.size <= 0 || blob.size > MAX_BYTES) throw fail('O vídeo deve ter até 50 MB.');
    if (!/^video\/[a-z0-9.+-]+$/i.test(blob.type || '')) throw fail('O arquivo precisa ser um vídeo reconhecido pelo navegador.');
    const duration = metadata && metadata.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) throw fail('O vídeo deve ter duração de até 3 minutos.');
    return {
      name: text((metadata && metadata.name) || blob.name || 'video', 'Nome do vídeo', 160),
      type: blob.type,
      size: blob.size,
      duration
    };
  }
  function postOf(input, blob, previous) {
    if (!input || typeof input !== 'object') throw fail('Publicação inválida.');
    const now = new Date().toISOString();
    const scope = scopeOf(input.scope);
    const author = authorOf(input.author);
    if (previous && (previous.scope !== scope || previous.author.id !== author.id || previous.author.role !== author.role)) {
      throw fail('A comunidade e o autor de uma publicação não podem ser trocados.');
    }
    if (previous && input.demo != null && Boolean(input.demo) !== previous.demo) throw fail('Não é possível trocar uma publicação demonstrativa por uma publicação pessoal.');
    let comments;
    if (previous) comments = previous.comments;
    else {
      if (input.comments != null && !Array.isArray(input.comments)) throw fail('Comentários inválidos.');
      comments = (input.comments || []).map(comment => commentOf(comment, now));
      if (new Set(comments.map(comment => comment.id)).size !== comments.length) throw fail('Há comentários com identificadores repetidos.');
    }
    const video = blob != null ? videoOf(input.video, blob) : previous ? previous.video : null;
    if (!previous && input.video && blob == null) throw fail('O arquivo do vídeo não foi recebido. Nada foi salvo.');
    return {
      id: previous ? previous.id : input.id == null ? newId('post') : id(input.id),
      scope,
      practiceId: id(input.practiceId, 'Prática'),
      title: text(input.title, 'Título', 120),
      body: text(input.body, 'Descrição', 4000, false),
      visibility: visibilityOf(input.visibility),
      author: previous ? previous.author : author,
      demo: previous ? previous.demo : input.demo === true,
      createdAt: previous ? previous.createdAt : dateOf(input.createdAt, now),
      updatedAt: now,
      video,
      hasVideo: Boolean(video),
      comments
    };
  }

  const opening = new Promise(resolve => {
    function useMemory() {
      state = {
        persisted: false,
        storage: 'memory',
        warning: 'O armazenamento local está indisponível. Esta demonstração funciona só nesta aba; vídeos e comentários serão perdidos ao fechar ou atualizar.'
      };
      resolve();
    }
    try {
      if (!globalThis.indexedDB) return useMemory();
      const request = indexedDB.open(DB_NAME, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('posts')) {
          const posts = database.createObjectStore('posts', { keyPath: 'id' });
          posts.createIndex('scope', 'scope', { unique: false });
        }
        if (!database.objectStoreNames.contains('videos')) database.createObjectStore('videos', { keyPath: 'postId' });
      };
      request.onsuccess = () => {
        if (settled || disposed) { request.result.close(); return; }
        settled = true;
        db = request.result;
        db.onversionchange = () => { db.close(); };
        state = { persisted: true, storage: 'indexeddb', warning: '' };
        resolve();
      };
      request.onerror = event => {
        event.preventDefault();
        if (!settled) { settled = true; useMemory(); }
      };
      request.onblocked = () => {
        if (!settled) { settled = true; useMemory(); }
      };
    } catch (_) { useMemory(); }
  });

  async function ensure() {
    await opening;
    if (disposed) throw fail('Esta comunidade local já foi fechada.', 'disposed');
  }
  function transaction(stores, mode, body) {
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let originalError;
      const abort = error => {
        originalError = error;
        try { tx.abort(); } catch (_) { reject(storageError(error)); }
      };
      const guard = callback => event => {
        try { callback(event); } catch (error) { abort(error); }
      };
      try {
        tx = db.transaction(stores, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(storageError(originalError || tx.error));
        tx.onerror = event => { if (!originalError) originalError = event.target.error || tx.error; };
        body(tx, value => { result = value; }, guard);
      } catch (error) {
        if (tx) abort(error);
        else reject(storageError(error));
      }
    });
  }
  function assertMatch(post, scope) { return post && post.scope === scope ? post : null; }

  async function ready() { await ensure(); return { ...state }; }
  async function listPosts(query = {}) {
    await ensure();
    const scope = scopeOf(query.scope);
    const visibility = query.visibility == null ? null : visibilityOf(query.visibility);
    const posts = db ? await transaction(['posts'], 'readonly', (tx, result, guard) => {
      const request = tx.objectStore('posts').index('scope').getAll(scope);
      request.onsuccess = guard(() => result(request.result));
    }) : [...memoryPosts.values()].filter(post => post.scope === scope);
    return clone(posts.filter(post => !visibility || post.visibility === visibility)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)));
  }
  async function getPost(postId, query = {}) {
    await ensure();
    id(postId);
    const scope = scopeOf(query.scope);
    const post = db ? await transaction(['posts'], 'readonly', (tx, result, guard) => {
      const request = tx.objectStore('posts').get(postId);
      request.onsuccess = guard(() => result(assertMatch(request.result, scope)));
    }) : assertMatch(memoryPosts.get(postId), scope);
    return clone(post || null);
  }
  async function savePost(input, videoBlob) {
    await ensure();
    if (!input || typeof input !== 'object') throw fail('Publicação inválida.');
    const postId = input.id == null ? newId('post') : id(input.id);
    scopeOf(input.scope);
    if (!db) {
      const previous = memoryPosts.get(postId);
      const post = postOf({ ...input, id: postId }, videoBlob, previous);
      memoryPosts.set(post.id, clone(post));
      if (videoBlob != null) memoryVideos.set(post.id, videoBlob);
      return clone(post);
    }
    return transaction(['posts', 'videos'], 'readwrite', (tx, result, guard) => {
      const posts = tx.objectStore('posts');
      const request = posts.get(postId);
      request.onsuccess = guard(() => {
        const post = postOf({ ...input, id: postId }, videoBlob, request.result);
        posts.put(post);
        if (videoBlob != null) tx.objectStore('videos').put({ postId: post.id, blob: videoBlob });
        result(clone(post));
      });
    });
  }
  async function deletePost(postId, query = {}) {
    await ensure();
    id(postId);
    const scope = scopeOf(query.scope);
    if (!db) {
      if (!assertMatch(memoryPosts.get(postId), scope)) return false;
      memoryPosts.delete(postId);
      memoryVideos.delete(postId);
      return true;
    }
    return transaction(['posts', 'videos'], 'readwrite', (tx, result, guard) => {
      const posts = tx.objectStore('posts');
      const request = posts.get(postId);
      request.onsuccess = guard(() => {
        if (!assertMatch(request.result, scope)) return result(false);
        posts.delete(postId);
        tx.objectStore('videos').delete(postId);
        result(true);
      });
    });
  }
  async function updateComments(postId, query, update) {
    await ensure();
    id(postId);
    const scope = scopeOf(query && query.scope);
    const change = original => {
      const post = clone(assertMatch(original, scope));
      if (!post) throw fail('Esta publicação não foi encontrada nesta comunidade.', 'not_found');
      post.comments = update(post.comments);
      post.updatedAt = new Date().toISOString();
      return post;
    };
    if (!db) {
      const post = change(memoryPosts.get(postId));
      memoryPosts.set(postId, clone(post));
      return clone(post);
    }
    return transaction(['posts'], 'readwrite', (tx, result, guard) => {
      const posts = tx.objectStore('posts');
      const request = posts.get(postId);
      request.onsuccess = guard(() => {
        const post = change(request.result);
        posts.put(post);
        result(post);
      });
    });
  }
  async function addComment(postId, input, query = {}) {
    const comment = commentOf(input, new Date().toISOString());
    return updateComments(postId, query, comments => {
      const prior = comments.find(item => item.id === comment.id);
      if (prior) throw fail('Este comentário já existe. Atualize a tela antes de tentar novamente.', 'duplicate');
      return [...comments, comment];
    });
  }
  async function deleteComment(postId, commentId, query = {}) {
    id(commentId);
    return updateComments(postId, query, comments => comments.filter(comment => comment.id !== commentId));
  }
  async function getVideo(postId, query = {}) {
    await ensure();
    id(postId);
    const scope = scopeOf(query.scope);
    if (!db) return assertMatch(memoryPosts.get(postId), scope) ? memoryVideos.get(postId) || null : null;
    return transaction(['posts', 'videos'], 'readonly', (tx, result, guard) => {
      const request = tx.objectStore('posts').get(postId);
      request.onsuccess = guard(() => {
        if (!assertMatch(request.result, scope)) return result(null);
        const video = tx.objectStore('videos').get(postId);
        video.onsuccess = guard(() => result(video.result ? video.result.blob : null));
      });
    });
  }
  async function dispose() {
    await opening;
    disposed = true;
    if (db) db.close();
    // Fecha a conexão; não apaga publicações persistidas.
    memoryPosts.clear();
    memoryVideos.clear();
  }
  return { ready, listPosts, getPost, savePost, deletePost, addComment, deleteComment, getVideo, dispose };
}

// Local community demonstration. No accounts, network requests or real permissions.
const communityStore=account?null:createCommunityStore();
const communitySelf={id:'local-student',name:'Você',role:'student'};
let communityReadyPromise=null,communityStorage=null,communityRenderToken=0;
let communityUrls=[],communityDraft=null,communityFileToken=0;
const communityAudience={geral:'turma','penta-m05':'turma',agd:'turma'};
const communityScopes=['geral','penta-m05','agd'];
function communityParts(){return decodeURIComponent(location.hash.slice(1)).split('/')}
function communityScope(){return route==='academia'?'agd':route==='comunidade'?(communityParts()[1]||'geral'):['envio','compartilhar'].includes(route)?communityParts()[1]:null}
function communityHome(scope){return scope==='agd'?'academia':'comunidade/'+scope}
function communityPractices(scope){return scope==='geral'?[{id:'geral-conversa',title:'Conversa da comunidade'}]:scope==='agd'?[{id:'agd-conversa',title:'Conversa da Academia'},{id:'agd-desafio-demo',title:'Desafio demonstrativo · uma ideia, duas versões'}]:mod('dap:modulo:05').practices}
function communityPracticeTitle(scope,id){const p=communityPractices(scope).find(p=>p.id===id);return p?.displayTitle||p?.title||'Prática do módulo'}
function communityBeforeRender(){
 communityRenderToken++;communityFileToken++;
 document.querySelectorAll('[data-community-video],#community-preview').forEach(v=>{v.pause();v.removeAttribute('src');v.load();});
 communityUrls.forEach(u=>URL.revokeObjectURL(u));communityUrls=[];communityDraft=null;
}
function communityLocalUrl(blob){const u=URL.createObjectURL(blob);communityUrls.push(u);return u}
function communityEntry(mid,pid){if(account)return '<section class="community-entry"><div><p class="eyebrow">Aplicação dos estudos</p><h2>Vamos conversar sobre este módulo?</h2><p>Compartilhe uma tentativa, uma dúvida ou uma descoberta.</p></div><a class="button" href="#comunidade/geral/'+encodeURIComponent(mid)+(pid?'/'+encodeURIComponent(pid):'')+'">Ver conversas do módulo →</a></section>';return mid==='dap:modulo:05'?`<section class="community-entry"><div><p class="eyebrow">Práticas da turma · piloto</p><h2>Como outras pessoas estão tentando?</h2><p>Veja uma tentativa, troque uma ideia e volte ao seu treino.</p></div><button class="button" data-community-action="open" data-practice="${esc(pid||'')}">Ver a comunidade →</button></section>`:''}
function communityShell(){return `<div class="community-page" id="community-root"><p role="status">Preparando a comunidade…</p></div>`}
function communityNotice(){return '<div class="community-notice"><strong>Exemplos fictícios de desenvolvimento</strong><span>O modo sem login guarda dados só neste navegador. Use npm run dev para testar duas contas no fórum.</span></div>'}
function communityCrumb(scope){if(scope==='geral')return '<div class="crumb"><a href="#comunidade/geral">Fórum geral</a></div>';return scope==='agd'?'<div class="crumb"><a href="#academia">Academia</a><span>/</span><span>Desafios e mentorias</span></div>':'<div class="crumb"><a href="#curso/penta">Destravando a Penta</a><span>/</span><a href="#modulo/dap:modulo:05">Módulo 5</a><span>/</span><a href="#comunidade/penta-m05">Comunidade</a></div>'}
async function communityReady(){
 if(!communityReadyPromise)communityReadyPromise=(async()=>{
  communityStorage=await communityStore.ready();
  const seeds=[
   {id:'demo-penta-01',scope:'penta-m05',practiceId:'penta-m05-01',title:'Minha tentativa de levar a mesma frase para outro acorde',body:'Exemplo: no Gm a frase saiu natural. Quando fui para Cm, perdi um pouco o ritmo. Como vocês treinam essa mudança?',author:{id:'demo-aluno-1',name:'Aluno exemplo 1',role:'student'},comments:[{id:'demo-comment-01',author:{id:'demo-aluno-2',name:'Aluno exemplo 2',role:'student'},body:'Exemplo de troca entre alunos: eu começo com uma frase bem curta e canto o ritmo antes de mudar de região.',demo:true}]},
   {id:'demo-penta-02',scope:'penta-m05',practiceId:'penta-m05-03',title:'Uma dúvida na hora de chegar à nota do bend',body:'Exemplo: consigo reconhecer a nota de chegada, mas ainda quero acertá-la com mais calma. Esta seria minha gravação para comparar depois.',author:{id:'demo-aluno-2',name:'Aluno exemplo 2',role:'student'},comments:[]},
   {id:'demo-agd-01',scope:'agd',practiceId:'agd-desafio-demo',title:'Minha tentativa do desafio da Academia',body:'Exemplo: toquei uma ideia curta e depois mudei o ritmo. Aqui entrariam as tentativas e as conversas do desafio, separadas dos cursos.',author:{id:'demo-academia-aluno',name:'Assinante exemplo',role:'student'},comments:[{id:'demo-agd-feedback',author:{id:'demo-professor',name:'Professor (exemplo)',role:'teacher'},body:'Exemplo de devolutiva, sem análise de uma execução real: escolha um trecho para comparar as duas versões e registre o que percebeu.',demo:true}]}
  ];
  for(const seed of seeds){if(!await communityStore.getPost(seed.id,{scope:seed.scope}))await communityStore.savePost({...seed,demo:true,visibility:'turma'});}
 })().catch(e=>{communityReadyPromise=null;throw e});
 return communityReadyPromise;
}
function communityVideo(p){if(p.demo||!p.hasVideo)return '';return `<div class="community-video-wrap"><video data-community-video="${esc(p.id)}" controls playsinline preload="metadata" aria-label="${esc(p.title)}"></video></div>`}
function communityBadge(p){return p.demo?'<span class="community-badge">Demonstração</span>':`<span class="community-badge">${p.visibility==='equipe'?'Só equipe · simulação':'Turma · simulação'}</span>`}
function communityCard(p){return `<article class="community-card" data-post-id="${esc(p.id)}"><div class="community-card-head"><span>${esc(p.author.name)}</span>${communityBadge(p)}</div>${communityVideo(p)}<div class="community-card-body"><p class="eyebrow">${esc(communityPracticeTitle(p.scope,p.practiceId))}</p><h2>${esc(p.title)}</h2><p>${esc(p.body)}</p><a class="button" href="#envio/${esc(p.scope)}/${esc(p.id)}">Ver conversa${p.comments.length?` (${p.comments.length})`:''} →</a></div></article>`}
async function communityAttachVideos(posts,token){
 for(const p of posts.filter(p=>!p.demo&&p.hasVideo)){
  const blob=await communityStore.getVideo(p.id,{scope:p.scope});
  if(token!==communityRenderToken)return;
  const player=document.querySelector(`[data-community-video="${p.id}"]`);
  if(player){if(blob)player.src=communityLocalUrl(blob);else player.outerHTML='<p role="status">O vídeo local não está disponível. Você pode remover este envio e selecionar o arquivo novamente.</p>';}
 }
}
function communityFeed(scope,posts){
 const pid=scope==='penta-m05'?communityParts()[2]||'':'',view=communityAudience[scope];
 const shown=posts.filter(p=>(view==='meus'?p.author.id===communitySelf.id:p.visibility==='turma')&&(!pid||p.practiceId===pid));
 return `${forumNavigation(scope)}<div class="page-title"><div><p class="eyebrow">${scope==='agd'?'Academia Guitarra Desbloqueada':'Comunidade Criasom'}</p><h1>${scope==='agd'?'Fórum da Academia':scope==='geral'?'Vamos conversar sobre música.':'Práticas da Penta · módulo 5'}</h1><p class="muted">${scope==='agd'?'Desafios, tentativas e devolutivas em um espaço próprio.':'Abra um tópico, faça uma pergunta ou compartilhe uma descoberta.'}</p></div></div>${communityNotice()}
 ${scope==='agd'?`<section class="community-academy-note"><h2>Os desafios ficam no Club</h2><p>Abra a Academia e escolha o módulo de desafios. Assim, novos desafios entram no Club sem precisar atualizar este app a cada semana.</p><a class="button primary" href="https://hotmart.com/pt-br/club/guitarra-desbloqueada/" target="_blank" rel="noopener noreferrer">Assistir aos desafios no Club ↗</a><p class="small muted">Este botão abre a entrada da Academia. O link direto do módulo de desafios ainda será conferido. Seu acesso depende da assinatura.</p><p class="small muted">O fórum abaixo é uma demonstração local. Não envia vídeos ao professor. Os exemplos antigos não representam o desafio atual.</p></section>`:'<p class="community-lesson-note">Troque experiências e volte ao instrumento. As aulas continuam sendo sua referência.</p>'}
 <div class="community-toolbar"><div class="community-tabs" aria-label="Ver tópicos"><button data-community-action="audience" data-view="turma" aria-pressed="${view==='turma'}">Tópicos do espaço</button><button data-community-action="audience" data-view="meus" aria-pressed="${view==='meus'}">Meus tópicos</button></div><button class="button primary" data-community-action="compose">+ Criar tópico</button></div>
 ${scope==='penta-m05'?`<label class="community-filter">Qual prática?<select id="community-practice-filter"><option value="">Todas as práticas do módulo</option>${communityPractices(scope).map(p=>`<option value="${esc(p.id)}" ${pid===p.id?'selected':''}>${esc(p.displayTitle||p.title)}</option>`).join('')}</select></label>`:''}
 ${view==='meus'?'<p class="small muted">Seus tópicos neste navegador, incluindo os marcados “Só equipe”. A visibilidade ainda é simulada.</p>':''}
 <div class="community-feed" id="community-feed">${shown.length?shown.map(communityCard).join(''):`<div class="community-empty"><h2>${scope==='geral'?'O primeiro assunto pode ser seu.':'Ainda não há tópicos aqui.'}</h2><p>Uma dúvida, uma ideia ou uma descoberta já inicia a conversa. Vídeo é opcional.</p><button class="button" data-community-action="compose">Criar meu primeiro tópico</button></div>`}</div>`;
}

function communityComments(p){return p.comments.length?`<ol class="community-comments">${p.comments.map(c=>`<li data-comment-id="${esc(c.id)}"><div class="row wrap"><strong>${esc(c.author.name)}</strong>${c.demo?'<span class="community-badge">Comentário demonstrativo</span>':''}</div><p>${esc(c.body)}</p>${c.author.id===communitySelf.id?`<button class="text-button" data-community-action="delete-comment" data-post="${esc(p.id)}" data-comment="${esc(c.id)}">Excluir meu comentário</button>`:''}</li>`).join('')}</ol>`:'<p class="muted">A conversa pode começar com uma dúvida, uma descoberta ou uma sugestão gentil.</p>'}
function communityDetail(p){
 const own=p.author.id===communitySelf.id;
 return `${forumNavigation(p.scope)}${communityCrumb(p.scope)}<a class="text-button" href="#${communityHome(p.scope)}">← Voltar aos envios</a>${communityNotice()}<article id="community-detail" data-post-id="${esc(p.id)}"><div class="community-card-head"><span>${esc(p.author.name)}</span>${communityBadge(p)}</div><h1>${esc(p.title)}</h1><p class="muted">${esc(communityPracticeTitle(p.scope,p.practiceId))}</p>${communityVideo(p)}<p class="community-post-text">${esc(p.body)}</p>
 ${p.scope==='penta-m05'?`<button class="button" data-community-action="practice" data-practice="${esc(p.practiceId)}">Rever a aula e praticar →</button>`:''}
 ${own?`<div class="community-own-controls"><p class="small muted">Visibilidade simulada: ${p.visibility==='equipe'?'só equipe':'turma'}. Ninguém recebe este conteúdo.</p><div class="row wrap"><button class="text-button" data-community-action="change-visibility" data-post="${esc(p.id)}">${p.visibility==='equipe'?'Mudar para turma':'Mudar para só equipe'}</button><button class="text-button" data-community-action="delete-post" data-post="${esc(p.id)}">Excluir meu envio</button></div></div>`:''}
 <section class="community-conversation" aria-labelledby="community-conversation-title"><h2 id="community-conversation-title">Conversa deste tópico</h2><div id="community-comments">${communityComments(p)}</div><form id="community-comment-form" data-post="${esc(p.id)}"><label for="community-comment">Seu comentário</label><textarea id="community-comment" name="comment" required maxlength="1000" placeholder="O que você tentou, percebeu ou gostaria de perguntar?"></textarea><p class="small muted">Seu comentário será guardado só neste piloto.</p><p class="community-error" role="alert" hidden></p><button class="button primary" type="submit">Guardar comentário</button></form></section></article>`;
}
function communityComposer(scope){
 const selected=communityParts()[2],ps=communityPractices(scope);
 return `${forumNavigation(scope)}<a class="text-button" href="#${communityHome(scope)}">← Voltar ao fórum</a><div class="page-title"><div><p class="eyebrow">Comunidade · piloto local</p><h1>Que assunto você quer trazer?</h1><p class="muted">Escreva um título e conte sua ideia. Vídeo é opcional.</p></div></div>${communityNotice()}<form id="community-post-form" class="card community-composer">
 <label for="community-title">Título do tópico</label><input id="community-title" name="title" required maxlength="120" placeholder="Ex.: como vocês organizam as músicas da semana?">
 <label for="community-body">Sua dúvida, descoberta ou experiência <span class="muted">(opcional)</span></label><textarea id="community-body" name="body" maxlength="2000" placeholder="Conte com suas palavras."></textarea>
 ${scope==='penta-m05'?`<label for="community-practice">Prática relacionada</label><select id="community-practice" name="practice">${ps.map(p=>`<option value="${esc(p.id)}" ${selected===p.id?'selected':''}>${esc(p.displayTitle||p.title)}</option>`).join('')}</select>`:`<input type="hidden" name="practice" value="${scope==='agd'?'agd-conversa':'geral-conversa'}">`}
 <details><summary>Adicionar um vídeo (opcional)</summary><label for="community-file">Escolha seu vídeo</label><input type="file" id="community-file" accept="video/mp4,video/webm,video/quicktime,video/*" aria-describedby="community-file-help"><p id="community-file-help" class="small muted">Até 3 minutos e 50 MB neste teste. Não há envio à internet.</p><video id="community-preview" controls playsinline preload="metadata" hidden></video><p id="community-file-status" class="small" role="status"></p></details>
 <label for="community-visibility">Quem poderia ver?</label><select id="community-visibility" name="visibility"><option value="turma">Participantes deste espaço</option><option value="equipe">Só equipe</option></select><p class="small muted">Neste piloto, a escolha é simulada, sem proteção por login. Ninguém recebe seu tópico ou vídeo. ${scope==='agd'?'A análise do professor ainda não está conectada.':'Escolher “Só equipe” não inclui análise individual.'}</p>
 <p class="community-error" role="alert" hidden></p><button id="community-save" class="button primary" type="submit">Guardar tópico no piloto</button><p class="small muted">Use conteúdo seu ou autorizado. Ele fica neste navegador.</p></form>`;
}

async function communityMount(){
 const token=communityRenderToken,scope=communityScope(),root=$('#community-root');if(!root)return;
 try{
  if(!communityScopes.includes(scope))throw Error('Este espaço não faz parte do piloto.');
  await communityReady();if(token!==communityRenderToken)return;
  if(route==='compartilhar'){root.innerHTML=communityComposer(scope);return;}
  if(route==='envio'){
   const p=await communityStore.getPost(communityParts()[2],{scope});if(token!==communityRenderToken)return;
   if(!p)throw Error('Este envio não está disponível neste espaço.');
   root.innerHTML=communityDetail(p);await communityAttachVideos([p],token);return;
  }
  const posts=await communityStore.listPosts({scope});if(token!==communityRenderToken)return;
  root.innerHTML=communityFeed(scope,posts);
  await communityAttachVideos(posts.filter(p=>root.querySelector(`[data-post-id="${p.id}"]`)),token);
 }catch(e){if(token===communityRenderToken)root.innerHTML=`<div class="card"><h1>Não consegui abrir este espaço.</h1><p role="alert">${esc(e.message)}</p><button class="button" data-community-action="retry">Tentar novamente</button> <a class="text-button" href="#modulo/dap:modulo:05">Voltar ao módulo</a></div>`;}
}
function communityRefresh(){render()}
function communityFormError(form,error){const el=form.querySelector('.community-error');el.hidden=false;el.textContent=error.message||String(error);}
async function communityReadFile(file){
 const token=++communityFileToken;communityDraft=null;
 const preview=$('#community-preview'),status=$('#community-file-status');
 const oldUrl=preview.src;preview.pause();preview.removeAttribute('src');preview.load();
 if(oldUrl?.startsWith('blob:')){URL.revokeObjectURL(oldUrl);communityUrls=communityUrls.filter(u=>u!==oldUrl);}
 preview.hidden=true;status.textContent='';
 if(!file)return;
 if(!file.type.startsWith('video/')||file.size<=0||file.size>50*1024*1024){status.textContent='Escolha um vídeo de até 50 MB.';return;}
 status.textContent='Conferindo o vídeo…';
 const url=communityLocalUrl(file);preview.src=url;preview.hidden=false;
 try{
  const duration=await new Promise((resolve,reject)=>{
   let timeout=setTimeout(()=>finish(Error('Não consegui abrir este formato. Tente um vídeo MP4 ou WebM.')),12000);
   function finish(err){clearTimeout(timeout);preview.removeEventListener('loadedmetadata',loaded);preview.removeEventListener('error',failed);err?reject(err):resolve(preview.duration)}
   function loaded(){finish()}function failed(){finish(Error('Não consegui reproduzir este formato. Tente um vídeo MP4 ou WebM.'))}
   preview.addEventListener('loadedmetadata',loaded,{once:true});preview.addEventListener('error',failed,{once:true});
  });
  if(token!==communityFileToken)return;
  if(!Number.isFinite(duration)||duration<=0||duration>180)throw Error('Escolha um vídeo de até 3 minutos, com duração reconhecida pelo navegador.');
  communityDraft={file,duration};status.textContent=`Pronto para testar · ${Math.ceil(duration)} s · ${(file.size/1024/1024).toFixed(1)} MB. Nenhum envio à internet.`;
 }catch(e){if(token===communityFileToken){preview.pause();preview.hidden=true;status.textContent=e.message;}}
}
document.addEventListener('change',e=>{
 if(e.target.id==='community-practice-filter')go('comunidade/penta-m05'+(e.target.value?'/'+e.target.value:''));
 if(e.target.id==='community-file')void communityReadFile(e.target.files[0]);
});
document.addEventListener('play',e=>{
 if(!e.target.matches?.('[data-community-video],#community-preview'))return;
 document.querySelectorAll('[data-community-video],#community-preview').forEach(v=>{if(v!==e.target)v.pause()});
},true);
document.addEventListener('click',async e=>{
 if(account)return;
 const b=e.target.closest('[data-community-action]');if(!b)return;e.preventDefault();
 const a=b.dataset.communityAction,scope=communityScope(),token=communityRenderToken;
 try{
  if(a==='open'){go('comunidade/penta-m05'+(b.dataset.practice?'/'+b.dataset.practice:''));}
  else if(a==='compose'){go('compartilhar/'+scope+(scope==='penta-m05'&&communityParts()[2]?'/'+communityParts()[2]:''));}
  else if(a==='audience'){communityAudience[scope]=b.dataset.view;communityRefresh();}
  else if(a==='retry')communityRefresh();
  else if(a==='practice'){moduleId='dap:modulo:05';preference('guide.'+moduleId,b.dataset.practice);go('modulo/'+moduleId);}
  else if(['delete-post','delete-comment','change-visibility'].includes(a)){
   b.disabled=true;
   const p=await communityStore.getPost(b.dataset.post,{scope});if(token!==communityRenderToken)return;if(!p)throw Error('Este envio não está disponível.');
   if(a==='delete-comment'){
    if(!p.comments.some(c=>c.id===b.dataset.comment&&c.author.id===communitySelf.id))throw Error('Só seus comentários podem ser removidos neste piloto.');
    await communityStore.deleteComment(p.id,b.dataset.comment,{scope});if(token!==communityRenderToken)return;communityRefresh();toast('Comentário removido deste piloto.');
   }else{
    if(p.author.id!==communitySelf.id)throw Error('Só seus envios podem ser alterados neste piloto.');
    if(a==='change-visibility'){await communityStore.savePost({...p,visibility:p.visibility==='equipe'?'turma':'equipe'});if(token!==communityRenderToken)return;communityRefresh();toast('Visibilidade simulada atualizada. Ninguém recebeu o vídeo.');}
    else showDialog('Excluir este envio local?',`<p>O vídeo e seus comentários serão removidos deste piloto. O arquivo original do computador continua com você.</p><form id="community-delete-form" data-post="${esc(p.id)}" data-scope="${esc(scope)}"><p class="community-error" role="alert" hidden></p><div class="actions"><button type="button" class="button" data-action="close-dialog">Cancelar</button><button type="submit" class="button primary">Excluir do piloto</button></div></form>`);
   }
  }
 }catch(error){if(token===communityRenderToken)toast(error.message)}finally{if(b.isConnected)b.disabled=false;}
});
document.addEventListener('submit',async e=>{
 const f=e.target;if(account||!['community-post-form','community-comment-form','community-delete-form'].includes(f.id))return;e.preventDefault();
 const scope=f.dataset.scope||communityScope(),token=communityRenderToken,submit=f.querySelector('[type=submit]');submit.disabled=true;
 try{
  await communityReady();
  if(f.id==='community-post-form'){
   if($('#community-file').files[0]&&(!communityDraft||communityDraft.file!==$('#community-file').files[0]))throw Error('Aguarde a conferência do vídeo antes de guardar.');
   const v=new FormData(f),pid=v.get('practice');
   if(!communityPractices(scope).some(p=>p.id===pid))throw Error('Escolha uma prática deste espaço.');
   const draft=communityDraft;
   const p=await communityStore.savePost({scope,practiceId:pid,title:v.get('title'),body:v.get('body'),visibility:v.get('visibility'),author:communitySelf,...(draft?{video:{name:draft.file.name,duration:draft.duration}}:{})},draft?.file);
   if(token!==communityRenderToken)return;communityAudience[scope]='meus';go('envio/'+scope+'/'+p.id);toast(communityStorage.persisted?'Tópico guardado neste navegador. Nenhum envio à internet.':'Tópico disponível só nesta sessão.');
  }else if(f.id==='community-comment-form'){
   const value=new FormData(f).get('comment');
   await communityStore.addComment(f.dataset.post,{author:communitySelf,body:value},{scope});
   if(token!==communityRenderToken)return;communityRefresh();toast(communityStorage.persisted?'Comentário guardado neste navegador.':'Comentário disponível só nesta sessão.');
  }else{
   const p=await communityStore.getPost(f.dataset.post,{scope});if(!p||p.author.id!==communitySelf.id)throw Error('Este envio não pode ser excluído.');
   await communityStore.deletePost(p.id,{scope});if(token!==communityRenderToken)return;closeDialog();go(communityHome(scope));toast('Envio e vídeo removidos deste piloto.');
  }
 }catch(error){if(f.isConnected)communityFormError(f,error);}finally{if(submit.isConnected)submit.disabled=false;}
});

// END LOCAL COMMUNITY
if(account){
 account.beforeLeave=()=>{pauseTimer();stopSounds();};
 account.onStatus=status=>{
  persisted=status.phase==='saved'&&!status.pending;
  if(status.frozen){pauseTimer(false);stopSounds();}
  if(persisted&&$('#dialog-title')?.textContent==='Salvando na sua conta…')$('#dialog-title').textContent='Seu registro está guardado.';
 };
 account.onClear=()=>{account.forum.clear();pauseTimer(false);stopSounds();communityBeforeRender();state={schemaVersion:1,revision:0,updatedAt:null,sessions:[],practices:[]};runId=null;accountPreferences.clear();};
 document.addEventListener('click',async event=>{
  const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||link.hasAttribute('data-repertoire-entry'))return;
  const target=new URL(link.href,location.href);if(target.origin===location.origin&&target.pathname===location.pathname&&target.search===location.search)return;
  if(target.protocol!=='http:'&&target.protocol!=='https:')return;
  event.preventDefault();pauseTimer();stopSounds();if(!(await account.flush()))return;
  if(link.target==='_blank'){const opened=window.open(target.href,'_blank','noopener,noreferrer');if(!opened)toast('O navegador pode ter bloqueado a nova aba. Seus registros estão salvos.');}
  else location.assign(target.href);
 });
}
function forumNavigation(scope){return `<nav class="forum-spaces" aria-label="Espaços da comunidade"><a href="#comunidade/geral" ${scope==='geral'?'aria-current="page"':''}>Fórum geral</a><a href="#comunidade/penta-m05" ${scope==='penta-m05'?'aria-current="page"':''}>Penta · módulo 5</a><a href="#academia" ${scope==='agd'?'aria-current="page"':''}>Fórum da Academia</a></nav>`}

// Guided first access is optional; nothing is added to the learner's list by the tour.
const INTRO_STEPS = [
 ['Bem-vindo ao seu espaço de música.','Você não precisa saber usar aplicativos. Vamos conhecer o essencial, uma coisa de cada vez. Pode pular e abrir esta apresentação depois em Ajuda.','Você escolhe o que quer tocar.','Não há tarefa, horário ou curso obrigatório para começar.'],
 ['Comece escrevendo uma linha.','Em Meu estudo, escreva o que quer tocar e aperte Enter ou Adicionar. Depois, clique no próprio texto para mudar.','Exemplo: tocar o refrão da minha música favorita','O exemplo é apenas uma explicação. Nenhuma tarefa foi adicionada.'],
 ['Cada botão tem uma função.','Tocar abre o relógio e os apoios. A caixinha marca a tarefa. O botão ••• abre data, duração, etiqueta e anotações — tudo opcional.','⠿ Organizar · □ Marcar · Tocar · ••• Opções','Arraste ⠿ ou use Subir e Descer nas opções para mudar a ordem. Marcar não é uma avaliação musical.'],
 ['Músicas, planos e registros.','Meu repertório guarda músicas, links e etiquetas. Minha semana reúne seus planos, com ou sem data. Registros mostra o que você contou depois de praticar.','Planejado = o que quero fazer. Registro = como foi.','Uma linha com 19h e 30 minutos é um plano. Só registrar uma prática cria um registro de como foi.'],
 ['A aula acompanha seu estudo.','Cursos oferece os guias, as aulas e os diagramas. Assista à demonstração e depois explore com musicalidade, no seu tempo. O app é um complemento.','Abrir diagrama mostra a página da apostila.','O metrônomo marca o pulso; a backing é um acompanhamento. Você pode estudar sem nenhum deles.'],
 ['Seu espaço pode crescer com você.','Comunidade fica no menu principal. O Personalizador é um teste opcional para sugerir um ponto de partida. Em Ajuda, você pode rever este guia e aprender sobre o ícone do app.','A constância vale mais que uma lista perfeita.','Escolha um foco, afaste distrações e passe tempo no instrumento. Este piloto guarda tudo neste navegador; o fórum ainda é local.']
];
let introductionIndex=0;
function showIntroduction(index=0){
 introductionIndex=index;const s=INTRO_STEPS[index];
 showDialog(s[0],`<p class="intro-count">Primeiro acesso · ${index+1} de ${INTRO_STEPS.length}</p><div class="intro-steps" aria-hidden="true">${INTRO_STEPS.map((_,i)=>`<span class="${i<=index?'current':''}"></span>`).join('')}</div><p>${s[1]}</p><div class="intro-example"><strong>${s[2]}</strong><p class="small muted">${s[3]}</p></div><div class="actions"><button class="text-button" data-experience="intro-skip">Pular apresentação</button>${index?'<button class="button" data-experience="intro-back">Voltar</button>':''}<button class="button primary" data-experience="intro-next">${index===INTRO_STEPS.length-1?'Começar meu estudo':'Próximo →'}</button></div>`,'intro-card');
 $('#dialog [data-action="close-dialog"]').dataset.experience='intro-skip';
}
function finishIntroduction(){if(!tx(markIntroduction))return;closeDialog();go('hoje');setTimeout(()=>document.querySelector('.task-quick input')?.focus(),50)}
function maybeIntroduction(){if(!state.introductionSeen&&!state.sessions.length&&!state.practices.length&&!(state.repertoire||[]).length&&route==='hoje')showIntroduction()}
$('#dialog').addEventListener('cancel',e=>{if($('#dialog').classList.contains('intro-card')){e.preventDefault();finishIntroduction()}});
function courseSupport(p,r,step){
 const page=[step.pageKey,step.printedPage,...(p.pages||[])].find(x=>x!=null&&data.pages[x]);
 return `${page!=null?`<div class="diagram-callout"><button class="button primary" data-action="book" data-page="${esc(page)}">▤ Abrir diagrama</button><p>Página desta prática na apostila, com ampliação.</p></div>`:''}<aside class="course-reminder"><strong>A aula é sua referência; o app é um complemento.</strong><details><summary>Rever aulas e explorar com musicalidade</summary><p>Assista à demonstração, pause a tela e passe tempo no instrumento. Varie o ritmo, ouça o som e explore sozinho, sem pressa.</p>${(p.lessonIds||[]).map(id=>lessonLink(mod(r.moduleId).lessons.find(l=>l.id===id))).join('')}</details></aside>`;
}
const PROFILE_QUESTIONS=[
 {key:'experience',title:'Como está sua relação com o instrumento?',options:[['starting','Estou começando','Quero construir a base com calma.'],['returning','Estou voltando ou ainda travo','Já toquei e quero encontrar continuidade.'],['comfortable','Já toco com alguma segurança','Quero explorar e ampliar minha musicalidade.']]},
 {key:'instrument',title:'O que você costuma tocar?',options:[['guitar','Guitarra',''],['acoustic','Violão',''],['other','Outro instrumento ou mais de um','As sugestões serão gerais; os guias atuais são de guitarra e violão.']]},
 {key:'goal',title:'O que mais dá vontade de fazer agora?',options:[['songs','Tocar minhas músicas','Repertório e prazer de tocar.'],['improvise','Improvisar e criar frases','Explorar ideias com intenção.'],['harmony','Entender acordes e harmonia','Ouvir e aplicar as relações entre acordes.'],['ear','Tocar mais de ouvido','Aproximar o que ouço do que toco.'],['rhythm','Ganhar ritmo e fluidez','Encontrar o pulso e variar levadas.']]},
 {key:'obstacle',title:'O que mais atrapalha seu estudo?',options:[['start','Não sei por onde começar',''],['time','É difícil encontrar tempo',''],['stuck','Travo e fico repetindo sem clareza',''],['apply','Vejo aulas, mas aplico pouco','']]},
 {key:'availability',title:'Como prefere encontrar tempo para tocar?',options:[['free','Sem duração definida','Vou experimentando, sem contar os minutos.'],['short','Encontros curtos','Em torno de 5 a 10 minutos, quando der.'],['medium','Um pouco mais de tempo','Em torno de 15 a 30 minutos.'],['long','Gosto de explorar com calma','Mais de 30 minutos, quando for possível.']]}
];
let quizIndex=0,quizDraft=null,quizShowResult=true;
function startQuiz(){quizDraft={...Object.fromEntries(PROFILE_QUESTIONS.map(q=>[q.key,null])),...(state.studyProfile||{})};quizIndex=0;quizShowResult=false;render()}
function profileChoice(key,value){return PROFILE_QUESTIONS.find(q=>q.key===key)?.options.find(o=>o[0]===value)?.[1]||'Não informado'}
function profileCourseIds(profile){return {songs:['zero','evolucao'],improvise:['penta','licks','mestres'],harmony:['harmonia','harmonia2'],ear:['ouvido','poderoso'],rhythm:['ritmo','zero']}[profile.goal]||['zero','evolucao']}
function personalizer(){
 if(state.studyProfile&&quizShowResult)return profileResult();
 if(!quizDraft)return `<section class="quiz-shell"><p class="eyebrow">Um ponto de partida</p><h1>Personalizador de estudos <span class="beta-badge">BETA · teste</span></h1><p>Cinco perguntas curtas para sugerir caminhos. Você pode pular qualquer uma, editar as sugestões ou continuar sem quiz.</p><p class="quiz-rationale">É uma orientação baseada nas suas respostas e no catálogo disponível. Não é uma avaliação do que você toca. A constância, a atenção e o tempo no instrumento continuam sendo o centro.</p><button class="button primary" data-experience="quiz-start">Experimentar o personalizador</button><p><a href="#hoje">Continuar meu estudo</a></p></section>`;
 const q=PROFILE_QUESTIONS[quizIndex];return `<section class="quiz-shell"><p class="intro-count">Personalizador · BETA · ${quizIndex+1} de 5</p><h1>${q.title}</h1><div class="quiz-choices">${q.options.map(o=>`<button data-experience="quiz-choice" data-value="${o[0]}" aria-pressed="${quizDraft[q.key]===o[0]}">${o[1]}${o[2]?`<small>${o[2]}</small>`:''}</button>`).join('')}</div><div class="quiz-actions">${quizIndex?'<button class="button" data-experience="quiz-back">Voltar</button>':''}<button class="text-button" data-experience="quiz-skip">Pular pergunta</button><button class="button primary" data-experience="quiz-next" ${quizDraft[q.key]===null?'disabled':''}>${quizIndex===4?'Ver orientação':'Próxima →'}</button></div><p class="small muted">Suas respostas serão guardadas ${account?'na sua conta de teste':'só neste navegador'} ao terminar. Nenhuma rotina é adicionada automaticamente.</p><a href="#hoje">Sair do quiz</a></section>`;
}
function profileResult(){const p=state.studyProfile,items=studySuggestions(p),sig=JSON.stringify(p),applied=state.profileApplied===sig;
 return `<section class="quiz-shell"><p class="eyebrow">Personalizador <span class="beta-badge">BETA · teste</span></p><h1>Uma ideia para começar.</h1><p>Seu foco: <strong>${esc(profileChoice('goal',p.goal))}</strong>. ${esc(profileChoice('experience',p.experience))}.</p><p class="quiz-rationale">${esc(items[0].notes)} ${p.availability==='free'?'Você escolheu tempo livre; nenhuma duração será imposta.':p.availability==='short'?'Para encontros curtos, escolha só uma das tarefas por vez.':p.availability?'Use seu tempo disponível sem precisar cumprir todas as sugestões.':'Como não informou um tempo, as tarefas ficam livres.'} ${p.instrument==='other'?'Adapte as ideias ao seu instrumento; o catálogo atual foi preparado para guitarra e violão.':''}</p><form id="profile-apply" class="quiz-result"><h2>Levar para Meu estudo</h2><p class="small muted">Escolha as ideias que combinam com você. Elas viram linhas editáveis, sem data ou duração obrigatória.</p>${items.map((item,i)=>`<label><input type="checkbox" name="suggestion" value="${i}" checked ${applied?'disabled':''}><span>${esc(item.title)}<small>${esc(item.notes)}</small></span></label>`).join('')}<button class="button primary" type="submit" ${applied?'disabled':''}>${applied?'Sugestões já adicionadas':'Adicionar ideias selecionadas'}</button>${applied?'<p><a href="#hoje">Editar as ideias em Meu estudo →</a></p>':''}</form><section class="card"><h2>Cursos como apoio</h2><ul class="help-list">${profileCourseIds(p).map(id=>{const c=data.courses.find(c=>c.id===id),ready=data.modules.some(m=>m.courseId===id)&&(!account||account.has('course:'+id));return c?`<li><strong>${esc(c.title)}</strong> — ${esc(c.summary)} ${ready?`<a href="#curso/${id}">Ver guias disponíveis</a>`:'<span class="small muted">· referência do catálogo; guia completo ainda não disponível neste piloto.</span>'}</li>`:''}).join('')}</ul><p class="small muted">A base detalhada do piloto cobre Penta 3, 4 e 5 e Harmonia I — Arpejos. Os demais cursos usam apenas a descrição do catálogo. A sugestão não libera acesso nem recomenda uma compra.</p></section><p>Assista às aulas para entender a demonstração. Depois, afaste o celular, feche a tela quando puder e explore o instrumento com atenção.</p><details><summary>Rever minhas respostas</summary><dl>${PROFILE_QUESTIONS.map(q=>`<dt>${q.title}</dt><dd>${esc(profileChoice(q.key,p[q.key]))}</dd>`).join('')}</dl></details><button class="button" data-experience="quiz-start">Ajustar respostas</button></section>`;
}
function advanceQuiz(skip=false){if(skip)quizDraft[PROFILE_QUESTIONS[quizIndex].key]=null;if(quizIndex<4){quizIndex++;render()}else if(tx(s=>saveStudyProfile(s,quizDraft))){quizShowResult=true;render();toast(saveMessage('Suas respostas foram guardadas.','Respostas apenas nesta sessão.'))}}
const STUDY_BACKUP_KEY='criasom.pilot.study-backup.v1';
function getStudyBackup(){try{const v=JSON.parse(localStorage.getItem(STUDY_BACKUP_KEY)||'null');if(v?.format!=='criasom-study-backup/1')return null;validateState(v.study);return v}catch{return null}}
function downloadStudyBackup(backup){const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='criasom-meu-estudo-'+backup.savedAt.slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
function resetDialog(){showDialog('Guardar meu estudo e testar do zero',`<p>Serão guardadas suas tarefas, práticas, respostas do personalizador e músicas pessoais. A tela ficará vazia para testar o primeiro acesso.</p><p>O fórum local, os materiais e o catálogo de músicas do curso continuam como estão.</p><p class="small muted">Uma cópia será conferida neste navegador e um arquivo será oferecido para baixar. Guarde esse arquivo antes de limpar os dados do navegador.</p>${getStudyBackup()?'<p class="soft-note">Já existe um estudo guardado. Restaure-o antes de iniciar outro teste; ele não será sobrescrito.</p>':'<button class="button primary" data-experience="backup-reset">Guardar e começar o teste vazio</button>'}<button class="text-button" data-action="close-dialog">Voltar</button>`)}
function backupAndReset(){
 if(account){toast('Esta ação é exclusiva do piloto local, sem conta.');return}
 try{
  if(localStorage.getItem(STUDY_BACKUP_KEY)!==null)throw Error('Já há uma cópia guardada. Restaure seu estudo antes de iniciar outro teste.');
  if(!saveTimerProgress())throw Error('Não foi possível guardar o tempo atual. O teste não começou.');pauseTimer();stopSounds();
  const current=store.read();if(!current.persisted)throw Error('O navegador não confirmou a gravação. Seu estudo não foi limpo.');
  const backup={format:'criasom-study-backup/1',savedAt:new Date().toISOString(),study:current.state};validateState(backup.study);
  const raw=JSON.stringify(backup);localStorage.setItem(STUDY_BACKUP_KEY,raw);if(localStorage.getItem(STUDY_BACKUP_KEY)!==raw)throw Error('A cópia não foi confirmada. Seu estudo não foi limpo.');
  const result=store.transact(s=>{if(s.revision!==backup.study.revision)throw Error('Outra aba alterou seu estudo. Nada foi limpo.');return freshStudy(s)});
  if(!result.ok||!result.persisted){applyResult(result);throw Error('A limpeza não foi confirmada. Sua cópia está disponível em Ajuda.');}
  applyResult(result);downloadStudyBackup(backup);runId=null;quizDraft=null;quizShowResult=true;closeDialog();history.replaceState(null,'','#hoje');render();showIntroduction();
 }catch(e){toast(e.message)}
}
function restoreBackup(backup){
 if(account)return;pauseTimer();stopSounds();const result=store.transact(s=>restoreStudy(s,backup.study));
 if(applyResult(result)&&result.persisted){try{localStorage.removeItem(STUDY_BACKUP_KEY)}catch{}closeDialog();quizDraft=null;quizShowResult=true;go('hoje');render();toast('Seu estudo anterior foi restaurado.');}
}
function restoreDialog(backup){showDialog('Restaurar o estudo guardado?',`<p>${backup.study.sessions.length} tarefas/planos · ${backup.study.practices.length} práticas · ${(backup.study.repertoire||[]).length} músicas.</p><p>O que foi criado durante o teste vazio será substituído. Você pode exportar o teste antes de restaurar.</p><div class="actions"><button class="button" data-action="export">Exportar o teste atual</button><button class="button primary" id="restore-study-confirm">Restaurar meu estudo</button></div>`);$('#restore-study-confirm').onclick=()=>restoreBackup(backup)}
function experienceHelp(){const backup=!account&&getStudyBackup();return `<article class="guide-help"><div class="page-title"><div><p class="eyebrow">Criasom · ajuda</p><h1>Um passo de cada vez.</h1><p>Seu organizador pessoal de estudo, com espaço para explorar.</p></div></div><div class="actions no-print"><button class="button primary" data-experience="intro">Ver apresentação inicial</button><span class="small muted">Guia ilustrado comercial omitido deste pacote de desenvolvimento.</span><button class="button" data-experience="print">Imprimir instruções desta página</button></div><div class="guide-grid"><section class="card"><h2>1. Escreva e toque</h2><p>Em Meu estudo, escreva uma tarefa e aperte Enter ou Adicionar. Clique na linha para editar. Datas e duração são opcionais.</p><dl><dt>Tocar</dt><dd>Abre a prática e o relógio. Sem duração escolhida, o relógio conta para cima.</dd><dt>□ Marcar</dt><dd>Organiza sua lista. Não comprova domínio musical.</dd><dt>⠿ e •••</dt><dd>Arraste para mudar a ordem, ou abra as opções e use Subir / Descer. As opções também guardam notas, datas e etiquetas.</dd></dl></section><section class="card"><h2>2. Monte seu espaço</h2><dl><dt>Meu repertório</dt><dd>Suas músicas, links e anotações. Adicionar ao meu estudo cria uma tarefa editável.</dd><dt>Minha semana</dt><dd>Seus planos com ou sem data. Um horário na lista não significa uma prática realizada.</dd><dt>Meus registros</dt><dd>O que você contou em Registrar como foi. Guardar e sair preserva uma prática em andamento.</dd><dt>Etiquetas</dt><dd>Vermelho: preciso trabalhar. Amarelo: em desenvolvimento. Verde: pronto para usar. A escolha é sua.</dd></dl></section><section class="card"><h2>3. Use os apoios quando ajudar</h2><p>Assista às aulas e use os guias como complemento. Abrir diagrama mostra a página relacionada da apostila, com ampliação. O metrônomo marca o pulso e a backing acompanha você.</p><p>Comunidade reúne os tópicos gerais, as práticas da Penta e o fórum separado da Academia. Neste piloto, publicações ficam só no seu navegador.</p><p>Personalizador BETA sugere um começo, sem impor uma rotina.</p></section><section class="card"><h2>4. Coloque um ícone no aparelho</h2><p><strong>A instalação será feita pelo endereço publicado com HTTPS.</strong> Este arquivo local ainda não é um app instalável. As etapas abaixo preparam esse momento; nomes dos menus podem variar.</p><dl><dt>iPhone / iPad — Safari</dt><dd>Abra o futuro endereço → Compartilhar → Adicionar à Tela de Início → mantenha Abrir como App, se aparecer → Adicionar.</dd><dt>Android — Chrome</dt><dd>Abra o futuro endereço → menu ⋮ → Adicionar à tela inicial → Instalar, quando disponível. Se aparecer Criar atalho, será apenas um atalho.</dd><dt>Computador — Chrome</dt><dd>Abra o futuro endereço → menu ⋮ → Transmitir, salvar e compartilhar → Instalar esta página como um app → Instalar. A opção pode aparecer também na barra de endereço.</dd></dl><p>O ícone facilita a entrada. Não garante funcionamento sem internet nem cria uma assinatura.</p></section></div><section class="card"><h2>Preciso de ajuda com um botão</h2><p>A+ aumenta as letras. ◐ troca claro e escuro. Iniciar / Pausar controla o relógio. Reiniciar começa uma nova contagem da sessão, preservando os registros anteriores. Guardar e sair permite retomar depois.</p><p>Durante a prática, abrir o diagrama não pausa o relógio. Pause quando quiser interromper o tempo de estudo.</p></section>${!account?`<section class="backup-panel no-print"><h2>Testar o primeiro acesso</h2><p>Guarde seu estudo e abra uma tela vazia. Depois, restaure pela cópia conferida ou pelo arquivo baixado.</p>${backup?`<p><strong>Há um estudo anterior guardado.</strong> ${backup.study.sessions.length} tarefas/planos e ${backup.study.practices.length} práticas.</p><button class="button primary" data-experience="restore">Restaurar meu estudo</button> <button class="button" data-experience="download-backup">Baixar a cópia guardada</button>`:'<button class="button" data-experience="reset-dialog">Guardar e testar do zero</button>'}<label for="restore-study-file">Ou escolher meu arquivo de cópia</label><input type="file" id="restore-study-file" accept="application/json,.json"><p class="small muted">Esta ação nunca limpa login, fórum ou materiais. Sem sincronização entre aparelhos nesta versão local.</p></section>`:''}<p class="print-source">Instruções de ícone: <a href="https://support.apple.com/pt-br/guide/iphone/iph42ab2f3a7/ios" target="_blank" rel="noopener noreferrer">Apple</a> e <a href="https://support.google.com/chrome/answer/9658361?hl=pt-BR" target="_blank" rel="noopener noreferrer">Google Chrome</a>. Conferidas em 17/10/2026. Guia do piloto; o endereço e as telas de instalação serão conferidos após a publicação autorizada.</p></article>`}
document.addEventListener('click',e=>{const b=e.target.closest('[data-experience]');if(!b||b.disabled)return;const a=b.dataset.experience;
 if(a==='intro')showIntroduction();else if(a==='intro-skip')finishIntroduction();else if(a==='intro-back')showIntroduction(introductionIndex-1);else if(a==='intro-next'){if(introductionIndex===INTRO_STEPS.length-1)finishIntroduction();else showIntroduction(introductionIndex+1)}
 else if(a==='quiz-start')startQuiz();else if(a==='quiz-choice'){quizDraft[PROFILE_QUESTIONS[quizIndex].key]=b.dataset.value;render();document.querySelector(`[data-experience="quiz-choice"][data-value="${b.dataset.value}"]`)?.focus()}
 else if(a==='quiz-next')advanceQuiz();else if(a==='quiz-skip')advanceQuiz(true);else if(a==='quiz-back'){quizIndex--;render()}
 else if(a==='print')window.print();else if(a==='reset-dialog')resetDialog();else if(a==='backup-reset')backupAndReset();else if(a==='restore'){const backup=getStudyBackup();if(backup)restoreDialog(backup)}else if(a==='download-backup'){const backup=getStudyBackup();if(backup)downloadStudyBackup(backup)}
});
document.addEventListener('submit',e=>{if(e.target.id!=='profile-apply')return;e.preventDefault();if(account&&!account.has('app'))return;const indices=new FormData(e.target).getAll('suggestion').map(Number),p=state.studyProfile,sig=JSON.stringify(p),ideas=studySuggestions(p),ids=indices.map(()=>makeId('plan'));if(!indices.length){toast('Escolha ao menos uma ideia ou continue sem adicionar.');return}if(tx(s=>{if(s.profileApplied===sig)return s;let next=s;indices.forEach((i,k)=>{if(!ideas[i])throw Error('Escolha uma sugestão válida.');next=planPersonalSession(next,{id:ids[k],personal:ideas[i]})});return {...next,profileApplied:sig}})){go('hoje');toast('Ideias adicionadas. Edite as linhas do seu jeito.')}});
document.addEventListener('change',async e=>{if(e.target.id!=='restore-study-file')return;try{const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw Error('Esta cópia é grande demais para importar aqui.');const backup=JSON.parse(await file.text());if(backup?.format!=='criasom-study-backup/1')throw Error('Escolha uma cópia de estudo do Criasom.');validateState(backup.study);restoreDialog(backup)}catch(error){toast(error.message)}});

render();
maybeIntroduction();
