export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';

function json(data, status=200){ return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }

function normalizeMessages(messages){
  return (Array.isArray(messages)?messages:[]).map(m=>{
    const role=m?.role==='assistant'?'model':'user';
    if(!Array.isArray(m?.content)) return {role,parts:[{text:String(m?.content??'')}]};
    const parts=m.content.map(p=>{
      if(p?.type==='text') return {text:String(p.text||'')};
      if(p?.type==='image' && p.source?.data) return {inlineData:{mimeType:p.source.media_type||'image/jpeg',data:p.source.data}};
      return null;
    }).filter(Boolean);
    return {role,parts:parts.length?parts:[{text:''}]};
  });
}

export default async function handler(req){
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey) return json({error:'GEMINI_API_KEY is missing. Add it in Vercel Environment Variables.'},500);
  let body; try{body=await req.json()}catch{return json({error:'Invalid JSON request body.'},400)}
  const messages=normalizeMessages(body.messages);
  if(!messages.length) return json({error:'At least one message is required.'},400);
  const systemText=String(body.system||'You are Indus AI, a helpful AI assistant.');
  const useSearch=body.webSearch===true;
  const requestBody={contents:messages,systemInstruction:{parts:[{text:systemText}]},generationConfig:{temperature:0.7}};
  if(useSearch) requestBody.tools=[{googleSearch:{}}];

  const url=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
  let res; try{res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(requestBody)})}catch(e){return json({error:'Could not reach Gemini API.',detail:String(e)},502)}
  if(!res.ok || !res.body){const detail=await res.text().catch(()=> '');return json({error:'Gemini request failed.',status:res.status,detail},res.status>=400&&res.status<600?res.status:502)}

  const reader=res.body.getReader(), decoder=new TextDecoder(), encoder=new TextEncoder();
  const lastUser=[...messages].reverse().find(m=>m.role==='user');
  const supabaseUrl=process.env.SUPABASE_URL, supabaseKey=process.env.SUPABASE_KEY;
  const stream=new ReadableStream({async start(controller){
    let buffer='',fullAnswer='',closed=false;
    const send=(obj)=>{if(!closed)controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))};
    try{
      while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';for(const line of lines){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(!raw)continue;try{const evt=JSON.parse(raw);const parts=evt?.candidates?.[0]?.content?.parts||[];for(const part of parts){if(part?.text){fullAnswer+=part.text;send({type:'content_block_delta',delta:{text:part.text}})}}const block=evt?.error;if(block)send({type:'error',error:block.message||'Gemini stream error'});}catch{}}}
      if(buffer.startsWith('data:')){try{const evt=JSON.parse(buffer.slice(5).trim());const parts=evt?.candidates?.[0]?.content?.parts||[];for(const p of parts)if(p?.text){fullAnswer+=p.text;send({type:'content_block_delta',delta:{text:p.text}})}}catch{}}
    }catch(e){send({type:'error',error:'The AI stream ended unexpectedly.'});}
    if(!fullAnswer) send({type:'error',error:'The AI returned no readable text.'});
    send({type:'done'});closed=true;try{controller.close()}catch{}
    if(supabaseUrl&&supabaseKey&&lastUser){try{const q=lastUser.parts?.filter(p=>p?.text).map(p=>p.text).join(' ')||'[image]';await fetch(`${supabaseUrl}/rest/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json','apikey':supabaseKey,'Authorization':`Bearer ${supabaseKey}`,'Prefer':'return=minimal'},body:JSON.stringify({user_question:q,ai_answer:fullAnswer})})}catch(e){console.error('Supabase logging failed',e)}}
  }});
  return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}});
}
