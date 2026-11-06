/* Khutbah Clips Studio — Cloudflare Worker, Release 1
   No external runtime dependencies. D1/R2 bindings use the names already
   created by Wrangler in the user's existing wrangler.jsonc. */
interface Bindings {
  khutbah_clips_db: D1Database;
  khutbah_source_videos: R2Bucket;
  khutbah_reels_output: R2Bucket;
  ADMIN_TOKEN?: string;
  OPENAI_API_KEY?: string;
  HIGHLIGHT_MODEL?: string;
}
interface Segment { start_ms: number; end_ms: number; text: string; }
interface Candidate extends Segment { key: string; score: number; title: string; rationale: string; }
const MAX_JSON_BYTES = 2_100_000;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB; R2 multipart
const corslessJSON = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const failure = (error: string, status = 400) => corslessJSON({ error }, status);
const wait = (n: number) => Number.isFinite(n) && n >= 0 && n <= 86_400_000;
const clean = (value: unknown, max = 300): string => String(value ?? '').trim().slice(0, max);
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const encoder = new TextEncoder();
async function hmacKey(secret: string): Promise<CryptoKey> { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signSession(secret: string): Promise<string> {
  const expires = String(Date.now() + 12 * 60 * 60 * 1000);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(expires)));
  return `${expires}.${b64url(sig)}`;
}
async function sessionValid(request: Request, env: Bindings): Promise<boolean> {
  const hostname = new URL(request.url).hostname;
  // Unconfigured development mode works ONLY at loopback. Production always fails closed.
  if (!env.ADMIN_TOKEN) return hostname === 'localhost' || hostname === '127.0.0.1';
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)ks_session=([^;]+)/)?.[1];
  if (!cookie) return false;
  const [expiry, signature] = cookie.split('.');
  if (!expiry || !signature || !/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false;
  try { return crypto.subtle.verify('HMAC', await hmacKey(env.ADMIN_TOKEN), decode64(signature), encoder.encode(expiry)); }
  catch { return false; }
}
async function bodyJSON(request: Request): Promise<any> {
  const advertised = Number(request.headers.get('content-length') || 0);
  if (advertised > MAX_JSON_BYTES) throw new Error('JSON request is too large');
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_JSON_BYTES) throw new Error('JSON request is too large');
  return JSON.parse(raw);
}
async function findLecture(env: Bindings, id: string): Promise<any> {
  return env.khutbah_clips_db.prepare('SELECT * FROM lectures WHERE id = ?').bind(id).first();
}
function parseTimecode(input: string): number {
  const pieces = input.trim().replace(',', '.').split(':');
  if (pieces.length < 2 || pieces.length > 3 || pieces.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
  const sec = Number(pieces.pop()); const min = Number(pieces.pop()); const hr = pieces.length ? Number(pieces.pop()) : 0;
  return Math.round((hr * 3600 + min * 60 + sec) * 1000);
}
function parseTranscript(raw: string): Segment[] {
  const transcript = raw.replace(/\r/g, '').trim();
  if (!transcript || transcript.length > 1_500_000) throw new Error('Transcript is empty or too long');
  const segments: Segment[] = [];
  // SRT / WebVTT blocks with timestamp ranges and text.
  const blocks = transcript.replace(/^WEBVTT[^\n]*\n/, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const pos = lines.findIndex(l => l.includes('-->'));
    if (pos < 0) continue;
    const match = lines[pos].match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?)/);
    if (!match) continue;
    const start_ms = parseTimecode(match[1]); const end_ms = parseTimecode(match[2]);
    const text = lines.slice(pos + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (text && wait(start_ms) && end_ms > start_ms) segments.push({ start_ms, end_ms, text: text.slice(0, 1500) });
  }
  if (!segments.length) {
    // Plain line format: 00:04:12 - 00:04:18 | Say something useful here
    for (const line of transcript.split('\n')) {
      const match = line.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*[-–]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*[|:]?\s*(.+)$/);
      if (!match) continue;
      const start_ms = parseTimecode(match[1]); const end_ms = parseTimecode(match[2]);
      if (wait(start_ms) && end_ms > start_ms) segments.push({ start_ms, end_ms, text: match[3].trim().slice(0, 1500) });
    }
  }
  segments.sort((a,b) => a.start_ms - b.start_ms);
  if (!segments.length) throw new Error('No timed subtitles found. Import a .srt or .vtt file, or lines in 00:00:01 - 00:00:05 | spoken text format.');
  if (segments.length > 6000) throw new Error('Please import 6000 or fewer subtitle segments');
  return segments;
}
function heuristicHighlights(segments: Segment[]): Candidate[] {
  const patterns = /\b(allah|quran|qur.an|prophet|muhammad|salah|prayer|remember|never|important|imagine|repent|tawbah|forgive|forgiveness|merciful|akhira|hereafter|paradise|jannah|parents|mother|father|sabr|patience|brothers|sisters|faith|heart)\b/gi;
  const questions = /\b(why|how|what if|have you|do you|ask yourself|let me tell)\b/gi;
  const candidates: Candidate[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < Math.min(i + 85, segments.length); j++) {
      const duration = segments[j].end_ms - segments[i].start_ms;
      if (duration > 62000) break;
      if (duration < 44000) continue;
      if (segments[j].start_ms - segments[j - 1].end_ms > 6500) break;
      const sample = segments.slice(i, j + 1).map(x => x.text).join(' ');
      const punctuation = /[.!?؛؟]["'”’]?\s*$/.test(segments[j].text);
      const startsClean = /^[A-Zأ-ي]|^(?:and |but |so )/i.test(segments[i].text);
      const kwCount = (sample.match(patterns) || []).length;
      const hooks = (sample.slice(0, 200).match(questions) || []).length;
      const topical = Math.min(18, kwCount * 2.5);
      const hookScore = Math.min(18, hooks * 9);
      const durationPenalty = Math.abs(duration - 54000) / 1700;
      const score = Math.round(Math.max(25, Math.min(96, 58 + topical + hookScore + (punctuation ? 10 : -8) + (startsClean ? 3 : 0) - durationPenalty)));
      const intro = segments[i].text.replace(/^[^\p{L}\p{N}]+/u, '');
      const title = intro.length > 63 ? `${intro.slice(0, 60).trimEnd()}…` : intro;
      candidates.push({ key: `${i}:${j}`, start_ms: segments[i].start_ms, end_ms: segments[j].end_ms, text: sample, score, title: title || 'A reminder from the lecture', rationale: punctuation ? 'Potential self-contained reminder. Needs human context review.' : 'Potential strong moment. Check sentence boundaries carefully.' });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (selected.some(s => Math.max(0, Math.min(s.end_ms, candidate.end_ms) - Math.max(s.start_ms, candidate.start_ms)) > 9000)) continue;
    selected.push(candidate);
    if (selected.length >= 7) break;
  }
  return selected;
}
async function aiRank(candidates: Candidate[], env: Bindings): Promise<{ picks: Candidate[], mode: string, warning?: string }> {
  if (!env.OPENAI_API_KEY || !candidates.length) return { picks: candidates, mode: 'rules' };
  try {
    const model = env.HIGHLIGHT_MODEL || 'gpt-4.1-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You select respectful, self-contained 45–60 second Islamic sermon excerpts. NEVER change timestamps, invent quotations, assert theological accuracy, or join separate excerpts. Rank the supplied candidates only. All clips require human Islamic context approval. Return a JSON object with picks:[{key,title,reason}], up to 7, preserving exact candidate key. Titles must faithfully describe the provided words.' },
          { role: 'user', content: JSON.stringify(candidates.map(c => ({ key:c.key, text:c.text.slice(0, 1200), start_ms:c.start_ms, end_ms:c.end_ms, score:c.score }))) }
        ] })
    });
    if (!response.ok) throw new Error(`AI service returned ${response.status}`);
    const data: any = await response.json();
    const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!Array.isArray(result.picks)) throw new Error('Unrecognised AI response');
    const unique = new Set<string>();
    const picks: Candidate[] = [];
    for (const p of result.picks) {
      const original = candidates.find(c => c.key === p.key);
      if (!original || unique.has(original.key)) continue;
      unique.add(original.key);
      picks.push({ ...original, title: clean(p.title, 90) || original.title, rationale: clean(p.reason, 300) || original.rationale });
      if (picks.length >= 7) break;
    }
    return { picks: picks.length ? picks : candidates, mode: 'ai' };
  } catch (error) {
    return { picks: candidates, mode: 'rules', warning: `AI ranking unavailable. Used rules-based suggestions. ${String(error instanceof Error ? error.message : error)}` };
  }
}
async function getLectureBundle(env: Bindings, id: string) {
  const lecture = await findLecture(env, id);
  if (!lecture) return null;
  const [segmentList, clipList] = await Promise.all([
    env.khutbah_clips_db.prepare('SELECT start_ms,end_ms,text FROM transcript_segments WHERE lecture_id = ? ORDER BY start_ms').bind(id).all(),
    env.khutbah_clips_db.prepare('SELECT c.*,r.status AS render_status,r.progress_pct AS render_progress FROM clips c LEFT JOIN reel_render_jobs r ON r.clip_id=c.id WHERE c.lecture_id = ? ORDER BY c.start_ms').bind(id).all()
  ]);
  const automation = await env.khutbah_clips_db.prepare('SELECT status,stage,attempts,segment_count,highlight_count,progress_seconds,duration_seconds,error_message,updated_at FROM processing_jobs WHERE lecture_id=?').bind(id).first();
  return { lecture, transcript: segmentList.results, clips: clipList.results, automation };
}
async function serveVideo(request: Request, env: Bindings, lecture: any): Promise<Response> {
  if (!lecture.r2_key || lecture.status === 'uploading') return failure('Source video has not finished uploading', 409);
  const bucket = env.khutbah_source_videos;
  const head = await bucket.head(lecture.r2_key);
  if (!head) return failure('Source object not found in R2', 404);
  const size = head.size;
  const rangeHeader = request.headers.get('range');
  let start = 0; let end = size - 1; let partial = false;
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) return new Response(null, {status:416, headers:{'Content-Range':`bytes */${size}`}});
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]),size-1) : size-1;
    if (start >= size || end < start) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
    partial = true;
  }
  const obj = await bucket.get(lecture.r2_key, { range: { offset: start, length: end - start + 1 } });
  if (!obj) return failure('Video unavailable',404);
  return new Response(obj.body, {status: partial ? 206 : 200, headers:{
    'Content-Type': lecture.source_mime || 'video/mp4', 'Content-Length': String(end - start + 1),
    'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store',
    ...(partial ? {'Content-Range':`bytes ${start}-${end}/${size}`} : {})
  }});
}
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return new Response('Not found', { status:404 });
    if (request.method === 'OPTIONS') return new Response(null,{status:405});
    const method = request.method;
    try {
      if (path === '/api/health' && method === 'GET') return corslessJSON({ status:'ok', release:'1.4', configured:Boolean(env.ADMIN_TOKEN), aiConfigured:Boolean(env.OPENAI_API_KEY) });
      if (path === '/api/session' && method === 'GET') return corslessJSON({ authenticated: await sessionValid(request,env), requiresToken:Boolean(env.ADMIN_TOKEN), needsConfiguration: !env.ADMIN_TOKEN && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', aiConfigured:Boolean(env.OPENAI_API_KEY) });
      if (path === '/api/login' && method === 'POST') {
        if (!env.ADMIN_TOKEN) return failure('Admin token not configured. Set ADMIN_TOKEN for deployment.', 503);
        const body = await bodyJSON(request);
        // Compare via HMAC, avoiding early exit on different-length tokens.
        const actual = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.ADMIN_TOKEN), encoder.encode(clean(body.token, 4096))));
        const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.ADMIN_TOKEN), encoder.encode(env.ADMIN_TOKEN)));
        let mismatch = 0; for (let i=0;i<actual.length;i++) mismatch |= actual[i]^expected[i];
        if (mismatch !== 0) return failure('Invalid admin token', 401);
        const session = await signSession(env.ADMIN_TOKEN);
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return corslessJSON({ ok:true }, 200, { 'Set-Cookie':`ks_session=${session}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=43200${secure}` });
      }
      if (path === '/api/logout' && method === 'POST') return corslessJSON({ok:true},200,{'Set-Cookie':'ks_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0'});
      if (!env.ADMIN_TOKEN && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return failure('Deployment not configured: ADMIN_TOKEN secret required', 503);
      if (!(await sessionValid(request, env))) return failure('Authentication required', 401);
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return failure('Invalid origin', 403);
      }
      const db = env.khutbah_clips_db;
      // The local media processor runs on the same computer as Wrangler in this release.
      // Do not expose a server-side processing endpoint on public Workers deployments.
      if (path.startsWith('/api/automation/')) {
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return failure('Local processor API is not available on public deployments',403);
        if (path === '/api/automation/queue' && method === 'GET') {
          const pending = await db.prepare("SELECT p.lecture_id,l.title,l.source_filename,l.source_size FROM processing_jobs p JOIN lectures l ON l.id=p.lecture_id WHERE p.status='queued' AND l.r2_key IS NOT NULL AND l.status IN ('uploaded','transcribed','highlights_ready') AND NOT EXISTS (SELECT 1 FROM clips c WHERE c.lecture_id=l.id AND c.status='approved') ORDER BY p.updated_at ASC LIMIT 5").all();
          return corslessJSON({ items:pending.results });
        }
        const jobMatch = path.match(/^\/api\/automation\/jobs\/([\w-]+)\/(claim|progress|finish|start|stop|status|retry)$/);
        if (jobMatch && (method === 'POST' || (method === 'GET' && jobMatch[2] === 'status'))) {
          const id=jobMatch[1], action=jobMatch[2];
          if (action === 'status' && method === 'GET') {
            const job=await db.prepare('SELECT status,stage,run_id FROM processing_jobs WHERE lecture_id=?').bind(id).first();
            return job ? corslessJSON(job) : failure('Job not found',404);
          }
          if (method !== 'POST') return failure('Method not allowed',405);
          if (action === 'start' || action === 'retry') {
            // Nothing is queued unless the user explicitly starts a selected lecture.
            const lecture=await findLecture(env,id);
            if (!lecture || !lecture.r2_key || lecture.status === 'uploading') return failure('Upload a source lecture before starting transcription',409);
            const changed=await db.prepare("UPDATE processing_jobs SET status='queued',stage='waiting',run_id=NULL,error_message='',segment_count=0,highlight_count=0,progress_seconds=0,duration_seconds=0,started_at=NULL,finished_at=NULL,updated_at=datetime('now') WHERE lecture_id=? AND status IN ('cancelled','failed') AND NOT EXISTS (SELECT 1 FROM clips c WHERE c.lecture_id=? AND c.status='approved')")
              .bind(id,id).run();
            return changed.meta.changes ? corslessJSON({ok:true,status:'queued'}) : failure('Lecture already queued, processing or completed, or it has approved clips',409);
          }
          if (action === 'stop') {
            // Immediately clears a stuck Processing state, even if Python was killed.
            // run_id invalidates writes from an older still-running worker.
            const changed=await db.prepare("UPDATE processing_jobs SET status='cancelled',stage='stopped',run_id=NULL,error_message='',finished_at=datetime('now'),updated_at=datetime('now') WHERE lecture_id=? AND status IN ('queued','processing')").bind(id).run();
            return changed.meta.changes ? corslessJSON({ok:true,status:'cancelled'}) : failure('No queued or running transcription to stop',409);
          }
          if (action === 'claim') {
            const runId=crypto.randomUUID();
            const changed=await db.prepare("UPDATE processing_jobs SET status='processing',stage='downloading',run_id=?,attempts=attempts+1,error_message='',progress_seconds=0,duration_seconds=0,segment_count=0,started_at=datetime('now'),finished_at=NULL,updated_at=datetime('now') WHERE lecture_id=? AND status='queued'").bind(runId,id).run();
            return changed.meta.changes ? corslessJSON({ok:true,run_id:runId}) : failure('Job already claimed or unavailable',409);
          }
          const body=await bodyJSON(request);
          const runId=clean(body.run_id,80);
          if (!runId) return failure('Processor run identifier is required',409);
          if (action === 'progress') {
            const stage=clean(body.stage,60);
            if (!['downloading','loading_model','transcribing','saving_subtitles','selecting_highlights'].includes(stage)) return failure('Invalid processing stage',422);
            const count=body.segment_count === undefined ? null : Number(body.segment_count);
            const processed=body.progress_seconds === undefined ? null : Number(body.progress_seconds);
            const duration=body.duration_seconds === undefined ? null : Number(body.duration_seconds);
            if (count !== null && (!Number.isSafeInteger(count) || count<0 || count>6000)) return failure('Invalid segment count',422);
            if (processed !== null && (!Number.isFinite(processed) || processed<0 || processed>86400)) return failure('Invalid audio progress',422);
            if (duration !== null && (!Number.isFinite(duration) || duration<0 || duration>86400)) return failure('Invalid audio duration',422);
            const changed=await db.prepare("UPDATE processing_jobs SET stage=?,segment_count=COALESCE(?,segment_count),progress_seconds=MAX(progress_seconds,COALESCE(?,progress_seconds)),duration_seconds=COALESCE(?,duration_seconds),updated_at=datetime('now') WHERE lecture_id=? AND status='processing' AND run_id=?").bind(stage,count,processed,duration,id,runId).run();
            return changed.meta.changes ? corslessJSON({ok:true}) : failure('Processing was stopped or restarted',409);
          }
          if (action === 'finish') {
            if (body.ok === true) {
              const totals=await db.prepare('SELECT COUNT(*) AS n FROM clips WHERE lecture_id=?').bind(id).first<any>();
              if (!totals?.n) return failure('Cannot finish without generated clips',409);
              const changed=await db.prepare("UPDATE processing_jobs SET status='complete',stage='complete',run_id=NULL,highlight_count=?,progress_seconds=duration_seconds,error_message='',finished_at=datetime('now'),updated_at=datetime('now') WHERE lecture_id=? AND status='processing' AND run_id=?").bind(totals.n,id,runId).run();
              return changed.meta.changes ? corslessJSON({ok:true}) : failure('Processing was stopped or restarted',409);
            }
            const message=clean(body.error,320) || 'Processing failed. Check the processor console.';
            const changed=await db.prepare("UPDATE processing_jobs SET status='failed',stage='failed',run_id=NULL,error_message=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE lecture_id=? AND status='processing' AND run_id=?").bind(message,id,runId).run();
            return changed.meta.changes ? corslessJSON({ok:true}) : failure('Processing was stopped or restarted',409);
          }
        }
      }
      // Local-only rendering automation. Same session and origin protections as the transcription processor.
      if(path.startsWith('/api/automation/renders/')){
        if(url.hostname!=='localhost' && url.hostname!=='127.0.0.1')return failure('Local renderer API is not available on public Workers',403);
        if(path==='/api/automation/renders/queue' && method==='GET'){
          const jobs=await db.prepare("SELECT r.clip_id,c.lecture_id,c.title,l.source_filename FROM reel_render_jobs r JOIN clips c ON c.id=r.clip_id JOIN lectures l ON l.id=c.lecture_id WHERE r.status='queued' AND c.status='approved' ORDER BY r.updated_at LIMIT 4").all();
          return corslessJSON({items:jobs.results});
        }
        const cmd=path.match(/^\/api\/automation\/renders\/([\w-]+)\/(claim|recipe|status|progress|upload-init|upload-part|upload-complete|finish)$/);
        if(cmd){
          const id=cmd[1],action=cmd[2];
          if(action==='claim' && method==='POST'){
            const run=crypto.randomUUID();
            const change=await db.prepare("UPDATE reel_render_jobs SET status='rendering',stage='preparing',run_id=?,progress_pct=0,error_message='',updated_at=datetime('now') WHERE clip_id=? AND status='queued' AND EXISTS (SELECT 1 FROM clips WHERE id=? AND status='approved')").bind(run,id,id).run();
            return change.meta.changes?corslessJSON({ok:true,run_id:run}):failure('Reel job already claimed or approval changed',409);
          }
          const runId=clean(request.headers.get('X-Khutbah-Run-Id'),80);
          const render=await db.prepare('SELECT * FROM reel_render_jobs WHERE clip_id=?').bind(id).first<any>();
          if(!render||!runId||render.run_id!==runId||!['rendering','uploading'].includes(render.status))return failure('Render stopped, restarted or unavailable',409);
          if(action==='status' && method==='GET')return corslessJSON({status:render.status,stage:render.stage,run_id:render.run_id});
          if(action==='recipe' && method==='GET'){
            const clip=await db.prepare("SELECT c.*,l.title AS lecture_title,l.speaker,l.source_filename,l.source_size FROM clips c JOIN lectures l ON c.lecture_id=l.id WHERE c.id=? AND c.status='approved'").bind(id).first<any>();
            if(!clip)return failure('Approved clip no longer available',409);
            const segments=await db.prepare('SELECT start_ms,end_ms,text FROM transcript_segments WHERE lecture_id=? AND end_ms>? AND start_ms<? ORDER BY start_ms').bind(clip.lecture_id,clip.start_ms,clip.end_ms).all();
            return corslessJSON({clip,transcript:segments.results,options:{brand_name:render.brand_name,crop_mode:render.crop_mode,caption_style:render.caption_style}});
          }
          if(method!=='POST')return failure('Method not allowed',405);
          if(action==='progress'){
            const body=await bodyJSON(request);
            const pct=Number(body.progress_pct);
            if(!Number.isInteger(pct)||pct<0||pct>100)return failure('Invalid progress percentage',422);
            const stage=clean(body.stage,40);
            if(!['preparing','downloading','rendering','uploading','finalizing'].includes(stage))return failure('Invalid render stage',422);
            const change=await db.prepare("UPDATE reel_render_jobs SET stage=?,progress_pct=MAX(progress_pct,?),updated_at=datetime('now') WHERE clip_id=? AND status IN ('rendering','uploading') AND run_id=?").bind(stage,pct,id,runId).run();
            return change.meta.changes?corslessJSON({ok:true}):failure('Render stopped',409);
          }
          if(action==='upload-init'){
            if(render.status!=='rendering')return failure('Render not ready for upload',409);
            const body=await bodyJSON(request);
            const size=Number(body.size);
            if(!Number.isSafeInteger(size)||size<1024||size>1024*1024*1024)return failure('Invalid Reel size',422);
            const key=`reels/${id}/${runId}.mp4`;
            const multipart=await env.khutbah_reels_output.createMultipartUpload(key,{httpMetadata:{contentType:'video/mp4'}});
            const change=await db.prepare("UPDATE reel_render_jobs SET status='uploading',stage='uploading',output_key=?,output_size=?,upload_id=?,progress_pct=MAX(progress_pct,90),updated_at=datetime('now') WHERE clip_id=? AND status='rendering' AND run_id=?").bind(key,size,multipart.uploadId,id,runId).run();
            if(!change.meta.changes){await multipart.abort();return failure('Render stopped',409)}
            return corslessJSON({ok:true,chunkSize:8*1024*1024});
          }
          if(action==='upload-part'){
            if(render.status!=='uploading'||!render.upload_id||!render.output_key)return failure('Upload not active',409);
            const partNumber=Number(url.searchParams.get('part'));
            if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000||!request.body)return failure('Invalid upload part',422);
            const length=Number(request.headers.get('Content-Length')||0);
            if(length<1||length>16*1024*1024)return failure('Invalid chunk size',422);
            const multi=env.khutbah_reels_output.resumeMultipartUpload(render.output_key,render.upload_id);
            const uploaded=await multi.uploadPart(partNumber,request.body);
            await db.prepare('INSERT OR REPLACE INTO reel_upload_parts(clip_id,part_number,etag) VALUES(?,?,?)').bind(id,partNumber,uploaded.etag).run();
            return corslessJSON({ok:true,partNumber});
          }
          if(action==='upload-complete'){
            if(render.status!=='uploading'||!render.upload_id||!render.output_key)return failure('Upload not active',409);
            const parts=await db.prepare('SELECT part_number,etag FROM reel_upload_parts WHERE clip_id=? ORDER BY part_number').bind(id).all<any>();
            if(!parts.results.length||parts.results.some((part,i)=>part.part_number!==i+1))return failure('Upload incomplete',409);
            const multi=env.khutbah_reels_output.resumeMultipartUpload(render.output_key,render.upload_id);
            await multi.complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag})));
            const change=await db.prepare("UPDATE reel_render_jobs SET status='complete',stage='complete',run_id=NULL,upload_id=NULL,progress_pct=100,error_message='',finished_at=datetime('now'),updated_at=datetime('now') WHERE clip_id=? AND status='uploading' AND run_id=?").bind(id,runId).run();
            return change.meta.changes?corslessJSON({ok:true}):failure('Render stopped before completion',409);
          }
          if(action==='finish'){
            const body=await bodyJSON(request);
            const error=clean(body.error,280)||'Video rendering failed. See processor terminal.';
            const change=await db.prepare("UPDATE reel_render_jobs SET status='failed',stage='failed',run_id=NULL,upload_id=NULL,progress_pct=0,output_key=NULL,error_message=?,updated_at=datetime('now') WHERE clip_id=? AND status IN ('rendering','uploading') AND run_id=?").bind(error,id,runId).run();
            return change.meta.changes?corslessJSON({ok:true}):failure('Render stopped',409);
          }
        }
      }
      if (path === '/api/overview' && method === 'GET') {
        const [lectures, clips, review, approved, recent] = await Promise.all([
          db.prepare('SELECT COUNT(*) AS n FROM lectures').first<any>(),
          db.prepare('SELECT COUNT(*) AS n FROM clips').first<any>(),
          db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status='needs_review'").first<any>(),
          db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status='approved'").first<any>(),
          db.prepare('SELECT * FROM lectures ORDER BY created_at DESC LIMIT 6').all()
        ]);
        return corslessJSON({ lectures:lectures?.n||0, clips:clips?.n||0, review:review?.n||0, approved:approved?.n||0, recent:recent.results });
      }
      if (path === '/api/lectures' && method === 'GET') {
        const records = await db.prepare('SELECT l.*, (SELECT COUNT(*) FROM clips c WHERE c.lecture_id=l.id) AS clip_count FROM lectures l ORDER BY created_at DESC LIMIT 100').all();
        return corslessJSON({ items: records.results });
      }
      if (path === '/api/lectures' && method === 'POST') {
        const body = await bodyJSON(request);
        const title = clean(body.title, 170), speaker = clean(body.speaker, 120), type = clean(body.lecture_type, 45) || 'Khutbah';
        if (!title) return failure('Lecture title is required');
        if (body.rights_confirmed !== true) return failure('Confirm that you own or have permission to edit and republish the source video');
        const youtube = clean(body.youtube_url, 600);
        if (youtube) {
          let hostname = '';
          try { const sourceUrl = new URL(youtube); if (sourceUrl.protocol === 'https:') hostname = sourceUrl.hostname.toLowerCase(); } catch { /* invalid URL */ }
          if (!['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(hostname)) return failure('Enter a valid YouTube reference URL');
        }
        const id = crypto.randomUUID();
        await db.prepare('INSERT INTO lectures(id,title,speaker,lecture_type,youtube_url,rights_confirmed) VALUES(?,?,?,?,?,1)').bind(id,title,speaker,type,youtube || null).run();
        return corslessJSON({ id, status:'created' }, 201);
      }
      const videoMatch = path.match(/^\/api\/lectures\/([\w-]+)\/video$/);
      if (videoMatch && method === 'GET') {
        const lecture = await findLecture(env,videoMatch[1]);
        return lecture ? serveVideo(request,env,lecture) : failure('Lecture not found',404);
      }
      const singleMatch = path.match(/^\/api\/lectures\/([\w-]+)$/);
      if (singleMatch && method === 'GET') {
        const bundle = await getLectureBundle(env,singleMatch[1]);
        return bundle ? corslessJSON(bundle) : failure('Lecture not found',404);
      }
      const initMatch = path.match(/^\/api\/lectures\/([\w-]+)\/upload\/init$/);
      if (initMatch && method === 'POST') {
        const lecture = await findLecture(env,initMatch[1]);
        if (!lecture) return failure('Lecture not found',404);
        if (lecture.upload_id) return failure('An upload has already been started for this lecture; create a new lecture to retry.',409);
        const body = await bodyJSON(request);
        const size = Number(body.size);
        const filename = clean(body.filename,240);
        const mime = clean(body.mime,100) || 'application/octet-stream';
        if (!filename || !Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) return failure('Select a valid video file smaller than 8 GiB');
        if (!/^(video\/|audio\/)/.test(mime)) return failure('Only video or audio files are allowed');
        const key = `sources/${lecture.id}/${filename.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const multi = await env.khutbah_source_videos.createMultipartUpload(key, { httpMetadata:{contentType:mime} });
        await db.prepare("UPDATE lectures SET source_filename=?,source_size=?,source_mime=?,r2_key=?,upload_id=?,status='uploading',updated_at=datetime('now') WHERE id=?")
          .bind(filename,size,mime,key,multi.uploadId,lecture.id).run();
        return corslessJSON({ uploadId:multi.uploadId, chunkSize:8*1024*1024 });
      }
      const partMatch = path.match(/^\/api\/lectures\/([\w-]+)\/upload\/parts\/(\d+)$/);
      if (partMatch && method === 'PUT') {
        const lecture = await findLecture(env,partMatch[1]);
        if (!lecture || !lecture.upload_id || lecture.status !== 'uploading') return failure('Upload is not active',409);
        const partNumber = Number(partMatch[2]);
        const size = Number(request.headers.get('content-length'));
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !size || size > 16*1024*1024) return failure('Invalid upload part');
        if (!request.body) return failure('Missing part data');
        const multipart = env.khutbah_source_videos.resumeMultipartUpload(lecture.r2_key,lecture.upload_id);
        const part = await multipart.uploadPart(partNumber,request.body);
        await db.prepare('INSERT OR REPLACE INTO upload_parts(lecture_id,part_number,etag) VALUES(?,?,?)').bind(lecture.id,partNumber,part.etag).run();
        return corslessJSON({partNumber,etag:part.etag});
      }
      const completeMatch = path.match(/^\/api\/lectures\/([\w-]+)\/upload\/complete$/);
      if (completeMatch && method === 'POST') {
        const lecture = await findLecture(env,completeMatch[1]);
        if (!lecture || !lecture.upload_id || lecture.status !== 'uploading') return failure('No active upload',409);
        const parts = await db.prepare('SELECT part_number,etag FROM upload_parts WHERE lecture_id=? ORDER BY part_number').bind(lecture.id).all<any>();
        if (!parts.results.length || parts.results.some((p,i)=>p.part_number!==i+1)) return failure('Upload parts are incomplete',409);
        const multipart = env.khutbah_source_videos.resumeMultipartUpload(lecture.r2_key,lecture.upload_id);
        await multipart.complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag})));
        await db.prepare("UPDATE lectures SET status='uploaded',upload_id=NULL,updated_at=datetime('now') WHERE id=?").bind(lecture.id).run();
        await db.prepare('DELETE FROM upload_parts WHERE lecture_id=?').bind(lecture.id).run();
        await db.prepare("INSERT OR IGNORE INTO processing_jobs(lecture_id,status,stage) VALUES(?,'cancelled','ready_to_start')").bind(lecture.id).run();
        return corslessJSON({ok:true,status:'uploaded',automation:'ready_to_start'});
      }
      const transcriptMatch = path.match(/^\/api\/lectures\/([\w-]+)\/transcript$/);
      if (transcriptMatch && method === 'POST') {
        const lecture = await findLecture(env,transcriptMatch[1]);
        if (!lecture) return failure('Lecture not found',404);
        const job=await db.prepare('SELECT status,run_id FROM processing_jobs WHERE lecture_id=?').bind(lecture.id).first<any>();
        const workerRun=clean(request.headers.get('X-Khutbah-Run-Id'),80);
        if (workerRun && (job?.status!=='processing' || job?.run_id!==workerRun)) return failure('Processing was stopped or restarted',409);
        if (!workerRun && ['processing','queued'].includes(job?.status)) return failure('Stop transcription before manually replacing subtitles',409);
        const body = await bodyJSON(request);
        const segments = parseTranscript(clean(body.text,1_500_000));
        // Replacement invalidates earlier suggestions; never preserve approval on changed source.
        await db.prepare('DELETE FROM clips WHERE lecture_id=?').bind(lecture.id).run();
        await db.prepare('DELETE FROM transcript_segments WHERE lecture_id=?').bind(lecture.id).run();
        for (let i = 0; i < segments.length; i += 50) {
          const items = segments.slice(i,i+50).map(s=>db.prepare('INSERT INTO transcript_segments(id,lecture_id,start_ms,end_ms,text) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),lecture.id,s.start_ms,s.end_ms,s.text));
          await db.batch(items);
        }
        await db.prepare("UPDATE lectures SET status='transcribed',updated_at=datetime('now') WHERE id=?").bind(lecture.id).run();
        // Manual fallback import cancels any queued job to avoid overwriting the editor's transcript.
        await db.prepare("UPDATE processing_jobs SET status='cancelled',stage='manual_transcript',updated_at=datetime('now') WHERE lecture_id=? AND status='queued'").bind(lecture.id).run();
        return corslessJSON({ count:segments.length });
      }
      const highlightsMatch = path.match(/^\/api\/lectures\/([\w-]+)\/highlights$/);
      if (highlightsMatch && method === 'POST') {
        const lecture = await findLecture(env,highlightsMatch[1]);
        if (!lecture) return failure('Lecture not found',404);
        const job=await db.prepare('SELECT status,run_id FROM processing_jobs WHERE lecture_id=?').bind(lecture.id).first<any>();
        const workerRun=clean(request.headers.get('X-Khutbah-Run-Id'),80);
        if (workerRun && (job?.status!=='processing' || job?.run_id!==workerRun)) return failure('Processing was stopped or restarted',409);
        if (!workerRun && ['processing','queued'].includes(job?.status)) return failure('Stop transcription before manually generating highlights',409);
        if (workerRun && (await db.prepare("SELECT 1 FROM clips WHERE lecture_id=? AND status='approved' LIMIT 1").bind(lecture.id).first())) return failure('Approved clips must not be overwritten by automation',409);
        const found = await db.prepare('SELECT start_ms,end_ms,text FROM transcript_segments WHERE lecture_id=? ORDER BY start_ms').bind(lecture.id).all<Segment>();
        if (found.results.length < 4) return failure('Import more timed subtitle segments before generating highlights',409);
        const suggestions = heuristicHighlights(found.results);
        if (!suggestions.length) return failure('Could not find complete 45–60-second windows. The subtitles may be too short or contain long gaps.',422);
        const result = await aiRank(suggestions,env);
        // Regeneration invalidates previous reviews: intentional and confirmed in the UI.
        await db.prepare('DELETE FROM clips WHERE lecture_id=?').bind(lecture.id).run();
        for (const candidate of result.picks) {
          await db.prepare('INSERT INTO clips(id,lecture_id,title,start_ms,end_ms,score,rationale) VALUES(?,?,?,?,?,?,?)')
            .bind(crypto.randomUUID(),lecture.id,candidate.title,candidate.start_ms,candidate.end_ms,candidate.score,candidate.rationale).run();
        }
        await db.prepare("UPDATE lectures SET status='highlights_ready',updated_at=datetime('now') WHERE id=?").bind(lecture.id).run();
        return corslessJSON({ count:result.picks.length, mode:result.mode, warning:result.warning || null });
      }
      // Custom, user-supplied mosque logo. No SVG or externally hosted images are accepted.
      if(path==='/api/branding/logo' && method==='GET'){
        const asset=await db.prepare("SELECT r2_key,mime_type FROM brand_assets WHERE name='logo'").first<any>();
        if(!asset)return failure('No mosque logo uploaded',404);
        const file=await env.khutbah_reels_output.get(asset.r2_key);
        return file?new Response(file.body,{headers:{'Content-Type':asset.mime_type,'Content-Length':String(file.size),'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}}):failure('Logo unavailable',404);
      }
      if(path==='/api/branding/status' && method==='GET'){
        const asset=await db.prepare("SELECT mime_type,updated_at FROM brand_assets WHERE name='logo'").first<any>();
        return corslessJSON({has_logo:!!asset,updated_at:asset?.updated_at||null});
      }
      if(path==='/api/branding/logo' && method==='PUT'){
        const claimed=request.headers.get('Content-Type')?.split(';')[0].trim()||'';
        if(!['image/png','image/jpeg','image/webp'].includes(claimed))return failure('Upload a PNG, JPEG or WebP logo (no SVG)',422);
        const size=Number(request.headers.get('Content-Length')||0);
        if(size>2*1024*1024)return failure('Logo maximum size is 2 MB',413);
        const bytes=new Uint8Array(await request.arrayBuffer());
        if(bytes.byteLength>2*1024*1024||bytes.byteLength<20)return failure('Logo must be 20 bytes to 2 MB',422);
        const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
        const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
        if((claimed==='image/png'&&!png)||(claimed==='image/jpeg'&&!jpeg)||(claimed==='image/webp'&&!webp))return failure('Image content does not match file type',422);
        const ext=claimed==='image/png'?'png':claimed==='image/jpeg'?'jpg':'webp';
        const key=`branding/masjid-logo-${crypto.randomUUID()}.${ext}`;
        await env.khutbah_reels_output.put(key,bytes,{httpMetadata:{contentType:claimed}});
        await db.prepare("INSERT INTO brand_assets(name,r2_key,mime_type) VALUES('logo',?,?) ON CONFLICT(name) DO UPDATE SET r2_key=excluded.r2_key,mime_type=excluded.mime_type,updated_at=datetime('now')").bind(key,claimed).run();
        return corslessJSON({ok:true});
      }
      // Reel export is explicitly opt-in, and only approved clips can be rendered/downloaded.
      if (path === '/api/reels' && method === 'GET') {
        const jobs=await db.prepare('SELECT clip_id,status,stage,progress_pct,error_message,output_size,brand_name,crop_mode,caption_style FROM reel_render_jobs ORDER BY updated_at DESC LIMIT 300').all();
        return corslessJSON({items:jobs.results});
      }
      const reelCreate=path.match(/^\/api\/reels\/([\w-]+)\/render$/);
      if (reelCreate && method === 'POST') {
        const id=reelCreate[1];
        const clip=await db.prepare('SELECT c.*,l.r2_key,l.status AS lecture_status FROM clips c JOIN lectures l ON c.lecture_id=l.id WHERE c.id=?').bind(id).first<any>();
        if (!clip) return failure('Clip not found',404);
        if (clip.status!=='approved'||!clip.check_context||!clip.check_quotes||!clip.check_captions||!clip.check_rights) return failure('Review all four accuracy/rights checks and approve before rendering',409);
        if (!clip.r2_key||clip.lecture_status==='uploading') return failure('Original video not available for rendering',409);
        const body=await bodyJSON(request);
        const brand=clean(body.brand_name,80)||'Masjid At-Towfiq | Bolton';
        const crop=['centre','left','right','blur'].includes(body.crop_mode)?body.crop_mode:'centre';
        const captions=['classic','bold'].includes(body.caption_style)?body.caption_style:'classic';
        const existing=await db.prepare('SELECT status FROM reel_render_jobs WHERE clip_id=?').bind(id).first<any>();
        if(existing && ['queued','rendering','uploading'].includes(existing.status))return failure('Reel already queued or rendering',409);
        if(existing && existing.status==='complete' && body.force!==true)return failure('Reel already generated. Download it or choose Re-render.',409);
        await db.prepare("INSERT INTO reel_render_jobs(clip_id,status,stage,brand_name,crop_mode,caption_style) VALUES(?,'queued','queued',?,?,?) ON CONFLICT(clip_id) DO UPDATE SET status='queued',stage='queued',run_id=NULL,progress_pct=0,brand_name=excluded.brand_name,crop_mode=excluded.crop_mode,caption_style=excluded.caption_style,output_key=NULL,output_size=0,upload_id=NULL,error_message='',finished_at=NULL,updated_at=datetime('now')")
          .bind(id,brand,crop,captions).run();
        await db.prepare('DELETE FROM reel_upload_parts WHERE clip_id=?').bind(id).run();
        return corslessJSON({ok:true,status:'queued'});
      }
      const reelStop=path.match(/^\/api\/reels\/([\w-]+)\/stop$/);
      if (reelStop && method==='POST') {
        const change=await db.prepare("UPDATE reel_render_jobs SET status='cancelled',stage='stopped',run_id=NULL,upload_id=NULL,output_key=NULL,progress_pct=0,updated_at=datetime('now') WHERE clip_id=? AND status IN ('queued','rendering','uploading')").bind(reelStop[1]).run();
        return change.meta.changes ? corslessJSON({ok:true}) : failure('No active Reel job',409);
      }
      const reelFile=path.match(/^\/api\/reels\/([\w-]+)\/file$/);
      if (reelFile && (method==='GET'||method==='HEAD')) {
        const info=await db.prepare("SELECT r.output_key,c.title,c.status AS approval FROM reel_render_jobs r JOIN clips c ON c.id=r.clip_id WHERE r.clip_id=? AND r.status='complete'").bind(reelFile[1]).first<any>();
        if (!info||!info.output_key||info.approval!=='approved')return failure('Approved rendered video not available',404);
        const head=await env.khutbah_reels_output.head(info.output_key);
        if (!head)return failure('Rendered MP4 not found in storage',404);
        const filename=`khutbah-reel-${reelFile[1].slice(0,8)}.mp4`;
        const download=url.searchParams.get('download')==='1';
        const range=request.headers.get('Range');
        const size=head.size;
        let start=0,end=size-1,partial=false;
        if(range){
          const match=range.match(/^bytes=(\d+)-(\d*)$/);
          if(!match)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
          start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;
          if(start>=size||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
          partial=true;
        }
        const stored=method==='HEAD'?null:await env.khutbah_reels_output.get(info.output_key,partial?{range:{offset:start,length:end-start+1}}:undefined);
        if(method!=='HEAD'&&!stored)return failure('Rendered MP4 unavailable',404);
        return new Response(method==='HEAD'?null:stored!.body,{status:partial?206:200,headers:{
          'Content-Type':'video/mp4','Content-Length':String(partial?end-start+1:size),
          'Content-Disposition':`${download?'attachment':'inline'}; filename="${filename}"`,
          'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
          'Accept-Ranges':'bytes',...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})
        }});
      }
      if (path === '/api/clips' && method === 'GET') {
        const clips = await db.prepare('SELECT c.*,l.title AS lecture_title,l.speaker,r.status AS render_status,r.progress_pct AS render_progress,r.error_message AS render_error,r.brand_name AS render_brand,r.crop_mode AS render_crop,r.caption_style AS render_caption_style FROM clips c JOIN lectures l ON l.id=c.lecture_id LEFT JOIN reel_render_jobs r ON r.clip_id=c.id ORDER BY c.created_at DESC, c.start_ms LIMIT 200').all();
        return corslessJSON({items:clips.results});
      }
      const clipMatch = path.match(/^\/api\/clips\/([\w-]+)$/);
      if (clipMatch && method === 'PATCH') {
        const clip = await db.prepare('SELECT * FROM clips WHERE id=?').bind(clipMatch[1]).first<any>();
        if (!clip) return failure('Clip not found',404);
        const body = await bodyJSON(request);
        const status = body.status === 'rejected' ? 'rejected' : body.status === 'approved' ? 'approved' : 'needs_review';
        const checkContext = body.check_context === true ? 1 : 0;
        const checkQuotes = body.check_quotes === true ? 1 : 0;
        const checkCaptions = body.check_captions === true ? 1 : 0;
        const checkRights = body.check_rights === true ? 1 : 0;
        if (status === 'approved' && !(checkContext && checkQuotes && checkCaptions && checkRights)) return failure('Approval requires all four review checks',422);
        const title = clean(body.title,100) || clip.title;
        await db.prepare("UPDATE clips SET title=?,status=?,check_context=?,check_quotes=?,check_captions=?,check_rights=?,reviewer_notes=?,updated_at=datetime('now') WHERE id=?")
          .bind(title,status,checkContext,checkQuotes,checkCaptions,checkRights,clean(body.reviewer_notes,1000),clip.id).run();
        if (clip.status !== status || clip.title !== title || clip.check_captions !== checkCaptions || clip.check_context !== checkContext || clip.check_quotes !== checkQuotes || clip.check_rights !== checkRights) {
          await db.prepare("UPDATE reel_render_jobs SET status='cancelled',run_id=NULL,stage='review_changed',output_key=NULL,upload_id=NULL,progress_pct=0,updated_at=datetime('now') WHERE clip_id=?").bind(clip.id).run();
        }
        return corslessJSON({ok:true,status});
      }
      return failure('API endpoint not found',404);
    } catch (error) {
      // Avoid leaking credentials or internal storage details in responses.
      const message = error instanceof SyntaxError ? 'Invalid JSON or transcript format' : error instanceof Error ? error.message : 'Unexpected error';
      const safe = /^(Invalid|No timed|Transcript|Please import|JSON request|Select a valid)/.test(message);
      console.error('API request failed', path, error);
      return failure(safe ? message : 'Request could not be completed. Check the Wrangler logs.',safe ? 400 : 500);
    }
  }
} satisfies ExportedHandler<Bindings>;
