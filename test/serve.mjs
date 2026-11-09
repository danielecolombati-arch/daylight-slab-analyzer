import http from 'http'; import fs from 'fs'; import path from 'path';
const root = path.resolve(process.argv[2]||'.'); const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.3dm':'application/octet-stream','.css':'text/css'};
http.createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]); if(p.endsWith('/'))p+='index.html'; const f=path.join(root,p);
 fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end();return;} s.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'}); s.end(d);});}).listen(8123);
