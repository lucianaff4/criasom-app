import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {phpRuntime} from './php-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(exe,args)=>{
  const r=spawnSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true});
  if(r.status!==0){process.stderr.write((r.stdout||'')+(r.stderr||''));throw Error('Falha em '+args.at(-1));}
  return (r.stdout||'')+(r.stderr||'');
};
const js=[...readdirSync(path.join(root,'work/production-base/tests')).filter(x=>x.endsWith('.test.mjs')).map(x=>'work/production-base/tests/'+x),
  'work/criasom-app-piloto/model.test.cjs','work/criasom-app-piloto/personal-study.test.cjs'];
const out=run(process.execPath,['--test','--test-reporter=tap',...js]);
process.stdout.write(out.split('\n').filter(x=>/^# (tests|pass|fail|duration)/.test(x)).join('\n')+'\n');
const {php,flags}=phpRuntime();let total=0;
for(const name of readdirSync(path.join(root,'work/production-base/tests')).filter(x=>x.endsWith('.php')).sort()){
  const output=run(php,[...flags,'work/production-base/tests/'+name]);let result;
  try{result=JSON.parse(output);}catch{throw Error('Saída de teste inválida em '+name);}
  const count=typeof result.passed==='number'?result.passed:typeof result.count==='number'?result.count:typeof result.checks==='number'?result.checks:Array.isArray(result.checks)?result.checks.length:0;
  total+=count;process.stdout.write(`${name}: OK (${count} verificações)\n`);
}
const python=process.env.CRIASOM_PYTHON||(process.platform==='win32'?'python':'python3');
run(python,['work/production-base/tests/schema_test.py']);
run(process.execPath,['work/criasom-app-piloto/bundle.cjs','--check']);
process.stdout.write(`PHP total: ${total}; esquema SQLite e empacotador: OK.\n`);
