#!/bin/bash
# One take of the real Faultline session, recorded on both sides at once:
#   - scripts/studio.mjs record: the Hermes Desktop workspace (Webapp at :9121) on the Faultline Studio page,
#     screencast into .cache/frames/studio (frames.json + marks in epoch seconds);
#   - scripts/record_pty.py: a real `hermes chat` in a pty, driven by scripts/take_steps.template.json,
#     saved as an asciicast (session.cast) with marks in cast seconds and epoch seconds.
# The two talk through a control file: the terminal steps append `mark`, `still`, `click`, `js` lines that the
# Studio recorder acts on, so both clips carry the same beats.
#   bash scripts/take.sh <take dir>
set -u
TAKE="${1:?take dir}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILM_HOME=/private/tmp/claude-501/-Users-bigmantech001-Faultline/24ea2fa7-aaf2-4fa6-8efe-c0431050eb42/scratchpad/film-home
HERMES=hermes
mkdir -p "$TAKE"
CTL="$TAKE/studio.ctl"
rm -f "$CTL" "$CTL.ready"
sed "s#__CTL__#$CTL#g; s#__TAKE__#$TAKE#g" "$ROOT/scripts/take_steps.template.json" > "$TAKE/steps.json"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TAKE/steps.json" || { echo "steps.json invalid"; exit 2; }

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$TAKE/started_utc.txt"
cd "$ROOT"
CLIP=studio nohup node scripts/studio.mjs record "$CTL" "$ROOT/.cache/frames/studio" > "$TAKE/studio.log" 2>&1 &
SPID=$!
echo "[take] studio recorder pid $SPID"
for i in $(seq 1 180); do
  [ -f "$CTL.ready" ] && break
  kill -0 "$SPID" 2>/dev/null || { echo "[take] studio recorder died"; cat "$TAKE/studio.log"; exit 3; }
  sleep 1
done
if [ ! -f "$CTL.ready" ]; then echo "[take] studio page not ready after 180s"; cat "$TAKE/studio.log"; kill "$SPID"; exit 3; fi
echo "[take] studio ready at $(cat "$CTL.ready")"
sleep 2

HERMES_HOME="$FILM_HOME" python3 scripts/record_pty.py --cols 110 --rows 36 \
  --out "$TAKE/session.cast" --marks "$TAKE/marks_term.json" --steps "$TAKE/steps.json" \
  -- "$HERMES" chat --in /Users/bigmantech001/Faultline/video/demo 2> "$TAKE/record.log"
echo "[take] terminal take finished (exit $?)"
sleep 3
echo "still final" >> "$CTL"; echo "text final" >> "$CTL"
sleep 2
echo "stop" >> "$CTL"
wait "$SPID"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$TAKE/ended_utc.txt"
echo "[take] done: $(cat "$TAKE/started_utc.txt") .. $(cat "$TAKE/ended_utc.txt")"
tail -n 5 "$TAKE/record.log"
