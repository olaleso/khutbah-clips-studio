#!/usr/bin/env python3
"""Render approved Khutbah Clips Studio editing plans as vertical MP4s.

No Python packages required. Install FFmpeg with libass enabled and ensure ffmpeg is on PATH.
The generated plans do NOT contain the original media; use your authorised source file.

python tools/render.py --source "C:\\Videos\\khutbah.mp4" --plan khutbah-approved-edit-plans.json --brand "Your Masjid Name"
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from textwrap import wrap


def ass_stamp(seconds):
    centis = max(0, round(seconds * 100))
    hrs, centis = divmod(centis, 360000)
    mins, centis = divmod(centis, 6000)
    secs, cs = divmod(centis, 100)
    return f'{hrs}:{mins:02}:{secs:02}.{cs:02}'


def ass_escape(text):
    return (str(text).replace('\\', ' ').replace('{', '(').replace('}', ')')
            .replace('\n', ' ').strip())


def write_ass(filepath, clip, brand):
    # ASS provides crisp legible captions and an original speaker/brand header.
    header = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00162D29,&H800D1714,1,0,0,0,100,100,0,0,1,3,1,2,70,70,245,1
Style: Title,Arial,49,&H00F7D9A1,&H00F7D9A1,&H00162D29,&H800D1714,1,0,0,0,100,100,0,0,1,3,1,8,70,70,160,1
Style: Brand,Arial,38,&H00F7E8CA,&H00F7E8CA,&H00162D29,&H800D1714,1,0,0,0,100,100,0,0,1,2,55,55,55,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    duration = (clip['end_ms'] - clip['start_ms']) / 1000
    lines = [header]
    title = ass_escape(clip['title'])[:100]
    title_lines = r'\N'.join(wrap(title, 31, break_long_words=False)[:2])
    lines.append(f'Dialogue: 0,{ass_stamp(0)},{ass_stamp(min(duration,5.5))},Title,,0,0,0,,{title_lines}\n')
    brand_text = ass_escape(brand)[:90]
    if brand_text:
        lines.append(f'Dialogue: 0,{ass_stamp(0)},{ass_stamp(duration)},Brand,,0,0,0,,{brand_text}\n')
    for segment in clip.get('subtitle_segments', []):
        start = max(0.0, (segment['start_ms'] - clip['start_ms']) / 1000)
        end = min(duration, (segment['end_ms'] - clip['start_ms']) / 1000)
        if end <= start:
            continue
        safe = ass_escape(segment['text'])
        parts = wrap(safe, 33, break_long_words=False)
        caption = r'\N'.join(parts[:3])
        lines.append(f'Dialogue: 0,{ass_stamp(start)},{ass_stamp(end)},Caption,,0,0,0,,{caption}\n')
    filepath.write_text(''.join(lines), encoding='utf-8-sig')


def main():
    parser = argparse.ArgumentParser(description='Render approved 9:16 H.264 Khutbah Reels.')
    parser.add_argument('--source', type=Path, required=True, help='Original lecture MP4 or MOV')
    parser.add_argument('--plan', type=Path, required=True, help='Exported JSON plan from the dashboard')
    parser.add_argument('--output', type=Path, default=Path('rendered_reels'))
    parser.add_argument('--brand', default='Khutbah Clips Studio', help='Speaker, masjid or channel branding shown in clip')
    parser.add_argument('--lecture-id', help='Only render this lecture ID; useful for combined plans')
    parser.add_argument('--crf', type=int, default=21, help='H.264 quality factor (lower is higher quality)')
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error(f'Video source not found: {args.source}')
    if shutil.which('ffmpeg') is None:
        sys.exit('FFmpeg not found. Install FFmpeg and add ffmpeg.exe to PATH.')
    plan = json.loads(args.plan.read_text(encoding='utf-8-sig'))
    all_clips = plan.get('clips', [])
    clips = [c for c in all_clips if (args.lecture_id and c.get('lecture_id') == args.lecture_id)
             or (not args.lecture_id and c.get('source_filename') == args.source.name)]
    if not clips:
        sys.exit('No matching clips. Use the original uploaded filename, or pass --lecture-id from the JSON plan.')
    lecture_ids = {c['lecture_id'] for c in clips}
    if len(lecture_ids) != 1:
        sys.exit('The selected plan contains multiple lectures. Pass --lecture-id to avoid using the wrong source video.')
    args.output.mkdir(parents=True, exist_ok=True)
    for idx, clip in enumerate(clips, 1):
        start = clip['start_ms'] / 1000
        length = (clip['end_ms'] - clip['start_ms']) / 1000
        if not 10 <= length <= 180:
            print(f'Skipping invalid clip duration: {clip["title"]}', file=sys.stderr)
            continue
        name = re.sub(r'[^a-zA-Z0-9_-]+', '-', clip['title']).strip('-')[:55] or clip['id'][:8]
        destination = args.output / f'{idx:02}-{name}.mp4'
        with tempfile.TemporaryDirectory(prefix='ks-render-') as tmp:
            subtitle_path = Path(tmp) / 'captions.ass'
            write_ass(subtitle_path, clip, args.brand)
            # Run with working directory set to the subtitle directory to avoid
            # escaping Windows drive letters and colon characters in filter paths.
            vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,ass=captions.ass'
            cmd = ['ffmpeg', '-hide_banner', '-y', '-ss', f'{start:.3f}', '-i', str(args.source.resolve()),
                   '-t', f'{length:.3f}', '-vf', vf, '-c:v', 'libx264', '-preset', 'medium',
                   '-crf', str(args.crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
                   '-movflags', '+faststart', str(destination.resolve())]
            print(f'[{idx}/{len(clips)}] Rendering {destination.name}', flush=True)
            subprocess.run(cmd, cwd=tmp, check=True)
    print(f'Finished. Files saved under: {args.output.resolve()}')


if __name__ == '__main__':
    main()
