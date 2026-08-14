export const config = { runtime: 'edge' };
const JSON_HEADERS={'Content-Type':'application/json','Cache-Control':'no-store'};
const MODEL=process.env.GEMINI_IMAGE_MODEL||'gemini-2.5-flash-image';
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:JSON_HEADERS})}
export default async function handler(req){
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const key=process.env.GEMINI_API_KEY;if(!key)return json({error:'GEMINI_API_KEY is missing. Add it in Vercel Environment Variables.'},500);
 let body;try{body=await req.json()}catch{return json({error:'Invalid JSON request body.'},400)}
 const prompt=String(body.prompt||'').trim(),ref=body.referenceImage;
 if(!prompt&&!ref?.base64)return json({error:'Please describe the image you want to create.'},400);
 if(ref?.base64 && ref.base64.length>4_500_000)return json({error:'The uploaded image is too large after processing. Please choose a smaller image.'},413);
 const parts=[];if(ref?.base64)parts.push({inlineData:{mimeType:String(ref.mediaType||'image/jpeg'),data:ref.base64}});parts.push({text:prompt||'Create a new image inspired by the attached photo.'});
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
 let res;try{res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseModalities:['TEXT','IMAGE']}})})}catch(e){return json({error:'Could not reach the image generation service.',detail:String(e)},502)}
 const data=await res.json().catch(()=>({}));
 if(!res.ok)return json({error:'Image generation failed.',status:res.status,detail:data},res.status>=400&&res.status<600?res.status:502);
 const responseParts=data?.candidates?.[0]?.content?.parts||[];const imagePart=responseParts.find(p=>p?.inlineData?.data||p?.inline_data?.data);const textPart=responseParts.find(p=>p?.text);
 const inline=imagePart?.inlineData||imagePart?.inline_data;if(!inline?.data)return json({error:'The image model completed without returning an image.',detail:data},502);
 const mime=inline.mimeType||inline.mime_type||'image/png';return json({image:`data:${mime};base64,${inline.data}`,text:textPart?.text||''});
}
