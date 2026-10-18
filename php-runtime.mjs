import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

export function phpRuntime() {
  const php=process.env.CRIASOM_PHP||'php';
  const flags=['-d','display_errors=0','-d','log_errors=0'];
  const probe=spawnSync(php,['-r','echo json_encode([PHP_VERSION_ID,get_loaded_extensions()]);'],{windowsHide:true,encoding:'utf8'});
  if(probe.status!==0)throw Error('PHP não encontrado. Instale PHP 8.3+ ou defina CRIASOM_PHP com o caminho do executável.');
  let version,loaded;
  try{[version,loaded]=JSON.parse(probe.stdout);}catch{throw Error('Não foi possível conferir PHP e extensões. Revise a configuração local.');}
  if(version<80300)throw Error('Use PHP 8.3 ou superior.');
  const required=['openssl','pdo_sqlite','gd'];
  const missing=required.filter(x=>!loaded.map(y=>y.toLowerCase()).includes(x));
  if(missing.length&&process.platform==='win32'){
    const ext=process.env.CRIASOM_PHP_EXT_DIR||(path.isAbsolute(php)?path.join(path.dirname(php),'ext'):null);
    if(ext&&missing.every(x=>existsSync(path.join(ext,`php_${x}.dll`)))){
      flags.push('-d',`extension_dir=${ext}`);
      for(const name of missing)flags.push('-d',`extension=${name}`);
    }
  }
  const check=spawnSync(php,[...flags,'-r',"exit(extension_loaded('pdo_sqlite') && extension_loaded('openssl') && extension_loaded('gd') ? 0 : 1);"],{windowsHide:true,encoding:'utf8'});
  if(check.status!==0)throw Error('Ative PDO SQLite, OpenSSL e GD no PHP local. No Windows portátil, use CRIASOM_PHP absoluto e a pasta ext correspondente.');
  return {php,flags};
}
