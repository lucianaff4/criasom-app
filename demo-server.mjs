// Somente a interface fictícia, sem login nem compartilhamento entre contas.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,realpath} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../work/criasom-app-piloto/dist');
const port=Number(process.env.CRIASOM_DEMO_PORT||8080);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Porta inválida');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)||req.headers.host!==`127.0.0.1:${port}`)throw Error();
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname.includes('..')||pathname.includes('\\')||pathname.includes('\0'))throw Error();
    const file=await realpath(path.join(root,pathname.endsWith('/')?pathname+'index.html':pathname));
    if(!file.startsWith(root+path.sep))throw Error();
    const mime=types[path.extname(file)];if(!mime)throw Error();
    const b=await readFile(file);res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:b);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Não encontrado');}
}).listen(port,'127.0.0.1',()=>process.stdout.write(`Interface fictícia: http://127.0.0.1:${port}/\nUse npm run dev para login e fórum com duas contas.\n`));
