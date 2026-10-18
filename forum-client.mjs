const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const requestId=()=>crypto.randomUUID().replaceAll('-','');
const when=t=>new Date(t*1000).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});
const safeLink=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const splitLines=value=>String(value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const splitTags=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
const errorText=e=>({'Access denied':'Sua conta não tem acesso a este espaço.','Sign-in required':'Sua sessão terminou. Entre novamente.','State changed; reload before saving':'A conversa mudou. Seu texto continua aqui; atualize antes de tentar novamente.'}[e.message]||'Não consegui confirmar a operação. Seu texto foi mantido. Confira os campos e tente novamente.');

export function createForum({client}) {
  let generation=0,root=null,options=null,current=null;
  let filters={space:'geral',category:'',moduleId:'',practiceId:'',query:'',cursor:0};
  const post=(path,body)=>client.request('/forum/'+path,{method:'POST',body});
  const notify=text=>{const e=document.querySelector('#toast');if(e){e.textContent=text;e.classList.add('visible');setTimeout(()=>e.classList.remove('visible'),4500);}};
  const route=()=>{let p;try{p=decodeURIComponent(location.hash.slice(1)).split('/');}catch{p=['comunidade','geral'];}return {kind:p[0],space:p[0]==='academia'?'agd':p[1]==='agd'?'agd':p[1]==='trocas'?'trocas':'geral',id:p[2]||'',practiceId:p[3]||''};};
  const home=space=>space==='agd'?'#academia':'#comunidade/'+space;
  const nav=space=>`<nav class="forum-spaces" aria-label="Espaços da comunidade"><a href="#comunidade/geral" ${space==='geral'?'aria-current="page"':''}>Fórum geral</a><a href="#comunidade/trocas" ${space==='trocas'?'aria-current="page"':''}>Trocas e vendas</a><a href="#academia" ${space==='agd'?'aria-current="page"':''}>Academia</a>${options?.moderator?'<a href="#comunidade/moderacao">Moderação</a>':''}<button class="text-button" data-forum="profile">Meu perfil</button><button class="text-button" data-forum="terms" data-kind="comunidade">Regras</button></nav>`;
  const notice=()=>'<p class="forum-connected-note"><strong>Teste local com contas.</strong> Tópicos e respostas ficam no banco deste computador. Nenhuma publicação na internet.</p>';
  const links=items=>items?.length?`<ul class="forum-links">${items.map(value=>{const url=safeLink(value);return url?`<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(value)} ↗</a></li>`:'';}).join('')}</ul>`:'';
  const relation=p=>p.module?`<p class="forum-relation">Aplicação em <a href="#modulo/${encodeURIComponent(p.moduleId)}">${esc(p.module.title)}</a>${p.practiceId?' · '+esc(p.module.practices.find(x=>x.id===p.practiceId)?.title||''):''}<span class="small muted"> · Conversa para participantes deste curso.</span></p>`:'';
  const tags=p=>`<div class="forum-tags"><span class="forum-tag" data-category="${esc(p.category)}">${esc(options.categories[p.category])}</span>${p.tags.map(t=>`<span class="forum-tag">${esc(t)}</span>`).join('')}</div>`;
  const card=p=>`<article class="forum-topic">${byline(p.author,p.createdAt)}<h2><a href="#envio/${p.space}/${p.id}">${esc(p.title)}</a></h2>${tags(p)}${relation(p)}<p class="forum-excerpt">${esc(p.body.slice(0,220))}${p.body.length>220?'…':''}</p>${p.images?.length?`<p class="small muted">${p.images.length} ${p.images.length===1?'imagem':'imagens'} na publicação</p>`:''}<a class="text-button" href="#envio/${p.space}/${p.id}">${p.commentCount} ${p.commentCount===1?'resposta':'respostas'} · Abrir conversa →</a></article>`;
  const avatar=p=>p.avatarUrl&&/^\/api\/v1\/forum\/avatars\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}$/.test(p.avatarUrl)?`<img class="forum-avatar" src="${esc(p.avatarUrl)}" alt="Foto de ${esc(p.name)}" width="44" height="44">`:`<span class="forum-avatar forum-avatar-empty" aria-hidden="true">${esc([...p.name][0]||'♪')}</span>`;
  const byline=(p,t)=>`<div class="forum-byline">${avatar(p)}<div><strong>${esc(p.name)}</strong>${t?`<div class="small muted">${when(t)}</div>`:''}</div></div>`;
  const marketNotice=()=>'<aside class="market-safety"><strong>Ser aluno não é garantia de confiança.</strong><p>Confira pessoa e produto. Desconfie de pressa, preço muito baixo e pagamento a terceiros. A Criasom não recebe pagamentos nem garante negociações.</p><button class="text-button" data-forum="terms" data-kind="trocas">Ler os termos de Trocas e vendas</button></aside>';
  async function termsScreen(kind,review=false){
    const token=generation,result=await client.request('/forum/terms/'+kind);if(token!==generation)return;
    const d=result.document;root.innerHTML=`${nav(route().space)}<section class="forum-terms"><p class="eyebrow">Leia antes de participar · versão ${esc(d.version)}</p><h1>${esc(d.title)}</h1><p class="forum-draft-note">${esc(d.status)}</p>${kind==='trocas'?marketNotice():''}<div class="forum-terms-text">${d.sections.map(s=>`<section><h2>${esc(s.title)}</h2><p>${esc(s.text)}</p></section>`).join('')}</div>${result.acceptedAt?`<p class="forum-accepted">Aceite desta conta registrado em ${when(result.acceptedAt)}.</p><button class="button primary" data-forum="refresh">Voltar à comunidade</button>`:`<form id="forum-terms-form" data-kind="${d.kind}" data-version="${esc(d.version)}" data-hash="${d.hash}"><label class="forum-consent"><input type="checkbox" name="accepted" required> Li e aceito estas regras para este teste local.</label>${kind==='trocas'?'<label class="forum-consent"><input type="checkbox" name="adult" required> Declaro ter 18 anos ou mais.</label>':''}<p class="forum-error" role="alert"></p><button class="button primary" type="submit">Aceitar e continuar</button> <a class="button" href="#hoje">Agora não · voltar ao estudo</a></form>`}</section>`;
  }
  function profileScreen(draftName){
    const p=options.profile;root.innerHTML=`${nav(route().space)}<section class="card forum-profile-editor"><p class="eyebrow">Como você aparece na comunidade</p><h1>Meu perfil</h1><p>Escolha um apelido ou nome público. Seu e-mail de acesso não aparece nas conversas.</p><div class="forum-profile-preview">${byline(p)}</div><form id="forum-profile-form"><label for="forum-name">Nome público / apelido</label><input id="forum-name" name="name" maxlength="60" value="${esc(draftName??p.name)}" required><p class="forum-error" role="alert"></p><button class="button primary" type="submit">Salvar nome</button></form><hr><label for="forum-photo">Foto de perfil (opcional)</label><input id="forum-photo" type="file" accept="image/jpeg,image/png,image/webp"><p class="small muted">JPG, PNG ou WebP, até 5 MB. A imagem será recortada no centro. Ao escolher, a foto é salva para aparecer nos seus tópicos e respostas. Use uma imagem sua ou autorizada.</p><p id="forum-photo-status" role="status"></p>${p.avatarUrl?'<button class="text-button" data-forum="remove-avatar">Remover minha foto</button>':''}<div class="actions"><button class="button" data-forum="refresh">Voltar ao fórum</button></div></section>`;
  }
  async function prepareAvatar(file){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024)throw Error('Use JPG, PNG ou WebP de até 5 MB.');
    let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw Error('Não consegui abrir a foto. Escolha outra imagem.');}
    try{
      if(bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>24000000)throw Error('Escolha uma foto menor, de até 24 megapixels.');
      const c=document.createElement('canvas');c.width=c.height=192;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,192,192);const edge=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-edge)/2,(bitmap.height-edge)/2,edge,edge,0,0,192,192);
      const data=c.toDataURL('image/jpeg',0.82);if(data.length>90000)throw Error('A foto ficou muito grande. Escolha outra imagem.');return data;
    }finally{bitmap.close();}
  }
  function reportScreen(){
    root.querySelector('#forum-report-form')?.remove();const form=document.createElement('form');form.id='forum-report-form';form.className='card forum-report';form.dataset.post=current.post.id;
    form.innerHTML='<h2>Denunciar este tópico</h2><p>Não inclua senhas, documentos ou dados bancários. A denúncia aparece no painel de moderação deste piloto, sem notificação externa.</p><label for="forum-report-reason">Motivo</label><select id="forum-report-reason" name="reason"><option value="fraude">Suspeita de golpe</option><option value="identidade">Falsa identidade</option><option value="abuso">Abuso ou conteúdo impróprio</option><option value="spam">Spam</option><option value="outro">Outro motivo</option></select><label for="forum-report-detail">O que aconteceu? (opcional)</label><textarea id="forum-report-detail" name="detail" maxlength="1000" rows="3"></textarea><p class="forum-error" role="alert"></p><button class="button" type="submit">Registrar denúncia no teste</button> <button class="text-button" type="button" data-forum="cancel-report">Cancelar</button>';
    root.querySelector('.forum-detail').after(form);form.querySelector('select').focus();
  }

  let moderationState={status:'pending',cursor:0},draftImages=[];
  const imageUrl=u=>/^\/api\/v1\/forum\/images\/[a-f0-9]{32}\/[a-f0-9]{64}$/.test(u||'');
  const pictures=items=>items?.length?`<div class="forum-post-images">${items.filter(i=>imageUrl(i.url)).map((i,n)=>`<a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="Imagem ${n+1} da publicação" loading="lazy" width="${i.width}" height="${i.height}"></a>`).join('')}</div>`:'';
  function imagePreview(){const holder=root.querySelector('#forum-image-previews');if(holder)holder.innerHTML=draftImages.map((i,n)=>`<div>${pictures([i])}<button class="text-button" type="button" data-forum="remove-image" data-index="${n}">Retirar imagem ${n+1}</button></div>`).join('');}
  async function preparePostImage(file){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('Escolha JPG, PNG ou WebP de até 10 MB.');
    let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw Error('Não consegui abrir esta imagem.');}
    try{if(bitmap.width*bitmap.height>40000000||bitmap.width>12000||bitmap.height>12000)throw Error('Escolha uma imagem de até 40 megapixels.');
      for(const side of [1280,960,640]){const factor=Math.min(1,side/Math.max(bitmap.width,bitmap.height)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(bitmap.width*factor));c.height=Math.max(1,Math.round(bitmap.height*factor));const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(bitmap,0,0,c.width,c.height);for(const quality of [.82,.65,.45]){const data=c.toDataURL('image/jpeg',quality);if(data.length<100000)return data;}}throw Error('A imagem ficou grande demais. Escolha uma menor.');
    }finally{bitmap.close();}
  }
  async function addPostImages(input){
    const form=input.closest('form'),token=generation,files=[...input.files],status=form.querySelector('#forum-image-status'),submit=form.querySelector('[type=submit]');
    if(files.length+draftImages.length>3){status.textContent='Use até três imagens por publicação.';input.value='';return;}
    input.disabled=true;submit.disabled=true;form.dataset.imagesBusy='true';
    try{for(const file of files){status.textContent='Preparando imagem…';const image=await preparePostImage(file);if(token!==generation||!form.isConnected)return;const result=await post('images',{image,requestId:requestId()});if(token!==generation||!form.isConnected)return;draftImages.push(result.image);imagePreview();}status.textContent='Imagens prontas. Elas aparecem na conversa quando você salvar a publicação.';}
    catch(e){if(form.isConnected)status.textContent=e.message==='Operation unavailable'?'Não consegui salvar a imagem. As anteriores foram mantidas.':e.message;}
    finally{if(form.isConnected){delete form.dataset.imagesBusy;input.disabled=false;input.value='';submit.disabled=false;}}
  }
  const modNames={hide:'Remover publicação do fórum',restore:'Restaurar publicação',block:'Bloquear na comunidade',unblock:'Desbloquear participante',resolve:'Marcar denúncia como resolvida',dismiss:'Arquivar sem medida'};
  const reportNames={fraude:'Suspeita de golpe',identidade:'Falsa identidade',abuso:'Abuso ou conteúdo impróprio',spam:'Spam',outro:'Outro motivo'};
  const modButton=(action,id,label)=>`<button class="button ${action==='hide'||action==='block'?'forum-danger':''}" data-forum="moderate" data-action="${action}" data-target="${esc(id)}">${label||modNames[action]}</button>`;
  const modPost=p=>`<div class="forum-mod-post">${byline(p.author,p.createdAt)}<h3>${esc(p.title)}</h3><p class="forum-mod-status">${p.removedByAuthor?'Removida pelo autor':p.hidden?'Removida pela moderação':'Visível na comunidade'} · ${p.space==='trocas'?'Trocas e vendas':p.space==='agd'?'Academia':'Fórum geral'}</p><p class="forum-body">${esc(p.body)}</p>${pictures(p.images)}${links(p.links)}<div class="actions">${!p.removedByAuthor?modButton(p.hidden?'restore':'hide',p.id):''}${!p.authorModerator?modButton(p.authorBlocked?'unblock':'block',p.author.id):'<span class="small muted">Conta de moderação</span>'}</div></div>`;
  async function moderationScreen(){
    const token=generation,result=await post('moderation/list',moderationState);if(token!==generation)return;
    root.innerHTML=`${nav('moderacao')}<header class="page-title"><div><p class="eyebrow">Acesso da moderação · teste local</p><h1>Moderação da comunidade</h1><p>Veja denúncias, remova publicações e controle a participação. Cada medida registra quem fez, quando e o motivo.</p></div><span class="forum-mod-count">${result.pendingCount} ${result.pendingCount===1?'denúncia pendente':'denúncias pendentes'}</span></header><p class="forum-connected-note">Bloquear impede o uso da comunidade. O estudo pessoal e os cursos continuam disponíveis. Remover aqui oculta a publicação; o registro é preservado para revisão.</p><div id="forum-moderation-confirm" aria-live="polite"></div><form id="forum-moderation-filter" class="forum-search"><label for="forum-mod-status">Denúncias</label><select id="forum-mod-status" name="status"><option value="pending" ${moderationState.status==='pending'?'selected':''}>Pendentes</option><option value="resolved" ${moderationState.status==='resolved'?'selected':''}>Resolvidas</option><option value="dismissed" ${moderationState.status==='dismissed'?'selected':''}>Arquivadas sem medida</option></select><button type="submit" class="button">Atualizar painel</button></form><section class="forum-moderation-reports">${result.reports.length?result.reports.map(r=>`<article class="card forum-report-card"><h2>${esc(reportNames[r.reason]||r.reason)}</h2><p>Denúncia de <strong>${esc(r.reporter.name)}</strong> em ${when(r.createdAt)}. A identidade de quem denuncia aparece somente à moderação.</p><p class="forum-body">${esc(r.detail||'Sem relato adicional.')}</p>${r.snapshot?`<details><summary>Texto no momento da denúncia</summary><h3>${esc(r.snapshot.title)}</h3><p class="forum-body">${esc(r.snapshot.body)}</p></details>`:'<p class="small muted">Registro anterior: sem cópia do texto no momento da denúncia.</p>'}${modPost(r.post)}${r.status==='pending'?`<div class="actions">${modButton('resolve',r.id)}${modButton('dismiss',r.id)}</div>`:''}</article>`).join(''):'<p class="community-empty">Nenhuma denúncia nesta lista.</p>'}</section><div class="actions">${moderationState.cursor?'<button class="button" data-forum="mod-previous">Anterior</button>':''}${result.nextCursor!==null?`<button class="button" data-forum="mod-next" data-cursor="${result.nextCursor}">Mais denúncias</button>`:''}</div><details class="card"><summary>Publicações recentes · moderar mesmo sem denúncia</summary>${result.recentPosts.length?result.recentPosts.map(modPost).join(''):'<p>Nenhuma publicação ainda.</p>'}<p class="small muted">Mostrando as 20 mais recentes.</p></details><details class="card"><summary>Participantes · bloquear ou desbloquear</summary>${(result.participants||[]).map(m=>`<div class="forum-mod-post">${byline(m.profile)}<p class="small muted">Conta ${esc(m.profile.id.slice(-6))}${m.moderator?' · Moderação':''}</p>${!m.moderator?modButton(m.blocked?'unblock':'block',m.profile.id):''}</div>`).join('')}<p class="small muted">Até 100 participantes com perfil ou publicação neste piloto.</p></details><details class="card"><summary>Participantes bloqueados (${result.blocked.length})</summary>${result.blocked.map(b=>`<div class="forum-mod-post">${byline(b.profile,b.since)}<p>${esc(b.reason)}</p>${modButton('unblock',b.profile.id)}</div>`).join('')||'<p>Nenhum participante bloqueado.</p>'}</details><details class="card"><summary>Histórico de medidas</summary>${result.audit.map(a=>`<p><strong>${esc(modNames[a.action]||a.action)}</strong> · ${esc(a.moderator.name)} · ${when(a.at)}<br>${esc(a.reason)}</p>`).join('')||'<p>Nenhuma medida registrada.</p>'}<p class="small muted">Últimas 30 medidas. O histórico integral permanece no banco local.</p></details>`;
  }
  function confirmModeration(b){
    const holder=root.querySelector('#forum-moderation-confirm'),action=b.dataset.action;
    holder.innerHTML=`<form id="forum-moderation-action" class="card forum-mod-confirm" data-action="${esc(action)}" data-target="${esc(b.dataset.target)}" data-request="${requestId()}"><h2>${esc(modNames[action])}</h2><p>${action==='block'?'A pessoa perderá o acesso à comunidade. Isso não cancela o acesso aos cursos.':action==='hide'?'A publicação e suas imagens deixam de aparecer aos participantes. Você poderá restaurá-la.':'Esta medida ficará registrada no histórico.'}</p><label for="forum-mod-reason">Motivo da medida</label><textarea id="forum-mod-reason" name="reason" maxlength="500" required rows="2" placeholder="Descreva a regra e o que foi observado."></textarea><p class="forum-error" role="alert"></p><button class="button primary" type="submit">Confirmar medida</button> <button class="button" type="button" data-forum="cancel-moderation">Cancelar</button></form>`;holder.querySelector('textarea').focus();holder.scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  function categories(selected,empty=false){return (empty?'<option value="">Todos os temas</option>':'')+Object.entries(options.categories).map(([id,label])=>`<option value="${id}" ${selected===id?'selected':''}>${esc(label)}</option>`).join('');}
  function modules(selected){return '<option value="">Sem vínculo com curso</option>'+options.modules.map(m=>`<option value="${esc(m.id)}" ${m.id===selected?'selected':''}>${esc(m.title)}</option>`).join('');}
  function practices(mid,pid){return '<option value="">Módulo inteiro</option>'+(options.modules.find(m=>m.id===mid)?.practices||[]).map(p=>`<option value="${esc(p.id)}" ${p.id===pid?'selected':''}>${esc(p.title)}</option>`).join('');}
  function bind(){root.addEventListener('click',onClick);root.addEventListener('submit',onSubmit);root.addEventListener('change',onChange);}
  async function mount(element){
    const token=++generation;root=element;if(!root)return;current=null;
    root.innerHTML='<p role="status">Abrindo a comunidade da sua conta…</p>';
    try {
      options=await client.request('/forum/options');if(token!==generation)return;
      const r=route();
      if(options.blocked){root.innerHTML=`<section class="card"><h1>Participação na comunidade bloqueada</h1><p>${esc(options.blocked.reason)}</p><p>Seu estudo pessoal e seus cursos continuam disponíveis. Para solicitar uma revisão, fale com o responsável pela comunidade.</p><a class="button primary" href="#hoje">Voltar ao meu estudo</a></section>`;return;}
      if(!options.terms.comunidade.acceptedAt){await termsScreen('comunidade');bind();return;}
      if(r.space==='trocas'&&!options.terms.trocas.acceptedAt){await termsScreen('trocas');bind();return;}
      if(location.hash==='#comunidade/moderacao'){if(!options.moderator)throw Error('Access denied');if(!options.terms.trocas.acceptedAt){await termsScreen('trocas');bind();return;}await moderationScreen();bind();return;}
      if(!options.spaces.includes(r.space)){root.innerHTML=`${nav(r.space)}<section class="card"><h1>Este espaço é da Academia.</h1><p>Seu acesso ao fórum geral continua disponível. A Academia tem acesso próprio.</p><a class="button" href="#comunidade/geral">Ir ao fórum geral</a></section>`;return;}
      if(r.kind==='envio') {const result=await client.request('/forum/posts/'+r.id);if(token!==generation)return;current=result;detail();}
      else if(r.kind==='compartilhar'){composer(null,r);}
      else {
        if(filters.space!==r.space||filters.moduleId!==r.id||filters.practiceId!==r.practiceId)filters={space:r.space,category:r.id?'aplicacao':'',moduleId:r.id,practiceId:r.practiceId,query:'',cursor:0};
        const result=await post('list',filters);if(token!==generation)return;feed(result);
      }
      bind();
    }catch(e){if(token===generation&&root?.isConnected)root.innerHTML=`<section class="card"><h1>Não foi possível abrir esta conversa.</h1><p role="alert">${esc(errorText(e))}</p><p>Ela pode ter sido removida ou pertencer a um curso que sua conta não possui.</p><a class="button" href="#comunidade/geral">Voltar ao fórum</a><button class="text-button" data-forum="refresh">Tentar novamente</button></section>`;if(token===generation)bind();}
  }
  function profile(){return `<details class="forum-profile"><summary>Você aparece como ${esc(options.profile.name)}</summary><form id="forum-profile-form"><label for="forum-name">Nome na comunidade</label><input id="forum-name" name="name" maxlength="60" value="${esc(options.profile.name)}" required><p class="small muted">Seu e-mail de login não aparece nos tópicos.</p><p class="forum-error" role="alert"></p><button class="button" type="submit">Salvar nome</button></form></details>`;}
  function feed(result){
    const r=route();root.innerHTML=`${nav(r.space)}<div class="page-title"><div><p class="eyebrow">Comunidade Criasom</p><h1>${r.space==='agd'?'Fórum da Academia':r.space==='trocas'?'Trocas e vendas':'Vamos conversar sobre música.'}</h1><p class="muted">${r.space==='trocas'?'Instrumentos, equipamentos e acessórios entre participantes.':'Uma dúvida, uma descoberta ou um assunto novo. O espaço também é seu.'}</p></div><a class="button primary" href="#compartilhar/${r.space}${filters.moduleId?'/'+encodeURIComponent(filters.moduleId)+(filters.practiceId?'/'+encodeURIComponent(filters.practiceId):''):''}">${r.space==='trocas'?'Criar anúncio':'Criar tópico'}</a></div>${notice()}${r.space==='trocas'?marketNotice():''}
    ${r.space==='agd'?'<p><a class="button" href="https://hotmart.com/pt-br/club/guitarra-desbloqueada/" target="_blank" rel="noopener noreferrer">Assistir aos desafios no Club ↗</a></p>':''}
    ${r.space==='trocas'?'':`<div class="forum-categories" aria-label="Temas"><button data-forum="category" data-category="" aria-pressed="${!filters.category}">Todos</button>${Object.entries(options.categories).map(([id,label])=>`<button data-forum="category" data-category="${id}" aria-pressed="${filters.category===id}">${esc(label)}</button>`).join('')}</div>`}
    <form id="forum-search-form" class="forum-search"><label class="sr-only" for="forum-query">Buscar conversas ou etiquetas</label><input id="forum-query" name="query" maxlength="100" value="${esc(filters.query)}" placeholder="Buscar conversas ou etiquetas…"><button class="button" type="submit">Buscar</button><button class="text-button" type="button" data-forum="refresh">Atualizar</button></form>
    ${filters.moduleId?`<p class="forum-relation">Conversas de ${esc(options.modules.find(m=>m.id===filters.moduleId)?.title||'um módulo')} <a href="#comunidade/geral">Ver todo o fórum</a></p>`:''}
    <div id="forum-topics">${result.posts.length?result.posts.map(card).join(''):`<section class="community-empty"><h2>${r.space==='trocas'?'Ainda não há anúncios por aqui.':'A conversa pode começar com você.'}</h2><p>${r.space==='trocas'?'Use Criar anúncio e descreva o que quer vender, trocar ou procurar.':'Crie um tópico sobre o que está tocando, ouvindo ou tentando resolver.'}</p></section>`}</div>
    <div class="actions">${filters.cursor?'<button class="button" data-forum="previous">← Página anterior</button>':''}${result.nextCursor!==null?`<button class="button" data-forum="next" data-cursor="${result.nextCursor}">Mais conversas →</button>`:''}</div><p class="small muted">Você participa como ${esc(options.profile.name)}. <button class="text-button" data-forum="profile">Editar nome e foto</button></p>`;
  }
  function linkField(id,value=[]){return `<label for="${id}">Links de vídeos, áudios ou referências <span class="muted">(opcional)</span></label><textarea id="${id}" name="links" rows="2" maxlength="10244" placeholder="Cole um endereço por linha, começando com https://">${esc(value.join('\n'))}</textarea><p class="small muted">Até cinco links. Abrem no site de origem; nenhum arquivo é enviado ou incorporado automaticamente.</p>`;}
  function composer(p,r=route()){
    draftImages=[...(p?.images||[])];
    const mid=p?.moduleId||(r.kind==='compartilhar'?r.id:''),pid=p?.practiceId||r.practiceId||'';
    root.innerHTML=`${nav(r.space)}${p?'<button class="text-button" data-forum="cancel-edit">← Voltar à conversa</button>':`<a class="text-button" href="${home(r.space)}">← Voltar</a>`}<h1>${p?'Editar meu tópico':r.space==='trocas'?'O que você quer vender, trocar ou procurar?':'Que assunto você quer trazer?'}</h1>${notice()}${r.space==='trocas'?marketNotice():''}<form id="forum-topic-form" class="card forum-composer" data-request="${requestId()}" ${p?`data-post="${p.id}" data-revision="${p.revision}"`:''}>
    <label for="forum-title">Título</label><input id="forum-title" name="title" required maxlength="160" value="${esc(p?.title||'')}" placeholder="Ex.: como vocês escolhem um timbre para estudar?">
    <label for="forum-body">Conte sua ideia <span class="muted">(opcional)</span></label><textarea id="forum-body" name="body" maxlength="6000" rows="5" placeholder="Escreva com suas palavras.">${esc(p?.body||'')}</textarea>
    <label for="forum-post-photos">Imagens (opcional)</label><input id="forum-post-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><p class="small muted">Até três imagens. JPG, PNG ou WebP de até 10 MB cada; o app reduz o tamanho. Use fotos próprias ou autorizadas. Clique em uma imagem publicada para ampliar.</p><div id="forum-image-previews" class="forum-image-previews"></div><p id="forum-image-status" role="status"></p>
    <details ${mid?'open':''}><summary>${r.space==='trocas'?'Links e etiquetas (opcional)':'Links, tema e módulo (opcional)'}</summary>${linkField('forum-links',p?.links)}${r.space==='trocas'?'<input type="hidden" name="category" value="equipamentos">':`<label for="forum-category">Tema</label><select id="forum-category" name="category">${categories(p?.category||(mid?'aplicacao':filters.category||'conversas'))}</select>`}
    <label for="forum-tags">Suas etiquetas</label><input id="forum-tags" name="tags" maxlength="154" value="${esc(p?.tags.join(', ')||'')}" placeholder="Ex.: blues, pedais, ouvido"><p class="small muted">Até cinco, separadas por vírgula. Você pode criar outros assuntos.</p>
    ${r.space==='trocas'?'':p?relation(p):`<label for="forum-module">Ligar a um módulo</label><select id="forum-module" name="moduleId">${modules(mid)}</select><label for="forum-practice">Prática relacionada</label><select id="forum-practice" name="practiceId" ${mid?'':'disabled'}>${practices(mid,pid)}</select><p class="small muted">Opcional. Com vínculo, a conversa aparece no módulo e fica entre os participantes desse curso.</p>`}</details>
    <p class="small muted">${r.space==='agd'?'Participantes autorizados da Academia.':r.space==='trocas'?'Informe estado, defeitos conhecidos e condições do produto. Não publique documentos ou dados bancários.':'Sem vínculo com módulo, participantes do fórum geral podem ler e responder.'}</p><p class="forum-error" role="alert"></p><button class="button primary" type="submit">${p?'Salvar alterações':r.space==='trocas'?'Publicar anúncio':'Publicar tópico'}</button></form>`;imagePreview();
  }
  function comment(c){return `<li class="forum-reply">${byline(c.author,c.createdAt)}<p class="forum-body">${esc(c.body)}</p>${links(c.links)}${c.own&&!c.deleted?`<button class="text-button" data-forum="remove-comment" data-comment="${c.id}">Remover minha resposta</button>`:''}</li>`;}
  function detail(){
    const p=current.post;root.innerHTML=`${nav(p.space)}<a class="text-button" href="${home(p.space)}">← Voltar ao fórum</a>${notice()}${p.space==='trocas'?marketNotice():''}<article class="card forum-detail">${byline(p.author,p.createdAt)}<h1>${esc(p.title)}</h1>${tags(p)}${relation(p)}<p class="forum-body">${esc(p.body)}</p>${pictures(p.images)}${links(p.links)}${p.own?'<div class="actions"><button class="text-button" data-forum="edit">Editar meu tópico</button><button class="text-button" data-forum="remove-post">Remover meu tópico</button></div>':''}<button class="text-button" data-forum="report">Denunciar tópico</button></article>
    <section class="forum-conversation"><div class="row wrap"><h2>Conversa</h2><button class="text-button" data-forum="refresh">Atualizar conversa</button></div><ol class="forum-replies">${current.comments.map(comment).join('')}</ol>${current.comments.length?'':'<p class="muted">Seja a primeira pessoa a responder.</p>'}${current.nextCursor!==null?`<button class="button" data-forum="more-comments" data-cursor="${current.nextCursor}">Ler mais respostas</button>`:''}
    <form id="forum-reply-form" data-post="${p.id}" data-request="${requestId()}"><label for="forum-reply">Sua resposta</label><textarea id="forum-reply" name="body" maxlength="4000" rows="3" placeholder="Troque uma ideia com quem publicou."></textarea><details><summary>Adicionar links (opcional)</summary>${linkField('forum-reply-links')}</details><p class="small muted">Você responde como ${esc(options.profile.name)}.</p><p class="forum-error" role="alert"></p><button class="button primary" type="submit">Responder</button></form></section>`;
  }
  async function reloadFeed(){const token=generation;try{const result=await post('list',filters);if(token===generation&&root?.isConnected){feed(result);}}catch(e){if(token===generation)notify(errorText(e));}}
  async function onChange(e){if(e.target.id==='forum-post-photos'){await addPostImages(e.target);return;}if(e.target.id==='forum-photo'){
      const file=e.target.files?.[0];if(!file)return;const token=generation,status=root.querySelector('#forum-photo-status'),draftName=root.querySelector('#forum-name')?.value;e.target.disabled=true;status.textContent='Preparando e salvando foto…';
      try{const data=await prepareAvatar(file);if(token!==generation)return;const result=await post('avatar',{image:data});if(token!==generation)return;options.profile=result.profile;profileScreen(draftName);notify('Foto salva na comunidade.');}
      catch(error){if(token===generation&&status.isConnected)status.textContent=error.message==='Operation unavailable'?'Não consegui salvar a foto. A foto anterior foi mantida.':error.message;}
      finally{if(e.target.isConnected)e.target.disabled=false;}return;
    }if(e.target.id==='forum-module'){const select=root.querySelector('#forum-practice');select.innerHTML=practices(e.target.value,'');select.disabled=!e.target.value;if(e.target.value)root.querySelector('#forum-category').value='aplicacao';}}
  async function onClick(e){
    const b=e.target.closest('[data-forum]');if(!b)return;e.preventDefault();const action=b.dataset.forum,token=generation;b.disabled=true;
    try{
      if(action==='moderate'){confirmModeration(b);return;}
      if(action==='cancel-moderation'){root.querySelector('#forum-moderation-confirm').innerHTML='';return;}
      if(action==='mod-next'||action==='mod-previous'){moderationState.cursor=action==='mod-next'?Number(b.dataset.cursor):Math.max(0,moderationState.cursor-20);await moderationScreen();return;}
      if(action==='remove-image'){draftImages.splice(Number(b.dataset.index),1);imagePreview();return;}
      if(action==='profile')profileScreen();
      else if(action==='terms')await termsScreen(b.dataset.kind,true);
      else if(action==='remove-avatar'){const draftName=root.querySelector('#forum-name')?.value;const result=await post('avatar',{image:null});if(token!==generation)return;options.profile=result.profile;profileScreen(draftName);notify('Foto removida.');}
      else if(action==='report')reportScreen();
      else if(action==='cancel-report')b.closest('form').remove();
      else if(action==='category'){filters.category=b.dataset.category;filters.cursor=0;await reloadFeed();}
      else if(action==='next'||action==='previous'){filters.cursor=action==='next'?Number(b.dataset.cursor):Math.max(0,filters.cursor-20);await reloadFeed();}
      else if(action==='refresh')await mount(root);
      else if(action==='cancel-edit')detail();
      else if(action==='edit')composer(current.post,{...route(),space:current.post.space});
      else if(action==='more-comments'){
        const more=await post('posts/'+current.post.id+'/comments-list',{cursor:Number(b.dataset.cursor)});if(token!==generation)return;
        const list=root.querySelector('.forum-replies');list.insertAdjacentHTML('beforeend',more.comments.map(comment).join(''));current.comments.push(...more.comments);current.nextCursor=more.nextCursor;
        if(more.nextCursor===null)b.remove();else b.dataset.cursor=more.nextCursor;
      }else if(action==='remove-post'||action==='remove-comment'){
        const form=document.createElement('form');form.id='forum-remove-form';form.dataset.post=current.post.id;if(action==='remove-comment')form.dataset.comment=b.dataset.comment;
        form.innerHTML='<p>Remover '+(action==='remove-comment'?'sua resposta':'seu tópico e ocultar a conversa')+' deste fórum?</p><p class="forum-error" role="alert"></p><button class="button" type="button" data-forum="cancel-remove">Cancelar</button> <button class="button" type="submit">Confirmar remoção</button>';b.after(form);b.hidden=true;
      }else if(action==='cancel-remove'){const form=b.closest('form');form.previousElementSibling.hidden=false;form.remove();}
    }catch(error){if(token===generation)notify(errorText(error));}finally{if(b.isConnected)b.disabled=false;}
  }
  async function onSubmit(e){
    const f=e.target;if(!f.id.startsWith('forum-'))return;e.preventDefault();const token=generation,v=new FormData(f),button=f.querySelector('[type=submit]');button.disabled=true;const error=f.querySelector('.forum-error');if(error)error.textContent='';
    try {
      if(f.id==='forum-moderation-filter'){moderationState={status:v.get('status'),cursor:0};await moderationScreen();return;}
      if(f.id==='forum-moderation-action'){await post('moderation/action',{action:f.dataset.action,targetId:f.dataset.target,reason:v.get('reason'),requestId:f.dataset.request});if(token!==generation)return;notify('Medida registrada no painel local.');await moderationScreen();return;}
      if(f.id==='forum-terms-form'){
        await post('terms/accept',{kind:f.dataset.kind,version:f.dataset.version,documentHash:f.dataset.hash,accepted:v.get('accepted')==='on',adult:v.get('adult')==='on'});if(token!==generation)return;await mount(root);return;
      }
      if(f.id==='forum-report-form'){const result=await post('posts/'+f.dataset.post+'/report',{reason:v.get('reason'),detail:v.get('detail')||''});if(token!==generation)return;f.innerHTML='<p role="status">'+esc(result.message)+'</p>';return;}
      if(f.id==='forum-search-form'){filters.query=String(v.get('query')||'');filters.cursor=0;await reloadFeed();return;}
      if(f.id==='forum-profile-form'){const result=await post('profile',{name:v.get('name')});if(token!==generation)return;options.profile=result.profile;notify('Nome salvo na comunidade.');profileScreen();return;}
      if(f.id==='forum-topic-form'){
        if(f.dataset.imagesBusy)throw Error('Aguarde o preparo das imagens.');
        const content={title:v.get('title'),body:v.get('body'),category:v.get('category'),links:splitLines(v.get('links')),tags:splitTags(v.get('tags')),imageIds:draftImages.map(i=>i.id)};
        if(content.links.length>5||content.links.some(x=>!safeLink(x)))throw Error('links');
        if(content.tags.length>5||content.tags.some(x=>[...x].length>30))throw Error('tags');
        let result;
        if(f.dataset.post)result=await post('posts/'+f.dataset.post+'/edit',{...content,expectedRevision:Number(f.dataset.revision)});
        else result=await post('posts',{...content,requestId:f.dataset.request,space:route().space,moduleId:v.get('moduleId')||'',practiceId:v.get('practiceId')||''});
        if(token!==generation)return;location.hash='envio/'+result.post.space+'/'+result.post.id;notify(f.dataset.post?'Tópico atualizado.':'Tópico publicado no teste local.');
        if(f.dataset.post)await mount(root);
      }else if(f.id==='forum-reply-form'){
        const reply={body:v.get('body'),links:splitLines(v.get('links')),requestId:f.dataset.request};
        if(!reply.body.trim()&&!reply.links.length)throw Error('empty');if(reply.links.length>5||reply.links.some(x=>!safeLink(x)))throw Error('links');
        await post('posts/'+f.dataset.post+'/comments',reply);if(token!==generation)return;notify('Resposta salva na conversa.');await mount(root);
      }else if(f.id==='forum-remove-form'){
        await post('posts/'+f.dataset.post+(f.dataset.comment?'/comments/'+f.dataset.comment:'')+'/remove',{});if(token!==generation)return;
        if(f.dataset.comment)await mount(root);else location.hash=home(current.post.space);notify('Removido deste fórum.');
      }
    }catch(e){if(token===generation&&error)error.textContent=({links:'Use até cinco links http:// ou https://, um por linha.',tags:'Use até cinco etiquetas de até 30 caracteres.',empty:'Escreva uma resposta ou adicione um link.'}[e.message]||errorText(e));}
    finally{if(button.isConnected)button.disabled=false;}
  }
  return {mount,clear(){generation++;if(root){root.removeEventListener('click',onClick);root.removeEventListener('submit',onSubmit);root.removeEventListener('change',onChange);}root=null;current=null;options=null;}};
}
