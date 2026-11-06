#!/usr/bin/env python3
"""Khutbah Clips Studio user-controlled transcription processor.

Run alongside `npm run dev` (Wrangler on 127.0.0.1:8787). The processor
transcribes ONLY lectures started explicitly by the user in Clip Studio.

The local process avoids running Whisper or FFmpeg inside Cloudflare Workers.
This release is NOT a cloud-hosted video-processing service.
"""
from __future__ import annotations

import argparse
import json
import queue
import threading
import subprocess
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar
from reel_render import write_ass, make_command, validate_binary, verify_output


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, rem = divmod(milliseconds, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    whole_seconds, ms = divmod(rem, 1000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02},{ms:03}"


def subtitle_blocks(segments):
    """Build SRT without guessing timing or changing the transcribed words."""
    items = []
    for segment in segments:
        text = " ".join(str(segment.text).strip().split())
        if not text:
            continue
        start, end = float(segment.start), float(segment.end)
        if end <= start or start < 0 or end > 86_400:
            continue
        items.append((start, end, text))
        if len(items) > 6000:
            raise ValueError('More than 6000 subtitle segments; split this recording into shorter lectures.')
    return "\n\n".join(f"{i}\n{srt_timestamp(a)} --> {srt_timestamp(b)}\n{t}" for i, (a,b,t) in enumerate(items, 1)), len(items)


class StudioAPI:
    def __init__(self, base_url: str, token: str = ""):
        u = urlsplit(base_url)
        if u.scheme != 'http' or u.hostname not in ('localhost', '127.0.0.1'):
            raise ValueError('For this release --base-url must be a local http://localhost or http://127.0.0.1 address')
        self.base = base_url.rstrip('/')
        self.token = token
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        if token:
            self.request('POST', '/api/login', {'token':token})

    def request(self, method: str, path: str, body=None, run_id: str | None = None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        req = Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        if run_id:
            req.add_header('X-Khutbah-Run-Id',run_id)
        try:
            with self.opener.open(req, timeout=90) as response:
                return json.load(response)
        except HTTPError as exc:
            msg = f'HTTP {exc.code}'
            try:
                details = json.loads(exc.read().decode('utf-8'))
                msg = str(details.get('error', msg))
            except (UnicodeError, ValueError):
                pass
            raise RuntimeError(f'{method} {path}: {msg}') from exc

    def download_video(self, lecture_id: str, destination: Path):
        req = Request(self.base + f'/api/lectures/{lecture_id}/video')
        with self.opener.open(req, timeout=120) as response, destination.open('wb') as output:
            shutil.copyfileobj(response, output, length=1024*1024)
        if destination.stat().st_size < 1024:
            raise RuntimeError('Downloaded video file is unexpectedly small')

    def download_logo(self,directory:Path):
        req=Request(self.base+'/api/branding/logo')
        try:
            with self.opener.open(req,timeout=30) as response:
                mime=response.headers.get('Content-Type','image/png').split(';')[0]
                ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}.get(mime)
                if not ext:raise RuntimeError('Unsupported mosque logo type')
                destination=directory/f'masjid-logo{ext}'
                with destination.open('wb') as output:
                    shutil.copyfileobj(response,output)
            if destination.stat().st_size>2*1024*1024:raise RuntimeError('Mosque logo is unexpectedly large')
            return destination
        except HTTPError as exc:
            if exc.code==404:return None
            raise

    def reel_request(self, method, clip_id, action, body=None, run_id=None):
        return self.request(method,f'/api/automation/renders/{clip_id}/{action}',body,run_id=run_id)

    def upload_reel(self, clip_id: str, run_id: str, file: Path):
        initial=self.reel_request('POST',clip_id,'upload-init',{'size':file.stat().st_size},run_id)
        chunk_size=int(initial['chunkSize'])
        total=(file.stat().st_size+chunk_size-1)//chunk_size
        with file.open('rb') as input_file:
            for part in range(1,total+1):
                ensure_reel_active(self,clip_id,run_id)
                data=input_file.read(chunk_size)
                req=Request(self.base+f'/api/automation/renders/{clip_id}/upload-part?part={part}',data=data,method='POST')
                req.add_header('Content-Type','application/octet-stream')
                req.add_header('Content-Length',str(len(data)))
                req.add_header('X-Khutbah-Run-Id',run_id)
                with self.opener.open(req,timeout=180) as response:
                    answer=json.load(response)
                    if not answer.get('ok'):
                        raise RuntimeError('Uploading MP4 failed')
                print(f'    Uploading Reel part {part}/{total}',flush=True)
        return self.reel_request('POST',clip_id,'upload-complete',{},run_id)

    def queue(self):
        return self.request('GET', '/api/automation/queue').get('items', [])

    def job(self, lecture_id: str, action: str, data=None, run_id=None):
        if action == 'status':
            return self.request('GET', f'/api/automation/jobs/{lecture_id}/status')
        payload=dict(data or {})
        if run_id and action in ('progress','finish'):
            payload['run_id']=run_id
        return self.request('POST', f'/api/automation/jobs/{lecture_id}/{action}', payload)


class JobCancelled(Exception):
    """User cancelled a job or a newer run superseded this one."""


def ensure_active(api: StudioAPI, lecture_id: str, run_id: str):
    current=api.job(lecture_id,'status')
    if current.get('status')!='processing' or current.get('run_id')!=run_id:
        raise JobCancelled('Job stopped in Clip Studio')


def perform_job(api: StudioAPI, job: dict, model, language: str | None, run_id: str, beam_size: int):
    lecture_id = job['lecture_id']
    original_name = Path(job.get('source_filename') or 'lecture.mp4').name
    extension = original_name.rsplit('.',1)[-1].lower() if '.' in original_name else 'mp4'
    extension = extension if extension in {'mp4','mov','m4v','mp3','wav','webm','mkv','m4a','aac','ogg','flac'} else 'mp4'
    print(f"Processing lecture: {job.get('title', lecture_id)}", flush=True)
    with tempfile.TemporaryDirectory(prefix='khutbah-auto-') as temporary:
        source = Path(temporary) / f'source.{extension}'
        ensure_active(api,lecture_id,run_id)
        api.job(lecture_id,'progress',{'stage':'downloading'},run_id=run_id)
        api.download_video(lecture_id, source)
        print(f'  Downloaded {source.stat().st_size / 1024**2:.1f} MiB; transcribing locally…', flush=True)
        ensure_active(api,lecture_id,run_id)
        api.job(lecture_id,'progress',{'stage':'transcribing'},run_id=run_id)
        found, info = model.transcribe(str(source), beam_size=beam_size, vad_filter=True, language=language)
        duration_seconds = max(0.0, float(info.duration))
        print(f"  Lecture duration: {srt_timestamp(duration_seconds)}; beam size {beam_size}; monitoring original-audio progress.", flush=True)
        api.job(lecture_id,'progress',{'stage':'transcribing','duration_seconds':duration_seconds,'progress_seconds':0,'segment_count':0},run_id=run_id)
        gathered = []
        last_report = time.monotonic()
        progress_seconds = 0.0
        for seg in found:
            gathered.append(seg)
            progress_seconds = max(progress_seconds, float(seg.end))
            if (len(gathered) % 8 == 0 or time.monotonic() - last_report > 8):
                ensure_active(api,lecture_id,run_id)
                api.job(lecture_id,'progress',{'stage':'transcribing','segment_count':len(gathered),'progress_seconds':min(progress_seconds,duration_seconds)},run_id=run_id)
                last_report = time.monotonic()
                pct = (min(progress_seconds,duration_seconds) / duration_seconds * 100) if duration_seconds else 0
                print(f'  {pct:.1f}% of audio timeline; {len(gathered)} subtitle segments; {srt_timestamp(progress_seconds)} / {srt_timestamp(duration_seconds)}', flush=True)
        srt, count = subtitle_blocks(gathered)
        if count < 4:
            raise RuntimeError('Only a few timed segments were detected. Check that the lecture audio contains intelligible speech.')
        print(f'  Detected language: {info.language}. {count} segments. Saving and ranking…',flush=True)
        ensure_active(api,lecture_id,run_id)
        api.job(lecture_id,'progress',{'stage':'saving_subtitles','segment_count':count,'progress_seconds':duration_seconds},run_id=run_id)
        api.request('POST',f'/api/lectures/{lecture_id}/transcript',{'text':srt},run_id=run_id)
        ensure_active(api,lecture_id,run_id)
        api.job(lecture_id,'progress',{'stage':'selecting_highlights','segment_count':count},run_id=run_id)
        result=api.request('POST',f'/api/lectures/{lecture_id}/highlights',{},run_id=run_id)
        if not result.get('count'):
            raise RuntimeError('No suitable highlights generated. Check the transcript and try again.')
        api.job(lecture_id,'finish',{'ok':True},run_id=run_id)
        print(f"  Finished: {count} subtitle segments, {result['count']} candidate clips. Review in the dashboard.",flush=True)


def ensure_reel_active(api: StudioAPI,clip_id:str,run_id:str):
    job=api.reel_request('GET',clip_id,'status',run_id=run_id)
    if job.get('run_id')!=run_id or job.get('status') not in ('rendering','uploading'):
        raise JobCancelled('Reel rendering stopped in studio')


def _ffmpeg_reel(source:Path,out:Path,recipe:dict,subtitle:Path,logo:Path|None,api:StudioAPI,clip_id:str,run_id:str):
    duration=(int(recipe['clip']['end_ms'])-int(recipe['clip']['start_ms']))/1000
    command=make_command(source,out,recipe,logo)
    lines=queue.Queue()
    with (out.parent/'ffmpeg-reel.log').open('w',encoding='utf-8') as log:
        p=subprocess.Popen(command,cwd=str(subtitle.parent),stdout=subprocess.PIPE,
                           stderr=log,text=True,bufsize=1,encoding='utf-8',errors='replace')
        def reader():
            assert p.stdout is not None
            for line in p.stdout:
                lines.put(line.strip())
        thread=threading.Thread(target=reader,daemon=True);thread.start()
        last_report=0.0
        pct=7
        try:
            while p.poll() is None or not lines.empty():
                try: line=lines.get(timeout=1.5)
                except queue.Empty: line=''
                if line.startswith(('out_time_ms=','out_time_us=')):
                    try:
                        microseconds=float(line.split('=',1)[1])
                        pct=min(88,max(pct,7+int(81*(microseconds/1e6)/duration)))
                    except (ValueError,ZeroDivisionError): pass
                if time.monotonic()-last_report>=3.0:
                    ensure_reel_active(api,clip_id,run_id)
                    api.reel_request('POST',clip_id,'progress',{'stage':'rendering','progress_pct':pct},run_id)
                    print(f'    Render {pct}% complete',flush=True)
                    last_report=time.monotonic()
            code=p.wait()
            if code!=0:
                log.flush()
                tail=(out.parent/'ffmpeg-reel.log').read_text(encoding='utf-8',errors='replace').splitlines()[-6:]
                print('\n'.join(tail),file=sys.stderr,flush=True)
                raise RuntimeError(f'FFmpeg exited with status {code}. Check the processor terminal for details.')
        finally:
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=8)
                except subprocess.TimeoutExpired:p.kill();p.wait(timeout=8)
            thread.join(timeout=2)


def process_reel_job(api:StudioAPI,job:dict,cache_root:Path):
    clip_id=job['clip_id']
    claim=api.reel_request('POST',clip_id,'claim',{})
    run_id=claim['run_id']
    print(f"Creating 9:16 Reel: {job.get('title',clip_id)}",flush=True)
    try:
        validate_binary()
        recipe=api.reel_request('GET',clip_id,'recipe',run_id=run_id)
        lecture_id=recipe['clip']['lecture_id']
        expected=int(recipe['clip'].get('source_size') or 0)
        filename=Path(recipe['clip'].get('source_filename') or 'lecture.mp4').name
        ext=filename.rsplit('.',1)[-1].lower() if '.' in filename else 'mp4'
        ext=ext if ext in {'mp4','mov','m4v','webm','mkv'} else 'mp4'
        cache_root.mkdir(parents=True,exist_ok=True)
        media=cache_root/f'{lecture_id}.{ext}'
        if not media.exists() or (expected and media.stat().st_size!=expected):
            temp=cache_root/f'{lecture_id}.part'
            if temp.exists():temp.unlink()
            api.reel_request('POST',clip_id,'progress',{'stage':'downloading','progress_pct':2},run_id)
            api.download_video(lecture_id,temp)
            if expected and temp.stat().st_size!=expected:
                temp.unlink(missing_ok=True)
                raise RuntimeError('Downloaded source video size does not match original upload')
            temp.replace(media)
        ensure_reel_active(api,clip_id,run_id)
        with tempfile.TemporaryDirectory(prefix='khutbah-reel-') as folder:
            folder=Path(folder)
            sub=folder/'captions.ass'
            count=write_ass(sub,recipe)
            out=folder/f'{clip_id}.mp4'
            print(f'    Preparing {count} caption cues, crop: {recipe["options"].get("crop_mode")}',flush=True)
            api.reel_request('POST',clip_id,'progress',{'stage':'rendering','progress_pct':7},run_id)
            # No logo asset is used unless the owner has uploaded an authorised image.
            logo=api.download_logo(folder)
            _ffmpeg_reel(media,out,recipe,sub,logo,api,clip_id,run_id)
            verify_output(out)
            ensure_reel_active(api,clip_id,run_id)
            api.reel_request('POST',clip_id,'progress',{'stage':'uploading','progress_pct':90},run_id)
            api.upload_reel(clip_id,run_id,out)
        print(f'    Reel ready: {clip_id}. Download in the Approval Queue.',flush=True)
    except JobCancelled:
        print(f'    User stopped Reel {clip_id}',flush=True)
    except Exception as exc:
        print(f'    Reel export failed: {exc}',file=sys.stderr,flush=True)
        try:api.reel_request('POST',clip_id,'finish',{'error':str(exc)[:280]},run_id)
        except RuntimeError:pass


def main():
    parser = argparse.ArgumentParser(description='Transcribe ONLY lectures explicitly started in the dashboard.')
    parser.add_argument('--base-url', default='http://127.0.0.1:8787')
    parser.add_argument('--model', default='small', help='Local faster-whisper model: small (default), medium, large-v3, etc.')
    parser.add_argument('--language', default=None, help='Optional language code en or ar; default autodetect (best for mixed-language lectures)')
    parser.add_argument('--beam-size', type=int, default=5, help='Decoder beam size. 1 is faster, 5 (default) is usually more accurate.')
    parser.add_argument('--cpu-threads', type=int, default=0, help='CPU threads for CTranslate2. 0 lets the library decide.')
    parser.add_argument('--device', choices=('cpu','cuda'), default='cpu')
    parser.add_argument('--interval', type=float, default=8, help='Seconds between queue checks')
    parser.add_argument('--once', action='store_true', help='Process currently queued jobs then exit')
    parser.add_argument('--render-only',action='store_true',help='Only process approved Reel exports; do not initialise Whisper')
    parser.add_argument('--cache-dir',type=Path,default=Path('.khutbah-media-cache'),help='Local temporary media cache; do not commit it to GitHub')
    args = parser.parse_args()
    if args.interval < 2:
        parser.error('--interval must be at least 2 seconds')
    if not 1 <= args.beam_size <= 10:
        parser.error('--beam-size must be between 1 and 10')
    if not 0 <= args.cpu_threads <= 128:
        parser.error('--cpu-threads must be between 0 and 128')
    if not args.render_only:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            sys.exit('Missing faster-whisper. Run: python -m pip install -r tools/requirements-automation.txt')
    token = os.environ.get('KHUTBAH_ADMIN_TOKEN','')
    print('Starting local automatic lecture processor…', flush=True)
    print(f'Whisper model: {args.model}; device: {args.device}; language: {args.language or "automatic"}; beam: {args.beam_size}; CPU threads: {args.cpu_threads or "auto"}',flush=True)
    api=StudioAPI(args.base_url,token=token)
    compute_type='int8' if args.device=='cpu' else 'float16'
    model=None
    while True:
        try:
            jobs=[] if args.render_only else api.queue()
            if jobs:
                if model is None:
                    print('Loading speech-recognition model (first run may download model weights)…',flush=True)
                    model=WhisperModel(args.model,device=args.device,compute_type=compute_type,cpu_threads=args.cpu_threads)
                for job in jobs:
                    lecture_id=job['lecture_id']
                    try:
                        claim=api.job(lecture_id,'claim')
                        run_id=claim['run_id']
                    except RuntimeError as exc:
                        print(f'Skipping unavailable job: {exc}',flush=True)
                        continue
                    try:
                        perform_job(api,job,model,args.language,run_id,args.beam_size)
                    except JobCancelled:
                        print(f'  Lecture {lecture_id} stopped by user.',flush=True)
                    except Exception as exc:
                        print(f'Processing failed for {lecture_id}: {exc}',file=sys.stderr,flush=True)
                        traceback.print_exc()
                        try:
                            # No secrets, raw transcription or traceback in the dashboard.
                            api.job(lecture_id,'finish',{'ok':False,'error':str(exc)[:320]},run_id=run_id)
                        except Exception as report_error:
                            print(f'Could not report job failure: {report_error}',file=sys.stderr,flush=True)
            reel_jobs=api.request('GET','/api/automation/renders/queue').get('items',[])
            for render in reel_jobs:
                process_reel_job(api,render,args.cache_dir)
            if args.once:
                print('Queue scan completed.', flush=True)
                break
        except (URLError, OSError, RuntimeError, ValueError) as exc:
            print(f'Processor connection error: {exc}. Check that npm run dev is running.',file=sys.stderr,flush=True)
            if args.once:
                sys.exit(1)
        time.sleep(args.interval)

if __name__=='__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nProcessor stopped.')
