import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// These generated directories never belong in an exported source package.
const ignored=new Set(['.git','.local','.venv','node_modules','vendor','outputs','__pycache__']);
const allowed=new Set(['.md','.txt','.json','.js','.mjs','.cjs','.css','.html','.php','.py','.sql','.png','.pdf','.sha256']);
const findings=[];let count=0;
function visit(dir){
  for(const e of readdirSync(dir,{withFileTypes:true})){
    if(ignored.has(e.name)||/^http-pdo-fixture-/.test(e.name))continue;
    const full=path.join(dir,e.name),rel=path.relative(root,full).replaceAll('\\','/');
    if(e.isSymbolicLink()){findings.push(rel+': link simbólico');continue;}
    if(e.isDirectory()){visit(full);continue;}
    count++;
    const ext=path.extname(e.name).toLowerCase();
    if(!allowed.has(ext)&&!['.gitignore','.gitattributes'].includes(e.name))findings.push(rel+': tipo de arquivo não autorizado');
    if(/^(?:\.env(?:\.|$)|config\.local\.)/i.test(e.name))findings.push(rel+': configuração privada');
    if(['.png','.pdf'].includes(ext))continue;
    const text=readFileSync(full,'utf8');
    const checks=[
      ['chave privada',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ['token GitHub',/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
      ['caminho privado do computador',/[A-Za-z]:[\\/](?:Users|Codex)[\\/]/],
      ['identificador interno de tarefa',/task-notion-[a-f0-9]{20,}/],
    ];
    for(const[label,re]of checks)if(re.test(text))findings.push(rel+': '+label);
  }
}
visit(root);
if(findings.length){process.stderr.write(findings.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(`${count} arquivos de distribuição conferidos. Estado local e dependências foram excluídos desta verificação; não os envie ao GitHub. Esta checagem não substitui revisão humana.\n`);
