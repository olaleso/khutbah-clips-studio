#!/usr/bin/env python3
"""Produce a timestamped SRT locally using faster-whisper.

Requires: pip install faster-whisper
Example: python tools/transcribe.py "C:\\Videos\\khutbah.mp4" --model medium
No API key needed. First run downloads the model; CPU transcription may be slow.
"""
import argparse
import sys
from pathlib import Path


def timestamp(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main():
    parser = argparse.ArgumentParser(description='Transcribe an original lecture into SRT for Khutbah Clips Studio.')
    parser.add_argument('source', type=Path, help='Original lecture video or audio file')
    parser.add_argument('--model', default='small', help='Whisper model: small, medium, large-v3, etc.')
    parser.add_argument('--language', default=None, help='Optional two-letter language code (e.g. en or ar)')
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--output', type=Path, default=None)
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error(f'Input file not found: {args.source}')
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit('Install faster-whisper first: python -m pip install faster-whisper')
    compute = 'int8' if args.device == 'cpu' else 'float16'
    model = WhisperModel(args.model, device=args.device, compute_type=compute)
    segments, info = model.transcribe(str(args.source), beam_size=5, language=args.language, vad_filter=True)
    destination = args.output or args.source.with_suffix('.srt')
    count = 0
    with destination.open('w', encoding='utf-8-sig') as out:
        for seg in segments:
            if not seg.text.strip():
                continue
            count += 1
            out.write(f'{count}\n{timestamp(seg.start)} --> {timestamp(seg.end)}\n{seg.text.strip()}\n\n')
            if count % 30 == 0:
                print(f'Processed {count} subtitle segments…', flush=True)
    print(f'Saved {count} subtitle segments to {destination} (language: {info.language})')
    print('Import this SRT into the Clip studio, then generate highlights.')


if __name__ == '__main__':
    main()
