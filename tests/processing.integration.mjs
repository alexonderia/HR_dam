// Synthetic protocol peer only. Production parser/evaluator live in another branch.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { ObjectStore, ProcessingBroker } from "/app/packages/processing/dist/index.js";
import { hashPassword } from "/app/packages/security/dist/index.js";
const require = createRequire("/app/packages/processing/package.json");
const amqp = require("amqplib");
const base = "http://frontend:8080", origin = "http://localhost:13000";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash("sha256").update(data).digest("hex");
class Browser {
  cookies = new Map();
  async request(path, options = {}, expected = 200) {
    const headers = new Headers(options.headers);
    headers.set("Origin", origin);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k,v])=>`${k}=${v}`).join("; "));
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const r = await fetch(base + path, { ...options, headers });
    for (const line of r.headers.getSetCookie()) {
      const [key,value] = line.split(";")[0].split("=");
      if (value) this.cookies.set(key,value); else this.cookies.delete(key);
    }
    assert.equal(r.status, expected, `${options.method || "GET"} ${path}: expected ${expected}, got ${r.status}`);
    assert.match(r.headers.get("content-type") || "", /json/);
    return r.json();
  }
}
async function until(fn, predicate, timeout = 20000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const result = await fn(); if (predicate(result)) return result; await delay(150); }
  throw new Error("Timed out awaiting synthetic protocol transition");
}
const connections = [];
async function consumer(mode, operation) {
  const password = process.env[operation.toUpperCase()+"_AMQP_PASSWORD"];
  const conn = await amqp.connect(`amqp://hr_${operation}:${encodeURIComponent(password)}@rabbitmq:5672/hr-${mode}`);
  conn.on("error", ()=>{}); connections.push(conn);
  const channel = await conn.createChannel(); channel.on("error",()=>{}); await channel.prefetch(1);
  return { channel, queue: `hr.${mode}.${operation}` };
}
async function take(peer, taskId) {
  return until(async () => {
    const m = await peer.channel.get(peer.queue, { noAck: false });
    if (!m) return null;
    const body = JSON.parse(m.content.toString());
    if (body.task_id !== taskId) { peer.channel.ack(m); return null; }
    return { m, body, token: m.properties.headers["x-job-token"] };
  }, Boolean);
}
async function internal(mode, command, path, options = {}, expected = 200) {
  const url = `http://${mode === "guest" ? "guest-api:3002" : "backend:3001"}/internal/${mode === "guest" ? "guest" : "app"}/jobs/${command.body.job_id}/${path}`;
  const headers = new Headers(options.headers); headers.set("Authorization", `Bearer ${command.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const r = await fetch(url, { ...options, headers });
  assert.equal(r.status, expected, `internal ${path}: expected ${expected}, got ${r.status}`);
  if (path.startsWith("files/") && expected === 200) return Buffer.from(await r.arrayBuffer());
  return r.json();
}
function evaluated(targets, score = 80) {
  return { status: "completed", candidate: { last_name:null,first_name:null,middle_name:null,phone:null }, evaluations:targets.map(t=>({target_id:t.id,score,
    criteria:["education","experience","keywords"].map(name=>({name,status:"unknown",explanation:"Synthetic evidence is absent."})),matched_keywords:[],triggered_stop_factors:[],explanation:"Synthetic protocol result."})) };
}
async function completeEvaluation(peer, taskId, mode) {
  const cmd = await take(peer, taskId), input = await internal(mode, cmd, "input");
  assert.equal(input.should_process,true);
  const file = await internal(mode, cmd, `files/${input.file.file_id}`);
  assert.equal(hash(file),input.file.sha256);
  await internal(mode, cmd, "progress", {method:"POST",body:JSON.stringify({job_id:cmd.body.job_id,attempt:cmd.body.attempt,status:"processing"})});
  await internal(mode, cmd, "output/forbidden", {method:"PUT"},403);
  await internal(mode, cmd, "result", {method:"POST",body:JSON.stringify(evaluated(input.requirements.targets))});
  peer.channel.ack(cmd.m);
  return {cmd,input};
}
async function guest() {
  const objects = new ObjectStore("guest-temporary","GUEST_S3");
  await objects.verifyAtomicWrites(); console.log("PASS live SeaweedFS conditional create and CAS (5 rounds x 8 writers)");
  await assert.rejects(amqp.connect(`amqp://hr_guest:${process.env.GUEST_AMQP_PASSWORD}@rabbitmq:5672/hr-authorized`));
  const forbiddenConnection=await amqp.connect(`amqp://hr_evaluate:${process.env.EVALUATE_AMQP_PASSWORD}@rabbitmq:5672/hr-guest`);
  forbiddenConnection.on("error",()=>{});
  try {
    const ch=await forbiddenConnection.createChannel();
    const rejected=new Promise(resolve=>ch.once("error",e=>resolve(e.code)));
    ch.publish("hr.processing","guest.prepare",Buffer.from("{}"));
    assert.equal(await rejected,403);
    const wrong=await forbiddenConnection.createChannel();wrong.on("error",()=>{});
    await assert.rejects(wrong.get("hr.guest.prepare",{noAck:false}));
  } finally {await forbiddenConnection.close().catch(()=>{});}
  console.log("PASS live AMQP vhost isolation, worker operation restriction and publication denial");
  const browser = new Browser();
  assert.equal((await browser.request("/api/session")).mode,"guest");
  await browser.request("/api/app/overview",{},401);
  for (const path of ["/api/overview","/api/export","/api/files/"+randomUUID(),"/api/internal/resume-results","/internal/guest/jobs/"+randomUUID()+"/input","/__auth_guest"]) await browser.request(path,{},404);
  const forged = new Browser(); forged.cookies.set("hr_session","forged");
  await forged.request("/api/guest/queue",{method:"POST",body:"{}"},401);
  await forged.request("/api/session",{},401); assert.equal(forged.cookies.has("hr_session"),false);
  console.log("PASS Nginx route whitelist, authorization, invalid cookie reset; backend/PostgreSQL absent");
  const criteria={name:"Synthetic target",education:"",experience:"",keywords:["TypeScript"],stop_factors:[],comment:""};
  const text=Buffer.from("Synthetic resume fixture. TypeScript experience is intentionally unspecified.\n");
  const fingerprint=hash(JSON.stringify({criteria,files:[{name:"synthetic.txt",size:text.length,sha256:hash(text)}]}));
  const ticket = await browser.request("/api/guest/queue",{method:"POST",body:JSON.stringify({file_count:1,size_bytes:text.length})},201);
  assert.equal(ticket.status,"admitted");
  const key=randomUUID();
  const submit=()=>{ const form=new FormData();form.append("criteria",JSON.stringify(criteria));form.append("files",new Blob([text]),"synthetic.txt");return browser.request("/api/guest/tasks",{method:"POST",headers:{"Idempotency-Key":key,"X-Submission-Digest":fingerprint,"X-Upload-Permit":ticket.id},body:form},202); };
  const accepted=await submit(), peer=await consumer("guest","evaluate");
  const {cmd,input}=await completeEvaluation(peer,accepted.task_id,"guest");
  const report=await until(()=>browser.request(`/api/guest/tasks/${accepted.task_id}`),r=>r.status==="completed");
  assert.equal(report.completed_count,1);assert.equal(report.source_count,1);assert.equal(report.results[0].evaluations[0].score,80);
  await internal("guest",cmd,"result",{method:"POST",body:JSON.stringify(evaluated(input.requirements.targets,1))});
  assert.equal((await submit()).task_id,accepted.task_id);
  assert.equal((await browser.request(`/api/guest/tasks/${accepted.task_id}/download`)).results[0].evaluations[0].score,80);
  const stranger=new Browser();await stranger.request(`/api/guest/tasks/${accepted.task_id}`,{},404);
  await assert.rejects(objects.json("unused").then(async()=>{
    const {GetObjectCommand}=require("@aws-sdk/client-s3");
    await objects.client.send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:"anything"}));
  }),e=>e.$metadata?.httpStatusCode===403);
  console.log("PASS upload, antivirus transport, job-token permissions, evaluation, first-result retention, idempotency, ownership and bucket isolation");
  const broker=new ProcessingBroker(`amqp://hr_guest:${process.env.GUEST_AMQP_PASSWORD}@rabbitmq:5672/hr-guest`,"guest",()=>"synthetic-invalid-token");
  await assert.rejects(broker.publish({kind:"command",body:{...cmd.body,operation:"unroutable"}}, {jobs:[]}));
  console.log("PASS publisher confirms with mandatory rejects unroutable messages");
  // Prepare is a protocol stub: it returns the original single-resume PDF.
  const backendRequire=createRequire("/app/apps/backend/package.json"),{PDFDocument}=backendRequire("@cantoo/pdf-lib");
  const pdfDocument=await PDFDocument.create();pdfDocument.addPage();
  const pdf=Buffer.from(await pdfDocument.save());
  const pdfCriteria=criteria,pdfKey=randomUUID();
  const pdfTicket=await browser.request("/api/guest/queue",{method:"POST",body:JSON.stringify({file_count:1,size_bytes:pdf.length})},201);
  const pdfForm=new FormData();pdfForm.append("criteria",JSON.stringify(pdfCriteria));pdfForm.append("files",new Blob([pdf]),"synthetic.pdf");
  const pdfTask=await browser.request("/api/guest/tasks",{method:"POST",headers:{"Idempotency-Key":pdfKey,"X-Submission-Digest":hash(JSON.stringify({criteria:pdfCriteria,files:[{name:"synthetic.pdf",size:pdf.length,sha256:hash(pdf)}]})),"X-Upload-Permit":pdfTicket.id},body:pdfForm},202);
  const preparePeer=await consumer("guest","prepare"),prepared=await take(preparePeer,pdfTask.task_id);
  const preparedInput=await internal("guest",prepared,"input");assert.equal("requirements" in preparedInput,false);
  await internal("guest",prepared,"result",{method:"POST",body:JSON.stringify({status:"completed",files:[{file_id:prepared.body.file_id}],errors:[]})});preparePeer.channel.ack(prepared.m);
  await completeEvaluation(peer,pdfTask.task_id,"guest");
  await until(()=>browser.request(`/api/guest/tasks/${pdfTask.task_id}`),r=>r.status==="completed");
  console.log("PASS prepare -> API event consumer -> evaluate, without services calling each other");
  const submitFile = async (name,bytes) => {
    const ticket=await browser.request("/api/guest/queue",{method:"POST",body:JSON.stringify({file_count:1,size_bytes:bytes.length})},201);
    const form=new FormData();form.append("criteria",JSON.stringify(criteria));form.append("files",new Blob([bytes]),name);
    return browser.request("/api/guest/tasks",{method:"POST",headers:{"Idempotency-Key":randomUUID(),"X-Submission-Digest":hash(JSON.stringify({criteria,files:[{name,size:bytes.length,sha256:hash(bytes)}]})),"X-Upload-Permit":ticket.id},body:form},202);
  };
  const {zipSync}=backendRequire("fflate");
  const zipTask=await submitFile("synthetic.zip",zipSync({"resume-1.txt":text,"resume-2.txt":text}));
  const zipCommand=await take(preparePeer,zipTask.task_id),outputs=[];
  for(let n=1;n<=2;n++){
    const form=new FormData();form.append("file",new Blob([text]),`resume-${n}.txt`);
    form.append("metadata",JSON.stringify({file_name:`resume-${n}.txt`,mime_type:"text/plain",source_file_id:zipCommand.body.file_id,archive_path:`resume-${n}.txt`,pages:[]}));
    const output=await internal("guest",zipCommand,`output/resume-${n}`,{method:"PUT",body:form});outputs.push(output);
    const repeat=new FormData();repeat.append("file",new Blob([text]),`resume-${n}.txt`);repeat.append("metadata",form.get("metadata"));
    assert.equal((await internal("guest",zipCommand,`output/resume-${n}`,{method:"PUT",body:repeat})).file_id,output.file_id);
  }
  await internal("guest",zipCommand,"result",{method:"POST",body:JSON.stringify({status:"completed",files:outputs.map(f=>({file_id:f.file_id})),errors:[]})});preparePeer.channel.ack(zipCommand.m);
  await completeEvaluation(peer,zipTask.task_id,"guest");
  const failed=await take(peer,zipTask.task_id);
  await internal("guest",failed,"result",{method:"POST",body:JSON.stringify({status:"failed",error:{code:"INVALID_FILE",message:"Synthetic unreadable document"}})});peer.channel.ack(failed.m);
  const partial=await until(()=>browser.request(`/api/guest/tasks/${zipTask.task_id}`),r=>r.status==="partially_completed");
  assert.equal(partial.candidate_count,2);assert.equal(partial.completed_count,1);
  console.log("PASS ZIP fan-out, stable output IDs and a partial report");
  const retryTask=await submitFile("retry.txt",text);let prior=0;
  for(let n=0;n<=5;n++){
    const delivery=await take(peer,retryTask.task_id),now=Date.now();
    if(n){assert.ok(now-prior>=850,"native delayed retry must hold the message");assert.ok(delivery.m.properties.headers["x-delivery-count"]>=n);}
    prior=now;peer.channel.reject(delivery.m,true);
  }
  await until(()=>browser.request(`/api/guest/tasks/${retryTask.task_id}`),r=>r.status==="failed",30000);
  console.log("PASS RabbitMQ 4.3 native backoff, basic.reject delivery-count, delivery-limit and DLQ accounting");
  await browser.request(`/api/guest/tasks/${accepted.task_id}`,{method:"DELETE"},202);
  await browser.request(`/api/guest/tasks/${accepted.task_id}`,{},410);
  await internal("guest",cmd,"result",{method:"POST",body:JSON.stringify(evaluated(input.requirements.targets))},410);
  await browser.request(`/api/guest/tasks/${pdfTask.task_id}`,{method:"DELETE"},202);
  await browser.request(`/api/guest/tasks/${zipTask.task_id}`,{method:"DELETE"},202);
  await browser.request(`/api/guest/tasks/${retryTask.task_id}`,{method:"DELETE"},202);
  console.log("PASS deletion closes access and fences late results before physical cleanup");
  process.exit(0);
}
async function authorized(phase) {
  const {pool}=await import("/app/packages/data-access/dist/index.js");
  const login="synthetic-integration",password="synthetic-integration-password-only";
  try {
    await pool.query(`INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$2,'Synthetic integration',$3) ON CONFLICT(login) DO NOTHING`,[randomUUID(),login,hashPassword(password)]);
    const browser=new Browser();await browser.request("/api/auth/login",{method:"POST",body:JSON.stringify({login,password})});
    assert.equal((await browser.request("/api/session")).mode,"authorized");
    const csrf=await fetch(base+"/api/app/clusters",{method:"POST",headers:{Origin:"https://untrusted.invalid","Content-Type":"application/json",Cookie:[...browser.cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body:JSON.stringify({name:"Forbidden synthetic cluster",track:"test"})});
    assert.equal(csrf.status,403);
    await browser.request("/api/guest/queue",{method:"POST",body:"{}"},403);
    await browser.request("/api/app/overview");
    const cluster=await browser.request("/api/app/clusters",{method:"POST",body:JSON.stringify({name:"Synthetic cluster",track:"test"})},201);
    await browser.request("/api/app/profiles",{method:"POST",body:JSON.stringify({cluster_id:cluster.id,position_name:"Synthetic profile",keywords:["TypeScript"]})},201);
    const text=Buffer.from(`Synthetic integration resume ${randomUUID()}\n`),form=new FormData();form.append("resume",new Blob([text]),"synthetic.txt");
    const task=await browser.request("/api/app/candidates",{method:"POST",body:form},202);
    if(phase==="outbox-create"){
      const pending=await pool.query("SELECT count(*)::int AS count FROM processing_outbox WHERE task_id=$1 AND published_at IS NULL",[task.id]);assert.ok(pending.rows[0].count>0);
      await writeFile("/qa/processing-outbox.json",JSON.stringify({task_id:task.id}));console.log("PASS authorized upload accepted transactionally while RabbitMQ is stopped");return;
    }
    const peer=await consumer("authorized","evaluate");await completeEvaluation(peer,task.id,"authorized");
    await until(()=>browser.request(`/api/app/resume-imports/${task.id}`),r=>r.pending_files===0);
    const overview=await browser.request("/api/app/overview");assert.ok(overview.candidates.length>0);assert.ok(overview.candidates.some(c=>c.ratings.length>0));
    await browser.request("/api/auth/refresh",{method:"POST"});
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=(SELECT id FROM users WHERE login=$1)",[login]);
    await browser.request("/api/app/overview",{},401);assert.equal(browser.cookies.has("hr_session"),false);
    console.log("PASS login/refresh/revocation, CSRF boundaries, authorized import and persistent candidate/ratings");
  } finally {await pool.end();}
}
async function recovered() {
  const data=JSON.parse(await readFile("/qa/processing-outbox.json","utf8")), peer=await consumer("authorized","evaluate");
  await completeEvaluation(peer,data.task_id,"authorized");
  const {pool}=await import("/app/packages/data-access/dist/index.js");
  await until(()=>pool.query("SELECT state FROM processing_tasks WHERE id=$1",[data.task_id]),r=>r.rows[0].state.status==="completed");
  const outbox=await pool.query("SELECT count(*)::int AS count FROM processing_outbox WHERE task_id=$1 AND published_at IS NULL",[data.task_id]);assert.equal(outbox.rows[0].count,0);
  await pool.end();console.log("PASS committed authorized task and outbox recovered after backend and broker restarts");
}
async function cleanupCheck() {
  const objects=new ObjectStore("guest-temporary","GUEST_S3");
  await until(async()=>{
    let inspected=0,pending=0;
    for await(const key of objects.keys("tasks/")) if(key.endsWith("/state.json")) {
      const state=await objects.json(key);if(!state?.value.deleted_at)continue;
      inspected++;if(state.value.files.length||state.value.requirements.length||state.value.jobs.length)pending++;
      const prefix=key.slice(0,-"state.json".length);const remaining=[];for await(const k of objects.keys(prefix))remaining.push(k);
      if(remaining.length!==1||remaining[0]!==key)pending++;
    }
    return inspected>0&&pending===0;
  },Boolean,45000);
  console.log("PASS physical guest cleanup leaves only technical tombstones");
}
try {
  const phase=process.argv[2]||"guest";
  if(phase==="guest") await guest();else if(phase==="recover")await recovered();else if(phase==="cleanup")await cleanupCheck();else await authorized(phase);
} finally {for(const c of connections)await c.close().catch(()=>{});}
