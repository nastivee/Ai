import express from 'express';
import cors from 'cors';
import fs from 'fs';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({limit:'1mb'}));
app.use(express.static('public'));

const DATA='data/memory.json';
const load=()=>{try{return JSON.parse(fs.readFileSync(DATA,'utf8'))}catch{return {lessons:[],messages:[]}}};
const save=x=>fs.writeFileSync(DATA,JSON.stringify(x,null,2));
const db=load();
const client=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
const SYSTEM=`You are AI Lab, a capable personal AI assistant. Be direct, useful, thoughtful and transparent. Use saved lessons to improve future answers. You may adapt response style and reasoning strategies, but do not modify security boundaries, steal credentials, bypass access controls, or take external actions without explicit authorization. Never claim an action happened unless it actually did.`;

app.get('/api/status',(req,res)=>res.json({configured:!!client,model:process.env.OPENAI_MODEL||'gpt-5.6-luna',lessons:db.lessons.length}));
app.post('/api/chat',async(req,res)=>{
 try{
  if(!client)return res.status(503).json({error:'AI is not configured. Add OPENAI_API_KEY to the server environment.'});
  const message=String(req.body.message||'').trim(); if(!message)return res.status(400).json({error:'Message required'});
  const recent=db.messages.slice(-20).map(x=>`${x.role}: ${x.content}`).join('\n');
  const lessons=db.lessons.slice(-20).map(x=>`Lesson: ${x.lesson}`).join('\n');
  const r=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:`${SYSTEM}\n\n${lessons}`,input:`Recent conversation:\n${recent}\n\nUser: ${message}`});
  const answer=r.output_text||'No response.'; db.messages.push({role:'user',content:message},{role:'assistant',content:answer}); if(db.messages.length>100)db.messages.splice(0,db.messages.length-100); save(db); res.json({answer});
 }catch(e){console.error(e);res.status(500).json({error:'AI request failed.'})}
});
app.post('/api/improve',async(req,res)=>{
 try{
  if(!client)return res.status(503).json({error:'AI is not configured.'});
  const recent=db.messages.slice(-6).map(x=>`${x.role}: ${x.content}`).join('\n');
  const r=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:'Review the interaction and produce one concise reusable lesson for improving future responses. Return only the lesson.',input:recent});
  const lesson=r.output_text.trim(); db.lessons.push({lesson,created:new Date().toISOString()}); if(db.lessons.length>100)db.lessons.splice(0,db.lessons.length-100); save(db); res.json({lesson});
 }catch(e){console.error(e);res.status(500).json({error:'Improvement failed.'})}
});
app.post('/api/reset',(_,res)=>{db.messages=[];save(db);res.json({ok:true})});
app.listen(process.env.PORT||3000,()=>console.log('AI Lab running on port '+(process.env.PORT||3000)));
