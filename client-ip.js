import { isIP } from 'node:net';
function normalize(value) {
  if(typeof value!=='string'||value.includes('%')||!isIP(value))return null;
  if(isIP(value)===4)return value;
  const canonical=new URL(`http://[${value}]/`).hostname.slice(1,-1);
  const mapped=/^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if(mapped){const a=parseInt(mapped[1],16),b=parseInt(mapped[2],16);return `${a>>8}.${a&255}.${b>>8}.${b&255}`;}
  return canonical;
}
export function clientIP(req,mode='direct') {
  if(mode==='direct')return normalize(req.socket.remoteAddress)??'unknown-peer';
  if(mode!=='railway-public')throw Error('Invalid client IP mode');
  // Only safe behind Railway's public HTTP edge, never as proof of edge provenance.
  const copies=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='x-real-ip').length;
  const value=copies===1?normalize(req.get('x-real-ip')):null;
  if(!value)throw Object.assign(new Error('invalid_client_ip'),{status:400});
  return value;
}
