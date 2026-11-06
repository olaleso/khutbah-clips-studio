const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {view:'dashboard', lectures:[], overview:null, bundle:null, clips:[], reels:{}, busy:false};
const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatMs = n => {const s=Math.max(0,Math.floor(Number(n)/1000));return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const fmtBytes = n => !n ? '—' : n >= 1024**3 ? `${(n/1024**3).toFixed(2)} GB` : `${(n/1024**2).toFixed(1)} MB`;
const dateStr = s => s ? new Date(s.replace(' ','T')+'Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';
function toast(msg,error=false){const t=$('#toast');t.textContent=msg;t.className='toast'+(error?' error':'');setTimeout(()=>t.classList.add('hidden'),6500);}
async function api(path,opts={}){
  const res=await fetch('/api'+path,{credentials:'same-origin', ...opts, headers: opts.body instanceof Blob? {...opts.headers}: {'Content-Type':'application/json',...opts.headers}});
  let data;try{data=await res.json();}catch{throw Error(`Server returned ${res.status}`)}
  if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);
  return data;
}
async function loadSession(){
  try{const status=await api('/session');if(status.authenticated){$('#loginScreen').classList.add('hidden');$('#appShell').classList.remove('hidden');await reload();await loadBranding();}else{$('#loginScreen').classList.remove('hidden');$('#appShell').classList.add('hidden');if(status.needsConfiguration)$('#loginError').textContent='Admin token is not configured. Run: npx wrangler secret put ADMIN_TOKEN';}}
  catch(e){$('#loginScreen').classList.remove('hidden');$('#loginError').textContent=e.message;}
}
async function reload(){
  try{
    const [overview,lectures,allClips,allReels]=await Promise.all([api('/overview'),api('/lectures'),api('/clips'),api('/reels')]);
    state.overview=overview;state.lectures=lectures.items;state.clips=allClips.items;state.reels=Object.fromEntries(allReels.items.map(r=>[r.clip_id,r]));
    renderDashboard();renderLibrary();renderLectureSelect();renderReview();renderReelExports();
  }catch(e){toast(e.message,true)}
}
function switchView(view){
  state.view=view;
  $$('.view').forEach(v=>v.classList.add('hidden'));
  const target=$('#view-'+view); if(!target)return;target.classList.remove('hidden');
  $$('#nav .nav-item').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===view));
  $('#breadcrumbCurrent').textContent=view.replace(/_/g,' ').toUpperCase();
  if(view==='studio' && state.bundle)renderStudio();
  window.scrollTo({top:0,behavior:'smooth'});
}
function tableHtml(records){
  if(!records?.length)return '<div class="empty-state">No lectures yet. Add your first lecture to begin.</div>';
  return `<div class="table-region"><table class="data-table"><thead><tr><th>Lecture</th><th>Speaker</th><th>Added</th><th>Status</th><th></th></tr></thead><tbody>${records.map(l=>`<tr><td><div class="title-cell">${html(l.title)}</div><div class="minor">${html(l.lecture_type||'Lecture')} · ${fmtBytes(l.source_size)}</div></td><td>${html(l.speaker||'—')}</td><td>${dateStr(l.created_at)}</td><td><span class="pill">${html(l.status)}</span></td><td><button class="link-button" data-openlecture="${html(l.id)}">Open studio →</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderDashboard(){
  const o=state.overview||{};
  $('#statLectures').textContent=o.lectures??0;$('#statClips').textContent=o.clips??0;
  $('#statReview').textContent=o.review??0;$('#statApproved').textContent=o.approved??0;$('#pendingNav').textContent=o.review??0;
  $('#recentLectures').innerHTML=tableHtml(o.recent);
}
function renderLibrary(){$('#libraryRows').innerHTML=tableHtml(state.lectures);}
function renderLectureSelect(){const selected=$('#lectureSelect').value;$('#lectureSelect').innerHTML='<option value="">Choose a lecture…</option>'+state.lectures.map(l=>`<option value="${html(l.id)}">${html(l.title)} — ${html(l.speaker||'Unknown speaker')}</option>`).join('');if(state.lectures.some(l=>l.id===selected))$('#lectureSelect').value=selected;}
function showModal(){ $('#modalBackdrop').classList.remove('hidden');$('#lectureTitle').focus();$('#uploadStatus').textContent='';$('#uploadProgressOuter').classList.add('hidden');$('#uploadProgress').style.width='0'; }
function hideModal(){if(!state.busy)$('#modalBackdrop').classList.add('hidden');}
async function createLecture(e){
  e.preventDefault(); if(state.busy)return;
  state.busy=true; const btn=$('#createLectureBtn');btn.disabled=true;btn.textContent='Creating project…';
  try{
    const file=$('#lectureFile').files[0];
    const body={title:$('#lectureTitle').value,speaker:$('#lectureSpeaker').value,lecture_type:$('#lectureType').value,youtube_url:$('#lectureYouTube').value,rights_confirmed:$('#rightsConfirm').checked};
    const {id}=await api('/lectures',{method:'POST',body:JSON.stringify(body)});
    if(file)await uploadFile(id,file);
    state.busy=false;btn.disabled=false;btn.textContent='Create lecture';hideModal();$('#lectureForm').reset();
    await reload();await openLecture(id);toast(file?'Lecture uploaded. Select Start transcription when you are ready.':'Lecture created. Upload a source video when ready; transcription stays off until you start it.');
  }catch(err){state.busy=false;btn.disabled=false;btn.textContent='Create lecture';toast(err.message,true);$('#uploadStatus').textContent=`Upload interrupted: ${err.message}. The lecture may have been saved; check the library.`;await reload();}
}
async function uploadFile(id,file){
  const init=await api(`/lectures/${id}/upload/init`,{method:'POST',body:JSON.stringify({filename:file.name,size:file.size,mime:file.type||'video/mp4'})});
  const chunkSize=init.chunkSize;const count=Math.ceil(file.size/chunkSize);
  $('#uploadProgressOuter').classList.remove('hidden');
  for(let i=0;i<count;i++){
    const chunk=file.slice(i*chunkSize,Math.min(file.size,(i+1)*chunkSize));
    let passed=false;
    for(let attempt=0;attempt<3&&!passed;attempt++){
      try{
        const res=await fetch(`/api/lectures/${id}/upload/parts/${i+1}`,{method:'PUT',body:chunk,credentials:'same-origin'});
        const result=await res.json();if(!res.ok)throw Error(result.error||'Transfer failed');passed=true;
      }catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,900*(attempt+1)));}
    }
    const pct=Math.round((i+1)/count*100);$('#uploadProgress').style.width=`${pct}%`;$('#uploadStatus').textContent=`Uploading ${file.name}: ${pct}% (${i+1}/${count} parts)`;
  }
  await api(`/lectures/${id}/upload/complete`,{method:'POST',body:'{}'});
}
async function openLecture(id){
  switchView('studio');
  $('#lectureSelect').value=id;
  await loadLecture(id);
}
async function loadLecture(id){
  if(!id){state.bundle=null;$('#studioContent').classList.add('hidden');$('#studioNothing').classList.remove('hidden');return;}
  try{state.bundle=await api(`/lectures/${id}`);renderStudio();}catch(err){toast(err.message,true)}
}
function renderAutomationStatus(lecture, job, transcriptCount){
  const statusBox=$('#autoStatus'),startBtn=$('#startTranscription'),stopBtn=$('#stopTranscription');
  startBtn.classList.add('hidden');stopBtn.classList.add('hidden');
  // Progress is based on audio-time coverage, not an invented total count of speech segments.
  const progressPanel=$('#autoProgressPanel');
  const duration=Math.max(0,Number(job?.duration_seconds)||0);
  const processed=Math.max(0,Math.min(duration,Number(job?.progress_seconds)||0));
  const meaningful=duration>0 && (job?.status==='processing'||job?.status==='complete');
  progressPanel.classList.toggle('hidden',!meaningful);
  if(meaningful){
    const completed=job.status==='complete';
    const pct=completed?100:Math.min(99,Math.floor(100*processed/duration));
    const totalBlocks=Math.ceil(duration/30);
    const doneBlocks=completed?totalBlocks:Math.min(totalBlocks,Math.floor(processed/30));
    $('#autoProgressPercent').textContent=`${pct}%`;
    $('#autoProgressTimeline').textContent=`${formatMs((completed?duration:processed)*1000)} / ${formatMs(duration*1000)}`;
    $('#autoProgressBar').style.width=`${pct}%`;
    $('.auto-progress-track').setAttribute('aria-valuenow',String(pct));
    $('#autoProgressBlocks').textContent=`${doneBlocks} / ${totalBlocks} 30-second timeline blocks`;
    $('#autoProgressSegments').textContent=`${Number(job.segment_count)||0} subtitle segments`;
  }
  const descriptions={downloading:'Downloading source media',loading_model:'Loading speech recognition',transcribing:`Recognising speech (${job?.segment_count||0} segments)`,saving_subtitles:'Saving timestamped subtitles',selecting_highlights:'Selecting candidate clips'};
  if(!lecture.r2_key || lecture.status==='uploading'){
    statusBox.textContent='Upload the original lecture first. Processing will NOT start automatically.';
  }else if(!job){
    statusBox.textContent='Job record not available. Apply migration 0003_manual_transcription_control.sql.';
  }else if(job.status==='queued'){
    statusBox.textContent='You requested transcription. Waiting for your local processing service to pick up this lecture.';
    stopBtn.classList.remove('hidden');stopBtn.textContent='■ Cancel queued job';
  }else if(job.status==='processing'){
    const lastUpdate=Date.parse(String(job.updated_at||'').replace(' ','T')+'Z');
    const interrupted=Number.isFinite(lastUpdate) && Date.now()-lastUpdate>5*60*1000;
    statusBox.textContent=interrupted?'No progress heartbeat recently. The processor may have stopped. Use Stop / reset to clear this state.':`Processing this lecture: ${descriptions[job.stage]||job.stage}. You can stop it at any time.`;
    stopBtn.classList.remove('hidden');stopBtn.textContent=interrupted?'■ Reset interrupted job':'■ Stop transcription';
  }else if(job.status==='complete'){
    statusBox.textContent=`Transcription complete: ${job.segment_count} timed segments and ${job.highlight_count} suggested clips. Review them below.`;
  }else if(job.status==='failed'){
    statusBox.textContent=`Previous attempt failed: ${job.error_message||'Check the processor terminal.'} Choose Start transcription to try again.`;
    startBtn.classList.remove('hidden');startBtn.textContent='↻ Retry transcription';
  }else if(job.status==='cancelled'){
    statusBox.textContent=job.stage==='interrupted'?'The previous processor was interrupted. Your lecture is preserved; choose Start transcription when ready.':job.stage==='stopped'?'Transcription stopped. Your lecture is preserved and will not restart until you choose Start transcription.':transcriptCount?'Transcript available. Transcription is not running.':'Ready to transcribe. Click Start transcription when you choose; uploads do not run automatically.';
    startBtn.classList.remove('hidden');startBtn.textContent='▶ Start transcription';
  }else{
    statusBox.textContent=transcriptCount?'Timed transcript available.':'Ready for a video upload.';
  }
  // This action is unavailable for approved clips: never overwrite review decisions accidentally.
  if(state.bundle?.clips?.some(c=>c.status==='approved'))startBtn.classList.add('hidden');
}
function renderStudio(){
  if(!state.bundle)return;
  const {lecture,transcript,clips}=state.bundle;
  $('#studioContent').classList.remove('hidden');$('#studioNothing').classList.add('hidden');
  $('#lectureState').textContent=lecture.status.replace(/_/g,' ');
  const video=$('#videoPreview');video.pause();video.removeAttribute('src');video.load();
  if(lecture.r2_key && lecture.status!=='uploading') {video.src=`/api/lectures/${lecture.id}/video`;video.load();$('#videoEmpty').classList.add('hidden');}
  else $('#videoEmpty').classList.remove('hidden');
  $('#sourceInfo').innerHTML=`<strong>${html(lecture.title)}</strong><br>${html(lecture.speaker||'Speaker not specified')} · ${html(lecture.lecture_type)} · ${html(lecture.source_filename||'No video uploaded yet')}`;
  $('#existingUploadLabel').classList.toggle('hidden',Boolean(lecture.r2_key));
  $('#existingUploadStatus').textContent='';
  $('#transcriptState').textContent=transcript.length?`${transcript.length} timed lines`:'Waiting for transcription';
  $('#transcriptInfo').textContent=transcript.length?`${transcript.length} timestamped subtitle segments, ${formatMs(transcript.at(-1).end_ms)} transcript timeline.`:'Timed captions will appear once you start transcription and the processor finishes.';
  renderAutomationStatus(lecture, state.bundle.automation, transcript.length);
  $('#transcriptInput').value='';
  $('#studioClips').innerHTML=clips.length?clips.map((clip,i)=>`<article class="clip-tile"><div class="clip-heading"><span class="clip-number">CLIP ${String(i+1).padStart(2,'0')}</span><span class="pill ${html(clip.status)}">${html(clip.status.replace('_',' '))}</span></div><h3>${html(clip.title)}</h3><div class="clip-meta">${formatMs(clip.start_ms)} – ${formatMs(clip.end_ms)} · ${Math.round((clip.end_ms-clip.start_ms)/1000)} sec</div><div class="clip-meta" style="margin-top:7px">Suggested score ${clip.score}/100</div><div class="clip-actions"><button class="link-button" data-previewclip="${html(clip.id)}">▶ Preview</button><button class="link-button" data-view="review">Review →</button></div></article>`).join(''):'<div class="empty-state">Upload your lecture: automatic highlight suggestions will appear here after transcription.</div>';
}
async function importTranscript(){
  if(!state.bundle)return toast('Choose a lecture first',true);
  const text=$('#transcriptInput').value.trim();if(!text)return toast('Paste or choose a timed subtitle file first',true);
  if(state.bundle.clips.length&&!confirm('Replacing subtitles will remove existing candidate clips and approvals. Continue?'))return;
  const btn=$('#importTranscript');btn.disabled=true;btn.textContent='Importing…';
  try{const res=await api(`/lectures/${state.bundle.lecture.id}/transcript`,{method:'POST',body:JSON.stringify({text})});await loadLecture(state.bundle.lecture.id);await reload();toast(`Imported ${res.count} timed subtitle segments.`);}
  catch(e){toast(e.message,true)}finally{btn.disabled=false;btn.textContent='Save timed transcript';}
}
async function generate(){
  if(!state.bundle)return toast('Select a lecture',true);
  if(state.bundle.clips.length&&!confirm('Regenerating will remove existing highlights and any approvals. Continue?'))return;
  const btn=$('#generateHighlights');btn.disabled=true;btn.textContent='Analysing transcript…';
  try{
    const r=await api(`/lectures/${state.bundle.lecture.id}/highlights`,{method:'POST',body:'{}'});
    $('#highlightMode').textContent=`Generated ${r.count} suggested clips with ${r.mode==='ai'?'AI-assisted':'rule-based'} ranking. All require review.${r.warning?' '+r.warning:''}`;
    await loadLecture(state.bundle.lecture.id);await reload();toast(`${r.count} suggestions ready for review.`);
  }catch(e){toast(e.message,true)}finally{btn.disabled=false;btn.textContent='✧ Generate highlights';}
}
function previewClip(id){if(!state.bundle)return;const clip=state.bundle.clips.find(c=>c.id===id);if(!clip)return;const video=$('#videoPreview');if(!video.src)return toast('Upload the source video to preview clips.',true);video.currentTime=clip.start_ms/1000;video.play().catch(()=>{});const stop=()=>{if(video.currentTime>=clip.end_ms/1000){video.pause();video.removeEventListener('timeupdate',stop)}};video.addEventListener('timeupdate',stop);window.scrollTo({top:200,behavior:'smooth'});}
function renderReview(){
  const items=state.clips||[];
  $('#reviewRows').innerHTML=items.length?items.map(c=>{
    const job=state.reels[c.id];
    const approved=c.status==='approved';
    const running=job&&['queued','rendering','uploading'].includes(job.status);
    const done=job&&job.status==='complete';
    const reelStatus=job?`<div class="reel-job-status" role="status"><strong>MP4: ${html(job.status)}</strong> · ${job.progress_pct||0}% ${job.error_message?`<span class="danger-text">${html(job.error_message)}</span>`:''}${running?`<div class="reel-progress"><div style="width:${Math.min(100,Math.max(0,Number(job.progress_pct)||0))}%"></div></div>`:''}</div>`:'';
    const exportPanel=approved?`<div class="reel-production"><h4>Produce social-ready Reel</h4><p class="hint">Export 9:16 H.264 MP4 with burned-in subtitles, speaker name and your mosque branding. No music is added.</p><div class="reel-settings"><div class="reel-logo-note"><strong>Official masjid logo</strong><small>Uses the logo uploaded in Publishing. The mosque-name text will not appear on the finished Reel. Upload a transparent PNG for best results. The final five seconds display the YouTube channel @AttowfiqmasjidBolton.</small></div><label>Video framing<select class="reel-crop"><option value="centre" ${!job||job.crop_mode==='centre'?'selected':''}>Centre crop (9:16)</option><option value="left" ${job?.crop_mode==='left'?'selected':''}>Crop left</option><option value="right" ${job?.crop_mode==='right'?'selected':''}>Crop right</option><option value="blur" ${job?.crop_mode==='blur'?'selected':''}>Fit full video + blurred background</option></select></label><label>Subtitle style<select class="reel-captions"><option value="classic" ${!job||job.caption_style==='classic'?'selected':''}>Classic white + dark outline</option><option value="bold" ${job?.caption_style==='bold'?'selected':''}>Bold large captions</option></select></label></div>${reelStatus}<div class="reel-buttons"><button class="btn primary" data-renderclip="${html(c.id)}" ${running?'disabled':''}>${done?'↻ Re-render MP4':'▶ Generate MP4 Reel'}</button>${running?`<button class="btn secondary" data-stopreel="${html(c.id)}">■ Stop export</button>`:''}${done?`<a class="btn secondary" href="/api/reels/${html(c.id)}/file?download=1" download>↓ Download MP4</a>`:''}</div>${done?`<video class="finished-reel" controls preload="none" playsinline src="/api/reels/${html(c.id)}/file" aria-label="Rendered reel preview"></video>`:''}</div>`:'';
    return `<article class="panel review-card" data-reviewid="${html(c.id)}"><div class="section-heading"><span class="soft-badge">${formatMs(c.start_ms)} – ${formatMs(c.end_ms)}</span><span class="pill ${html(c.status)}">${html(c.status.replace('_',' '))}</span></div><label>Clip title<input type="text" class="review-title" value="${html(c.title)}" maxlength="100"></label><p class="review-source">From: <strong>${html(c.lecture_title)}</strong> · ${html(c.speaker)}</p><div class="review-metadata"><span class="pill">${Math.round((c.end_ms-c.start_ms)/1000)} seconds</span><span class="pill">Suggestion score: ${c.score}/100</span></div><p class="hint">${html(c.rationale)}</p><div class="check-group"><label class="checkline"><input class="check-context" type="checkbox" ${c.check_context?'checked':''}> The full lecture confirms the intended meaning and context.</label><label class="checkline"><input class="check-quotes" type="checkbox" ${c.check_quotes?'checked':''}> Qur’anic verses, hadith and religious claims have been checked.</label><label class="checkline"><input class="check-captions" type="checkbox" ${c.check_captions?'checked':''}> Captions, Arabic text and speaker attribution are accurate.</label><label class="checkline"><input class="check-rights" type="checkbox" ${c.check_rights?'checked':''}> Reuse rights and permissions are confirmed.</label></div><label class="hint" for="notes-${html(c.id)}">Editorial notes</label><textarea id="notes-${html(c.id)}" class="review-notes" placeholder="Any corrections or concerns…">${html(c.reviewer_notes||'')}</textarea><div class="review-actions"><button class="btn secondary" data-reviewaction="needs_review">Save review</button><button class="btn secondary" data-reviewaction="rejected">Reject</button><button class="btn primary" data-reviewaction="approved">Approve ✓</button></div>${exportPanel}</article>`;
  }).join(''):'<div class="empty-state panel">No clips yet. Generate highlights in the Clip studio.</div>';
}
function renderReelExports(){
  const done=state.clips.filter(c=>state.reels[c.id]?.status==='complete' && c.status==='approved');
  const outstanding=state.clips.filter(c=>c.status==='approved' && !['complete','rendering','uploading','queued'].includes(state.reels[c.id]?.status));
  $('#reelReadyCount').textContent=`${done.length} MP4 ready · ${outstanding.length} approved awaiting render`;
  $('#reelDownloads').innerHTML=done.length?done.map(c=>`<div class="reel-download-row"><div><strong>${html(c.title)}</strong><small>${html(c.speaker)} · ${Math.round((c.end_ms-c.start_ms)/1000)} seconds · ${fmtBytes(state.reels[c.id]?.output_size)}</small></div><a class="btn secondary" href="/api/reels/${html(c.id)}/file?download=1" download>↓ Download MP4</a></div>`).join(''):'<div class="empty-state">Approved and rendered Reels will appear here, ready for download.</div>';
}
async function renderOne(id,card){
  if(!card)return;
  const job=state.reels[id];
  const force=job?.status==='complete';
  if(force&&!confirm('Re-render this approved clip with the selected settings? The prior download will be replaced.'))return;
  const payload={brand_name:'Masjid At-Towfiq | Bolton',crop_mode:card.querySelector('.reel-crop').value,caption_style:card.querySelector('.reel-captions').value,force};
  try{await api(`/reels/${id}/render`,{method:'POST',body:JSON.stringify(payload)});await reload();toast('Reel queued. The Python processor will create and upload your subtitled MP4.');}
  catch(e){toast(e.message,true)}
}
async function stopReel(id){
  try{await api(`/reels/${id}/stop`,{method:'POST',body:'{}'});await reload();toast('Reel export stopped. You can start it again.');}
  catch(e){toast(e.message,true)}
}
async function renderAllApproved(){
  const ready=state.clips.filter(c=>c.status==='approved'&&!['queued','rendering','uploading','complete'].includes(state.reels[c.id]?.status));
  if(!ready.length)return toast('No approved clips waiting to be rendered.',true);
  if(!confirm(`Queue ${ready.length} approved clips for rendering using the Masjid At-Towfiq styling?`))return;
  let success=0;
  for(const c of ready){
    try{await api(`/reels/${c.id}/render`,{method:'POST',body:JSON.stringify({brand_name:'Masjid At-Towfiq | Bolton',crop_mode:'centre',caption_style:'classic'})});success++;}
    catch(e){toast(`Could not queue ${c.title}: ${e.message}`,true)}
  }
  await reload();toast(`Queued ${success} approved Reels. The processor will create them sequentially.`);
}
async function saveReview(id,status){
  const card=$$('[data-reviewid]').find(el=>el.dataset.reviewid===id);if(!card)return;
  const values={title:card.querySelector('.review-title').value,reviewer_notes:card.querySelector('.review-notes').value,status,
    check_context:card.querySelector('.check-context').checked,check_quotes:card.querySelector('.check-quotes').checked,
    check_captions:card.querySelector('.check-captions').checked,check_rights:card.querySelector('.check-rights').checked};
  try{await api(`/clips/${id}`,{method:'PATCH',body:JSON.stringify(values)});await reload();toast(status==='approved'?'Clip approved and ready for export.':'Review saved.');}catch(e){toast(e.message,true)}
}
async function exportPlans(){
  const approved=state.clips.filter(c=>c.status==='approved');if(!approved.length)return toast('Approve at least one clip before exporting.',true);
  const ids=[...new Set(approved.map(c=>c.lecture_id))];
  const bundles=await Promise.all(ids.map(id=>api(`/lectures/${id}`)));
  const clips=[];
  for(const bundle of bundles){
    for(const c of bundle.clips.filter(c=>c.status==='approved')){
      clips.push({id:c.id,lecture_id:c.lecture_id,lecture_title:bundle.lecture.title,speaker:bundle.lecture.speaker,title:c.title,start_ms:c.start_ms,end_ms:c.end_ms,source_filename:bundle.lecture.source_filename,subtitle_segments:bundle.transcript.filter(s=>s.end_ms>c.start_ms && s.start_ms<c.end_ms)});
    }
  }
  const blob=new Blob([JSON.stringify({project:'Khutbah Clips Studio',generated_at:new Date().toISOString(),clips},null,2)],{type:'application/json'});
  const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download='khutbah-approved-edit-plans.json';a.click();URL.revokeObjectURL(href);toast(`Exported ${clips.length} approved clip editing plans.`);
}
document.addEventListener('click',async e=>{
  const view=e.target.closest('[data-view]');if(view){switchView(view.dataset.view);return;}
  const open=e.target.closest('[data-openlecture]');if(open){await openLecture(open.dataset.openlecture);return;}
  const preview=e.target.closest('[data-previewclip]');if(preview){previewClip(preview.dataset.previewclip);return;}
  const review=e.target.closest('[data-reviewaction]');if(review){const card=review.closest('[data-reviewid]');await saveReview(card.dataset.reviewid,review.dataset.reviewaction);return;}
  const render=e.target.closest('[data-renderclip]');if(render){await renderOne(render.dataset.renderclip,render.closest('[data-reviewid]'));return;}
  const stop=e.target.closest('[data-stopreel]');if(stop){await stopReel(stop.dataset.stopreel);return;}
});
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';try{await api('/login',{method:'POST',body:JSON.stringify({token:$('#adminKey').value})});$('#adminKey').value='';await loadSession();}catch(err){$('#loginError').textContent=err.message;}});
$('#logoutBtn').addEventListener('click',async()=>{await api('/logout',{method:'POST',body:'{}'});await loadSession();});
['#newFromDash','#newFromWelcome','#newFromLibrary','#studioNew'].forEach(id=>$(id).addEventListener('click',showModal));
$('#closeModal').addEventListener('click',hideModal);
$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')hideModal();});
$('#lectureForm').addEventListener('submit',createLecture);
$('#lectureSelect').addEventListener('change',e=>loadLecture(e.target.value));
$('#existingLectureFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file||!state.bundle)return;const id=state.bundle.lecture.id;
  $('#existingUploadLabel').classList.add('hidden');
  try{const init=await api(`/lectures/${id}/upload/init`,{method:'POST',body:JSON.stringify({filename:file.name,size:file.size,mime:file.type||'video/mp4'})});
    const count=Math.ceil(file.size/init.chunkSize);
    for(let i=0;i<count;i++){
      const chunk=file.slice(i*init.chunkSize,Math.min(file.size,(i+1)*init.chunkSize));
      let done=false;for(let attempt=0;attempt<3&&!done;attempt++){
        try{const r=await fetch(`/api/lectures/${id}/upload/parts/${i+1}`,{method:'PUT',body:chunk});const d=await r.json();if(!r.ok)throw Error(d.error||'Upload failed');done=true;}
        catch(err){if(attempt===2)throw err;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
      }
      $('#existingUploadStatus').textContent=`Uploading ${file.name}: ${Math.round((i+1)/count*100)}%`;}
    await api(`/lectures/${id}/upload/complete`,{method:'POST',body:'{}'});await reload();await loadLecture(id);toast('Video uploaded. Select Start transcription whenever you are ready.');
  }catch(err){toast(err.message,true);$('#existingUploadStatus').textContent='Upload interrupted. Please create a fresh lecture to retry.';}
});
$('#subtitleFile').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;$('#transcriptInput').value=await file.text();toast(`Loaded ${file.name} into the transcript editor.`);});
$('#importTranscript').addEventListener('click',importTranscript);
$('#generateHighlights').addEventListener('click',generate);
$('#exportPlans').addEventListener('click',exportPlans);
$('#renderAllApproved').addEventListener('click',renderAllApproved);
loadSession();

// Processing is opt-in per lecture. Poll only running jobs so cancelled work is not restarted.
let autoPollBusy=false;
setInterval(async()=>{
  if(autoPollBusy || state.view!=='studio' || !state.bundle || state.busy) return;
  const id=state.bundle.lecture.id;
  const oldJob=state.bundle.automation;
  if(!oldJob || !['queued','processing'].includes(oldJob.status))return;
  autoPollBusy=true;
  try{
    const next=await api(`/lectures/${id}`);
    if(state.bundle?.lecture.id!==id)return;
    const changed=JSON.stringify(next.automation)!==JSON.stringify(oldJob);
    if(changed && ['complete','failed','cancelled'].includes(next.automation?.status)){
      state.bundle=next;renderStudio();await reload();
    }else{
      state.bundle.automation=next.automation;
      renderAutomationStatus(next.lecture,next.automation,next.transcript.length);
    }
  }catch(e){console.warn('Transcription status polling:',e.message);}finally{autoPollBusy=false;}
},8000);
$('#startTranscription').addEventListener('click',async()=>{
  if(!state.bundle)return;
  const id=state.bundle.lecture.id;
  if((state.bundle.clips.length || state.bundle.transcript.length) && !confirm('Restarting transcription will replace existing timed subtitles and any unapproved highlight suggestions. Continue?'))return;
  try{
    await api(`/automation/jobs/${id}/start`,{method:'POST',body:'{}'});
    await loadLecture(id);
    toast('Transcription queued for this lecture only. Ensure the Python processor is running.');
  }catch(e){toast(e.message,true)}
});
$('#stopTranscription').addEventListener('click',async()=>{
  if(!state.bundle)return;
  const id=state.bundle.lecture.id;
  try{
    await api(`/automation/jobs/${id}/stop`,{method:'POST',body:'{}'});
    await loadLecture(id);
    toast('Transcription stopped/reset. This lecture will not restart until you choose Start.');
  }catch(e){toast(e.message,true)}
});

// Update export states after asynchronous rendering even when transcription is already complete.
let reelPollBusy=false;
setInterval(async()=>{
  if(reelPollBusy||!['review','publishing'].includes(state.view))return;
  if(!Object.values(state.reels).some(r=>['queued','rendering','uploading'].includes(r.status)))return;
  reelPollBusy=true;
  try{await reload();}finally{reelPollBusy=false;}
},5000);

async function loadBranding(){
  try{const status=await api('/branding/status');
    $('#masjidLogoStatus').textContent=status.has_logo?'Mosque logo uploaded. It will be included in new Reel exports.':'Optional: no official logo uploaded yet.';
    $('#masjidLogoPreview').classList.toggle('hidden',!status.has_logo);
    if(status.has_logo)$('#masjidLogoPreview').src=`/api/branding/logo?ts=${Date.now()}`;
  }catch(e){console.warn('Branding status',e.message)}
}
$('#masjidLogoFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  if(file.size>2*1024*1024)return toast('Logo must be below 2 MB',true);
  try{const result=await fetch('/api/branding/logo',{method:'PUT',body:file,headers:{'Content-Type':file.type},credentials:'same-origin'});
    const body=await result.json();if(!result.ok)throw Error(body.error||'Logo upload failed');
    await loadBranding();toast('Logo uploaded. It will appear in new MP4 exports.');
  }catch(err){toast(err.message,true)}
});
