import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||10000);
const origin=process.env.PUBLIC_ORIGIN||(process.env.RENDER_EXTERNAL_HOSTNAME?`https://${process.env.RENDER_EXTERNAL_HOSTNAME}`:`http://127.0.0.1:${port}`);
const password=process.env.APP_PASSWORD;
if(!password||password.length<12)throw Error('Set APP_PASSWORD to a secret of at least 12 characters before starting.');
const expected=createHash('sha256').update('video:'+password).digest();
function authorized(req){try{const value=req.headers.authorization||'';if(!value.startsWith('Basic '))return false;return timingSafeEqual(expected,createHash('sha256').update(Buffer.from(value.slice(6),'base64')).digest());}catch{return false;}}
const token=randomBytes(24).toString('hex'), media=new Map();let active=0;
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
function extract(url){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.YTDLP_PATH||'yt-dlp',['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--socket-timeout','20','--retries','1','-f','best[protocol=https][ext=mp4]/best[protocol=http][ext=mp4]','--',url],{windowsHide:true});
 let out='',err='',done=false;const timer=setTimeout(()=>{child.kill();finish(Error('The video platform took too long to respond. Try again.'));},65000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);}
 child.stdout.on('data',b=>{out+=b;if(out.length>8e6){child.kill();finish(Error('The post response was too large.'));}});child.stderr.on('data',b=>{err=(err+b).slice(-6000);});child.on('error',()=>finish(Error('Video extractor missing. Run Start VideoDrop.cmd to set it up.')));child.on('close',code=>{if(code!==0)return finish(Error(/private|login|protected|not available|unavailable|404/i.test(err)?'This post is unavailable or requires a login. Try a public video post.':'Could not read this post. It may contain no video, or the platform may be temporarily blocking requests.'));try{finish(null,JSON.parse(out));}catch{finish(Error('The video service returned an invalid response.'));}});
});}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,origin);
  if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,app:'VideoDrop-X'});
  if(![new URL(origin).host,`127.0.0.1:${port}`].includes(req.headers.host)){res.writeHead(403).end();return;}
  if(!authorized(req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="VideoDrop", charset="UTF-8"','Cache-Control':'no-store'});res.end('Sign in with username video and your private password.');return;}
  if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);let body=fs.readFileSync(path.join(root,'public',file),'utf8');if(file==='index.html')body=body.replace('</head>',`<meta name="api-token" content="${token}"></head>`);
   res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(body);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/extract'){
   if(req.headers['x-api-token']!==token|| (req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'Reload this page and try again.'});
   let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(res,413,{error:'The link is too long.'});}
   let input;try{let value=String(JSON.parse(body).url||'').trim();value=value.match(/https?:\/\/[^\s<>]+/i)?.[0]||value;if(!/^https?:\/\//i.test(value))value='https://'+value;input=new URL(value);}catch{return json(res,400,{error:'Paste an X post or Instagram Reel/post link.'});}
   const post=input.pathname.match(/^\/(?:[A-Za-z0-9_]+\/status|i\/(?:web\/)?status)\/(\d+)(?:\/(?:video|photo)\/\d+)?\/?$/i);
   const instagram=['instagram.com','www.instagram.com','m.instagram.com'].includes(input.hostname)&&input.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/);
   if(!['https:','http:'].includes(input.protocol)||input.username||input.password||input.port||(!instagram&&(!['x.com','www.x.com','mobile.x.com','m.x.com','twitter.com','www.twitter.com','mobile.twitter.com','m.twitter.com'].includes(input.hostname)||!post)))return json(res,400,{error:'Use a public X post or Instagram Reel/post link. Open the post, tap Share, then Copy link.'});
   if(active>=2)return json(res,429,{error:'Another video is loading. Please try again shortly.'});
   active++;let info;try{info=await extract(instagram?'https://www.instagram.com/'+(instagram[1]==='reels'?'reel':instagram[1])+'/'+instagram[2]+'/':'https://x.com/i/status/'+post[1]);if(info.entries)info=info.entries.find(e=>e&&(e.formats||e.url))||info;}finally{active--;}
   for(const [key,value] of media)if(value.expires<Date.now())media.delete(key);
   const formats=(info.formats||[]).filter(f=>{try{const host=new URL(f.url).hostname;return f.ext==='mp4'&&f.protocol==='https'&&f.vcodec!=='none'&&f.acodec!=='none'&&(host==='video.twimg.com'||(instagram&&(host.endsWith('.cdninstagram.com')||host.endsWith('.fbcdn.net'))));}catch{return false;}}).sort((a,b)=>(b.height||0)-(a.height||0)||(b.tbr||0)-(a.tbr||0));
   const seen=new Set(),choices=[];
   for(const f of formats){if(seen.has(f.height))continue;seen.add(f.height);const key=randomBytes(20).toString('hex');media.set(key,{url:f.url,headers:{'User-Agent':info.http_headers?.['User-Agent']||'Mozilla/5.0',...(instagram?{Referer:'https://www.instagram.com/'}:{})},expires:Date.now()+3600000,name:`${instagram?'instagram':'x'}-${String(info.id).replace(/[^a-zA-Z0-9_-]/g,'')}-${f.height||'original'}.mp4`});choices.push({height:f.height,width:f.width,size:f.filesize||f.filesize_approx||null,preview:`/media/${key}`,download:`/media/${key}?download=1`});}
   if(!choices.length)return json(res,422,{error:'This post has no downloadable MP4 video.'});
   return json(res,200,{title:info.title||'Video',duration:info.duration,choices});
  }
  if(req.method==='GET'&&url.pathname.startsWith('/media/')){
   const item=media.get(url.pathname.slice(7));if(!item||item.expires<Date.now())return json(res,410,{error:'Link expired. Find the video again.'});
   const abort=new AbortController();res.on('close',()=>abort.abort());const headers={...item.headers};if(req.headers.range)headers.Range=req.headers.range;
   const response=await fetch(item.url,{headers,signal:abort.signal,redirect:'error'});if(!response.ok&&response.status!==206)return json(res,502,{error:'The platform could not deliver the video. Find it again and retry.'});
   const output={'Content-Type':'video/mp4','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};for(const h of ['content-length','content-range','accept-ranges'])if(response.headers.has(h))output[h]=response.headers.get(h);if(url.searchParams.has('download'))output['Content-Disposition']=`attachment; filename="${item.name}"`;
   res.writeHead(response.status,output);await pipeline(Readable.fromWeb(response.body),res);return;
  }
  json(res,404,{error:'Not found'});
 }catch(error){if(!res.headersSent&&!res.destroyed)json(res,500,{error:error.message||'Something went wrong. Please retry.'});else res.destroy();}
});
server.listen(port,'0.0.0.0',()=>console.log(`VideoDrop is ready at ${origin}`));

