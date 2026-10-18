window.REPERTORIO_ARCHIVED_IDS=[];
window.REPERTORIO_HOST=true;
(function(){
 const base="../index.html",valid=new RegExp('^#(?:hoje|semana|cursos|academia|como|progresso|curso|modulo|pratica|comunidade|envio|compartilhar)(?:/[A-Za-z0-9:_%~-]+)*$');
 try{const r=JSON.parse(sessionStorage.getItem('criasom.repertoire.return.v1')||'null');if(r&&r.version===1&&typeof r.hash==='string'&&r.hash.length<=256&&valid.test(r.hash))document.getElementById('study-return').href=base+r.hash;}catch(_){}
 function font(){let value=0;try{value=Number(localStorage.getItem('criasom.ui.font'))||0;}catch(_){}value=[0,1,2].includes(value)?value:0;document.documentElement.style.fontSize=[17,19,21][value]+'px';document.getElementById('host-font').textContent=['A+','A++','A'][value];document.getElementById('host-font').setAttribute('aria-label',value===2?'Restaurar tamanho do texto':'Aumentar tamanho do texto');return value;}
 document.getElementById('host-font').addEventListener('click',()=>{try{localStorage.setItem('criasom.ui.font',String((font()+1)%3));font();}catch(_){}});font();window.addEventListener('pageshow',font);window.addEventListener('storage',e=>{if(e.key==='criasom.ui.font')font();});
})();
