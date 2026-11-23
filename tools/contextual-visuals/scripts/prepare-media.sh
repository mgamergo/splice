#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p media
if [[ -f media/interview.mp4 ]]; then
  exit 0
fi
if [[ -z ${1:-} ]]; then
  if [[ ! -s media/original.webm ]]; then
    curl -fsSL --retry 2 --max-time 150 \
      -A 'SplicePrototype/1.0 (editing evaluation)' \
      'https://upload.wikimedia.org/wikipedia/commons/f/f6/Interview_with_Jimmy_Wales_at_Wikimania_2025_Nairobi.webm' \
      -o media/original.webm.tmp
    mv media/original.webm.tmp media/original.webm
  fi
fi
ffmpeg -nostdin -hide_banner -loglevel error -y -ss 24.36 -i "${1:-media/original.webm}" -t 72 \
  -vf 'scale=768:432,fps=24,setsar=1' -c:v libx264 -pix_fmt yuv420p -crf 22 -threads 2 \
  -c:a aac -b:a 96k -movflags +faststart \
  -metadata 'comment=Excerpt of Interview with Jimmy Wales at Wikimania 2025 Nairobi by DelwarHossain and Rocky; CC BY 4.0: https://creativecommons.org/licenses/by/4.0/' \
  media/interview.tmp.mp4
mv media/interview.tmp.mp4 media/interview.mp4
