import {createForum} from './forum-client.mjs';
import {PlatformClient} from './platform-client.mjs';
import {createStudyAccountBridge} from './study-account-bridge.mjs';
import * as model from './model.js';

// Loaded only by the loopback test server. The standalone entry stays unchanged.
const main = document.querySelector('#main');
const nav = document.querySelector('.header nav');
const footer = document.querySelector('footer');
const preferences = document.querySelector('.preferences');
const hiddenStyle = document.createElement('style');
hiddenStyle.textContent = '.header nav[hidden],.preferences[hidden],#account-sync-error[hidden]{display:none!important}';
document.head.append(hiddenStyle);
let bridge = null, started = false, leaving = false, challenge = null, lab = false, labAccounts = [];
const display = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const client = new PlatformClient({onClear() {
  if (!started) return;
  window.CRIASOM_ACCOUNT?.onClear?.(); bridge?.dispose();
  document.querySelector('#account-panel')?.remove();
  document.querySelector('#dialog')?.close();
  nav.hidden = true; preferences.hidden = true;
  main.innerHTML = '<section class="card"><h1>Sessão encerrada nesta tela.</h1><p>Seu progresso confirmado continua na conta.</p><button class="button" id="account-return">Voltar ao acesso</button></section>';
  document.querySelector('#account-return').onclick = () => location.reload();
}});
nav.hidden = true;
preferences.hidden = true;
footer.textContent = 'Teste local de conta · nenhum serviço de e-mail ou compra real conectado.';
function message(text) {const element = document.querySelector('#account-error'); if (element) element.textContent = text;}
async function inspectLocalLab() {
  try {
    const response = await fetch('/__lab/status',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'}});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const data = await response.json();
    lab = data?.lab === true;
    if (lab && Array.isArray(data.accounts)) labAccounts = data.accounts.filter(value => typeof value === 'string' && /^[a-z0-9._+-]+@example\.test$/.test(value)).slice(0,4);
  } catch {lab = false;}
}
function loginForm() {
  challenge = null;
  main.innerHTML = `<section class="card" style="max-width:540px;margin:30px auto"><p class="eyebrow">Criasom · Meu estudo</p><h1>Entre no seu espaço.</h1><p>Use o e-mail da sua compra.</p><form id="account-email-form"><label for="account-email">Seu e-mail</label><input id="account-email" type="email" autocomplete="email" maxlength="254" required><button class="button primary" style="margin-top:18px" type="submit">Receber código</button></form><p id="account-error" role="alert"></p><p class="small muted">Teste local: nenhum e-mail é enviado. Use uma conta fictícia e o código disponibilizado pelo teste. Seus registros antigos deste navegador não serão importados.</p></section>`;
  if (labAccounts.length) {
    const examples = document.createElement('div'); examples.className = 'actions';
    for (const email of labAccounts) {const button = document.createElement('button');button.className='text-button';button.type='button';button.textContent=email;button.onclick=()=>{document.querySelector('#account-email').value=email;};examples.append(button);}
    document.querySelector('#account-email-form').before(examples);
  }
  document.querySelector('#account-email-form').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try {challenge = await client.requestCode(document.querySelector('#account-email').value.trim()); codeForm();}
    catch {message('Não consegui gerar o código. Aguarde um pouco e tente novamente.'); button.disabled = false;}
  };
}
function codeForm() {
  main.innerHTML = `<section class="card" style="max-width:540px;margin:30px auto"><h1>Digite seu código.</h1><p>São 8 números. O código vale por 10 minutos e só pode ser usado uma vez.</p><form id="account-code-form"><label for="account-code">Código de acesso</label><input id="account-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required><button class="button primary" style="margin-top:18px" type="submit">Entrar</button></form><p id="account-error" role="alert"></p><button class="text-button" id="account-other-email">Usar outro e-mail</button><p class="small muted">Ambiente local de teste. Nenhum e-mail real foi enviado.</p></section>`;
  document.querySelector('#account-other-email').onclick = loginForm;
  if (lab) {
    const button = document.createElement('button');button.id='account-lab-code';button.className='button';button.type='button';button.textContent='Ver código de teste';
    document.querySelector('#account-code-form').before(button);
    button.onclick=async()=>{
      const currentChallenge=challenge?.challenge_id, epoch=client.epoch;button.disabled=true;
      try {
        const response=await fetch('/__lab/code',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':client.csrf},body:JSON.stringify({challenge_id:currentChallenge})});
        if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error();
        const data=await response.json();if(!data||typeof data.code!=='string'||!/^\d{8}$/.test(data.code))throw Error();
        if(currentChallenge!==challenge?.challenge_id||epoch!==client.epoch||!document.querySelector('#account-code'))return;
        document.querySelector('#account-code').value=data.code;document.querySelector('#account-code').focus();
      }catch{message('Não consegui consultar este código fictício. Peça um novo código.');}
      finally{button.disabled=false;}
    };
  }
  document.querySelector('#account-code-form').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try {await client.confirmCode(challenge.challenge_id, document.querySelector('#account-code').value); await enter();}
    catch {message('Não consegui confirmar o acesso. Confira o código ou peça outro.'); button.disabled = false;}
  };
}
function paintStatus(status) {
  const label = document.querySelector('#account-sync-status');
  if (label) label.textContent = !client.capabilities.includes('app')&&status.phase==='saved'?'Conta conectada · sem acesso ao estudo':({saved:'Salvo na conta',saving:'Salvando na conta…',conflict:'Outra versão encontrada',error:'Gravação não confirmada','signed-out':'Sessão encerrada'})[status.phase];
  const detail = document.querySelector('#account-sync-error');
  if (detail) {detail.hidden = !status.frozen || status.phase === 'signed-out'; detail.querySelector('p').textContent = status.error || '';}
  window.CRIASOM_ACCOUNT?.onStatus?.(status);
}
async function enter() {
  const initial = client.capabilities.includes('app') ? await client.loadState('study') : {revision:0,data:{}};
  bridge = createStudyAccountBridge({client, model, initial, writable:client.capabilities.includes('app'), onStatus:paintStatus});
  window.CRIASOM_ACCOUNT = {
    forum:createForum({client}), store:bridge.store, user:{...client.user}, capabilities:[...client.capabilities],
    has:scope => client.capabilities.includes('app') && client.capabilities.includes(scope),
    flush:() => bridge.flush(), status:() => bridge.status(), onStatus:null, onClear:null,
  };
  let panel = document.querySelector('#account-panel');
  if (!panel) {panel = document.createElement('section'); panel.id = 'account-panel'; panel.className = 'small'; panel.style.cssText = 'max-width:1180px;margin:12px auto;padding:0 24px'; document.querySelector('.header').after(panel);}
  panel.innerHTML = `<div class="row wrap"><span>${display(client.user.email)}</span><span id="account-sync-status" role="status"></span><button class="text-button" id="account-logout">Sair da conta</button></div><div id="account-sync-error" role="alert" hidden><p></p><p>O que ainda não foi confirmado fica somente nesta tela. Recarregar descarta essas alterações; a versão salva permanece.</p><button class="button" id="account-reload">Recarregar versão salva</button></div>`;
  document.querySelector('#account-reload').onclick = () => location.reload();
  document.querySelector('#account-logout').onclick = async () => {
    if (leaving) return; leaving = true;
    window.CRIASOM_ACCOUNT.beforeLeave?.();
    if (!(await bridge.flush())) {leaving = false; return;}
    try {await client.logout(); location.reload();}
    catch {main.innerHTML = '<section class="card"><h1>Não confirmei a saída no servidor.</h1><p>Os dados pessoais foram retirados desta tela. Confira a conexão e recarregue para tentar sair novamente.</p><button class="button" id="account-retry-logout">Recarregar acesso</button></section>'; document.querySelector('#account-retry-logout').onclick = () => location.reload();}
    finally {leaving = false;}
  };
  nav.hidden = false; preferences.hidden = false;
  footer.textContent = 'Conta em ambiente local · estudo e repertório pessoal salvos no banco deste computador. Fórum conectado às contas de teste. Catálogo didático e envio de arquivos de vídeo ainda não conectados.';
  started = true; paintStatus(bridge.status());
  await import('./app.js');
}
window.addEventListener('beforeunload', event => {
  if (bridge?.status().pending && !leaving) {event.preventDefault(); event.returnValue = '';}
});
try {
  await inspectLocalLab();
  const session = await client.refreshSession();
  if (session.authenticated) await enter(); else loginForm();
} catch {
  nav.hidden = true;
  main.innerHTML = '<section class="card"><h1>Não foi possível abrir sua conta.</h1><p>O serviço local precisa estar em execução. Seus registros antigos continuam preservados.</p><button class="button" id="account-retry">Tentar novamente</button></section>';
  document.querySelector('#account-retry').onclick = () => location.reload();
}
