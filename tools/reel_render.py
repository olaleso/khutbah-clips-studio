"""Render an approved Khutbah Clips Studio clip as a social-ready vertical MP4.

Uses the original audio/video only; captions come exclusively from the timestamped
Whisper transcript stored in D1. Requires ffmpeg + ffprobe on PATH, with libass.
"""
from __future__ import annotations
import math
from collections import deque
import re
import shutil
import subprocess
import textwrap
from pathlib import Path


def ass_stamp(sec: float) -> str:
    ticks=max(0,round(sec*100))
    hour,ticks=divmod(ticks,360000)
    minute,ticks=divmod(ticks,6000)
    second,cs=divmod(ticks,100)
    return f'{hour}:{minute:02d}:{second:02d}.{cs:02d}'


def ass_escape(txt: str) -> str:
    # Strip ASS control sequences. Never interpret subtitles as tags/formatting.
    return ' '.join(str(txt).replace('\\',' ').replace('{','(').replace('}',')').split())


def split_caption_words(text: str, max_words=6, max_chars=26):
    words=ass_escape(text).split()
    if not words:return []
    groups=[]
    batch=[]
    for word in words:
        if batch and (len(batch)>=max_words or len(' '.join(batch+[word]))>max_chars):
            groups.append(' '.join(batch));batch=[]
        batch.append(word)
    if batch:groups.append(' '.join(batch))
    return groups


def write_ass(path: Path, recipe: dict) -> int:
    clip=recipe['clip'];options=recipe['options']
    start=float(clip['start_ms'])/1000
    length=(int(clip['end_ms'])-int(clip['start_ms']))/1000
    if not 10<=length<=180:
        raise ValueError('Clips must be between 10 and 180 seconds')
    bold=options.get('caption_style')=='bold'
    fontsize=70 if bold else 64
    capmargin=470 if bold else 470
    header=f'''[Script Info]
Title: Khutbah Clips Studio Reel
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,{fontsize},&H00FFFFFF,&H00FFFFFF,&H001C302C,&H800F1714,1,0,0,0,100,100,0,0,1,4,1,2,95,95,{capmargin},1
Style: Title,Arial,48,&H00DECB93,&H00DECB93,&H00122320,&H800F1714,1,0,0,0,100,100,0,0,1,3,1,8,95,95,190,1
Style: Speaker,Arial,38,&H00FFFFFF,&H00FFFFFF,&H00122320,&H800F1714,0,0,0,0,100,100,0,0,1,3,1,2,85,85,225,1
Style: EndPrompt,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00122320,&H800F1714,1,0,0,0,100,100,0,0,1,5,2,5,75,75,0,1
Style: EndHandle,Arial,56,&H00A1D6F5,&H00A1D6F5,&H00122320,&H800F1714,1,0,0,0,100,100,0,0,1,5,2,5,65,65,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    events=[]
    positions={'Title':(540,235),'Caption':(540,1235),'Speaker':(540,1695),'EndPrompt':(540,335),'EndHandle':(540,415)}
    def append(a,b,style,txt):
        if b>a and txt:
            safe=ass_escape(txt)
            x,y=positions[style]
            placement=r'{\an5\pos('+str(x)+','+str(y)+r')}'
            events.append(f'Dialogue: 0,{ass_stamp(a)},{ass_stamp(b)},{style},,0,0,0,,{placement}{safe}\n')
    title=ass_escape(clip.get('title',''))
    if len(title)>85:title=title[:82]+'…'
    append(0,min(length,4.5),'Title',title)
    speaker=clip.get('speaker') or ''
    if speaker: append(0,length,'Speaker',str(speaker)[:85])
    # Use the authentic uploaded logo instead of typesetting the mosque name.
    # The call-to-action is shown during the final seconds, with no extra
    # runtime, so a 54-second original stays a 54-second Reel.
    outro_start=max(0.0,length-min(5.0,max(3.0,length/5)))
    append(outro_start,length,'EndPrompt','WATCH THE FULL LECTURE ON YOUTUBE')
    append(outro_start,length,'EndHandle','@AttowfiqmasjidBolton')
    cues=0
    for seg in recipe.get('transcript',[]):
        a=max(0.0,float(seg['start_ms'])/1000-start)
        b=min(length,float(seg['end_ms'])/1000-start)
        if b-a<0.04:continue
        parts=split_caption_words(seg.get('text',''))
        if not parts:continue
        total=sum(max(1,len(part)) for part in parts)
        cursor=a
        for index,part in enumerate(parts):
            w=max(1,len(part))
            next_cursor=b if index==len(parts)-1 else cursor+(b-a)*(w/total)
            # Apply exact fractional allocation rather than incrementally weighting remainder.
            end_at=b if index==len(parts)-1 else a+(b-a)*(sum(max(1,len(x)) for x in parts[:index+1])/total)
            if end_at-cursor>=0.04:
                append(cursor,end_at,'Caption',part)
                cues+=1
            cursor=end_at
    if not cues:raise ValueError('No caption segments overlap the clip timestamps')
    path.write_text(header+''.join(events),encoding='utf-8-sig')
    return cues


def filter_graph(crop_mode: str='centre', logo: bool=False)->str:
    mode=crop_mode if crop_mode in ('centre','left','right','blur') else 'centre'
    if mode=='blur':
        vf=("[0:v]split=2[bg][fg];"
            "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[blur];"
            "[fg]scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[main];"
            "[blur][main]overlay=(W-w)/2:(H-h)/2,setsar=1[base]")
    else:
        x={'left':'0','centre':'(in_w-out_w)/2','right':'in_w-out_w'}[mode]
        vf=f'[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x={x}:y=(in_h-out_h)/2,setsar=1[base]'
    if logo:
        vf+=';[1:v]format=rgba,scale=300:200:force_original_aspect_ratio=decrease[logo];[base][logo]overlay=(W-w)/2:1450+(200-h)/2[branded];[branded]ass=captions.ass[v]'
    else:
        vf+=';[base]ass=captions.ass[v]'
    return vf


def prepare_logo(source: Path) -> Path:
    """Prepare an authorised uploaded logo without an opaque solid background.

    Existing alpha is never removed. For JPEG/opaque images, only a nearly
    uniform *edge-connected* background is cleared (conservatively). Complex
    photographic backgrounds are not guessed away: use a transparent PNG.
    This only uses the logo uploaded through the app; no fabricated assets.
    """
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError('Install Pillow in the studio venv: python -m pip install Pillow') from exc
    with Image.open(source) as im:
        rgba=im.convert('RGBA')
    if rgba.width>3000 or rgba.height>3000:
        rgba.thumbnail((3000,3000))
    alphas=rgba.getchannel('A')
    if alphas.getextrema()[0]<255:
        # Image already has transparency: no colour removal needed.
        prepared=source.with_name('masjid-logo-transparent.png')
        rgba.save(prepared)
        return prepared
    w,h=rgba.size
    if w<4 or h<4:
        raise RuntimeError('Uploaded mosque logo is too small')
    pixels=rgba.load()
    corners=[pixels[0,0],pixels[w-1,0],pixels[0,h-1],pixels[w-1,h-1]]
    def color_distance(a,b):
        return max(abs(a[i]-b[i]) for i in range(3))
    if any(color_distance(corners[0],c)>22 for c in corners[1:]):
        raise RuntimeError('The uploaded logo has an opaque/complex background. Please upload a transparent PNG logo from Publishing.')
    bg=tuple(round(sum(c[i] for c in corners)/4) for i in range(3))
    # Ensure the four borders mostly have the same solid background.
    edges=[pixels[x,0] for x in range(0,w,max(1,w//50))]
    edges+= [pixels[x,h-1] for x in range(0,w,max(1,w//50))]
    edges+= [pixels[0,y] for y in range(0,h,max(1,h//50))]
    edges+= [pixels[w-1,y] for y in range(0,h,max(1,h//50))]
    if sum(color_distance(c,bg)<=22 for c in edges)/len(edges)<0.8:
        raise RuntimeError('Logo background is not a uniform colour. Upload a transparent PNG for background-free branding.')
    # Flood-fill from the perimeter: don't remove same-colour detail inside
    # an enclosed part of the official mark.
    visited=bytearray(w*h)
    todo=deque((x,y) for x in range(w) for y in (0,h-1))
    todo.extend((x,y) for y in range(h) for x in (0,w-1))
    while todo:
        x,y=todo.popleft()
        k=y*w+x
        if visited[k]:continue
        visited[k]=1
        c=pixels[x,y]
        distance=color_distance(c,bg)
        if distance>42:continue
        # Antialiasing near the edge of the artwork fades smoothly.
        alpha=0 if distance<=12 else round(255*(distance-12)/30)
        pixels[x,y]=(c[0],c[1],c[2],alpha)
        if x>0 and not visited[k-1]:todo.append((x-1,y))
        if x+1<w and not visited[k+1]:todo.append((x+1,y))
        if y>0 and not visited[k-w]:todo.append((x,y-1))
        if y+1<h and not visited[k+w]:todo.append((x,y+1))
    prepared=source.with_name('masjid-logo-transparent.png')
    rgba.save(prepared)
    return prepared


def make_command(source:Path, destination:Path, recipe:dict, logo:Path|None=None):
    # The video cache is relative to the studio project, while FFmpeg runs in
    # a separate temporary folder (so captions.ass can be loaded by name).
    # Resolve media paths *before* launching FFmpeg with that different cwd.
    # Otherwise .khutbah-media-cache/<lecture>.mp4 cannot be found.
    source=Path(source).expanduser().resolve(strict=True)
    destination=Path(destination).expanduser().resolve()
    if logo is not None and Path(logo).is_file():
        logo=prepare_logo(Path(logo).expanduser().resolve()).resolve(strict=True)
    clip=recipe['clip'];options=recipe['options']
    a=clip['start_ms']/1000
    length=(clip['end_ms']-clip['start_ms'])/1000
    if length<=0:raise ValueError('Invalid clip timestamps')
    cmd=['ffmpeg','-hide_banner','-nostdin','-y','-ss',f'{a:.3f}','-i',str(source)]
    if logo and logo.is_file():cmd+=['-loop','1','-i',str(logo)]
    cmd+=['-t',f'{length:.3f}','-filter_complex',filter_graph(options.get('crop_mode','centre'),bool(logo and logo.is_file())),
          '-map','[v]','-map','0:a:0?','-r','30','-c:v','libx264','-preset','veryfast','-crf','22',
          '-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000',
          '-movflags','+faststart','-max_muxing_queue_size','2048',
          '-progress','pipe:1','-stats_period','1','-nostats',str(destination)]
    return cmd


def validate_binary():
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise RuntimeError('FFmpeg/ffprobe not found on PATH. Install an FFmpeg build with libass.')
    filters=subprocess.run(['ffmpeg','-hide_banner','-filters'],capture_output=True,text=True,check=True).stdout
    if not re.search(r'\s+ass\s+',filters):
        raise RuntimeError('Your FFmpeg build does not support the ass subtitles filter. Install an FFmpeg build with libass.')


def verify_output(file:Path):
    if not file.is_file() or file.stat().st_size<4096:raise RuntimeError('FFmpeg produced no usable MP4')
    r=subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_name,width,height','-select_streams','v:0','-of','json',str(file)],capture_output=True,text=True,check=True)
    import json
    data=json.loads(r.stdout)
    video=(data.get('streams') or [None])[0]
    if not video or video.get('width')!=1080 or video.get('height')!=1920 or video.get('codec_name')!='h264':
        raise RuntimeError('Rendered file did not pass the 1080x1920 H.264 validation')
    return file.stat().st_size
