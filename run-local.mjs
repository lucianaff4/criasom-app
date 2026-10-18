// Node is only a TLS loopback proxy/process supervisor. PHP + PDO handle every application/API operation.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {phpRuntime} from '../../../scripts/php-runtime.mjs';

const dev = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(dev, '../..');
const privateDir = path.resolve(work, '../.local');
const {php, flags} = phpRuntime();
const python = process.env.CRIASOM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const httpsPort = Number(process.env.CRIASOM_LAB_HTTPS_PORT || 8543);
const phpPort = Number(process.env.CRIASOM_LAB_PHP_PORT || 8865);
if (![httpsPort, phpPort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || httpsPort === phpPort) throw new Error('Invalid local ports');
await mkdir(privateDir, {recursive: true});
const configPath = path.join(privateDir, 'config.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = {mode:'criasom-synthetic-loopback', origin:`https://127.0.0.1:${httpsPort}`, httpsPort, phpPort,
    applicationKeyBase64:randomBytes(32).toString('base64'), proxySecret:randomBytes(32).toString('hex'), syntheticHotmartToken:randomBytes(32).toString('hex')};
  await writeFile(configPath, JSON.stringify(config, null, 2), {flag:'wx', mode:0o600});
}
if (config.origin !== `https://127.0.0.1:${httpsPort}` || config.httpsPort !== httpsPort || config.phpPort !== phpPort) throw new Error('Existing laboratory uses different ports; inspect instead of replacing its state');
const env = {...process.env, CRIASOM_LAB_CONFIG:configPath};
// Never inherit an optional PHP_CLI_SERVER_WORKERS setting into this local deterministic laboratory.
delete env.PHP_CLI_SERVER_WORKERS;
const certResult = spawnSync(python, [path.join(dev,'make-local-certificate.py'),privateDir], {env, windowsHide:true, encoding:'utf8'});
if (certResult.status !== 0) throw new Error('Local certificate preparation failed');
const init = spawnSync(php, [...flags,path.join(dev,'initialize.php')], {env, windowsHide:true, encoding:'utf8'});
if (init.status !== 0) throw new Error('Local PHP initialization failed (inspect through CLI; no private diagnostics exposed)');

async function assertFree(port) {
  const probe = net.createServer();
  await new Promise((resolve,reject) => {probe.once('error',reject); probe.listen(port,'127.0.0.1',resolve);});
  await new Promise(resolve=>probe.close(resolve));
}
await assertFree(httpsPort); await assertFree(phpPort);
const child = spawn(php,[...flags,'-S',`127.0.0.1:${phpPort}`,'-t',path.join(dev,'docroot'),path.join(dev,'router.php')],{env,windowsHide:true,stdio:['ignore','ignore','ignore']});
let stopping = false;
let childExited = false;
child.once('exit',()=>{childExited=true;if(!stopping){process.stderr.write('Local PHP process stopped.\n');process.exitCode=1;proxy?.close();}});
let proxy;
try {
  for(let n=0;n<50;n++){
    if(childExited)throw new Error('PHP listener did not start');
    const ready=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:phpPort});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});
    if(ready)break;if(n===49)throw new Error('PHP listener timed out');await new Promise(resolve=>setTimeout(resolve,100));
  }
  const cert=await readFile(path.join(privateDir,'tls-cert.pem'));
  const key=await readFile(path.join(privateDir,'tls-key.pem'));
  const fail=(res,status,error)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error}));};
  proxy=https.createServer({cert,key,minVersion:'TLSv1.2',maxHeaderSize:16384},async(req,res)=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${httpsPort}`||req.headers['x-criasom-lab-transport']!==undefined){fail(res,403,'laboratory_transport_required');return;}
    if(!['GET','HEAD','POST'].includes(req.method)||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>512){fail(res,400,'invalid_request');return;}
    if(req.headers.origin&&req.headers.origin!==config.origin){fail(res,403,'origin_denied');return;}
    const chunks=[];let total=0;
    try{
      for await(const part of req){total+=part.length;if(total>131072){fail(res,413,'body_too_large');return;}chunks.push(part);}
      const headers={};
      for(const name of ['accept','accept-language','content-type','cookie','origin','sec-fetch-site','x-csrf-token','x-hotmart-hottok','range'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
      headers.host=`127.0.0.1:${httpsPort}`;headers['x-criasom-lab-transport']=config.proxySecret;headers['content-length']=String(total);
      const upstream=http.request({host:'127.0.0.1',port:phpPort,path:req.url,method:req.method,headers,timeout:15000},incoming=>{
        const responseHeaders={};
        for(const [name,value] of Object.entries(incoming.headers))if(!['connection','transfer-encoding','keep-alive','x-powered-by','server'].includes(name))responseHeaders[name]=value;
        res.writeHead(incoming.statusCode||503,responseHeaders);incoming.pipe(res);
      });
      upstream.once('timeout',()=>upstream.destroy());upstream.once('error',()=>{if(!res.headersSent)fail(res,503,'local_backend_unavailable');else res.destroy();});
      res.once('close',()=>upstream.destroy());upstream.end(Buffer.concat(chunks));
    }catch{if(!res.headersSent)fail(res,400,'invalid_request');}
  });
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(httpsPort,'127.0.0.1',resolve);});
  const certificate=new X509Certificate(cert);
  const spki=createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64');
  const receipt={mode:'synthetic-only',origin:config.origin,url:config.origin+'/app/',phpAddress:`127.0.0.1:${phpPort}`,tlsCertificate:path.join(privateDir,'tls-cert.pem'),spkiSha256:spki,phpPid:child.pid,proxyPid:process.pid,startedAt:new Date().toISOString(),production:false};
  await writeFile(path.join(privateDir,'listener.json'),JSON.stringify(receipt,null,2));
  process.stdout.write(JSON.stringify(receipt)+'\n');
}catch(error){stopping=true;child.kill();proxy?.close();throw error;}
const stop=()=>{if(stopping)return;stopping=true;proxy?.close();proxy?.closeAllConnections();child.kill();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>{if(!childExited)child.kill();});
