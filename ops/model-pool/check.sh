#!/bin/bash
# Used by the 6:30 AM check: make sure cron is running, run the sync if today's
# run is missing (VM was asleep or restarted), then print the last result.
cd "$HOME/kilo-router" || exit 1
if ! pgrep -x cron >/dev/null; then
  sudo -n /usr/sbin/cron && echo "NOTE: cron was not running; started it"
fi
if ! curl -s -o /dev/null --max-time 10 http://localhost:4120/health; then
  echo "BIFROST_DOWN: Bifrost is not answering on localhost:4120"
fi
age=999999
[ -f status.json ] && age=$(( $(date +%s) - $(stat -c %Y status.json) ))
if [ "$age" -gt 72000 ]; then
  echo "NOTE: no run in the last 20 hours; running the sync now"
  ./run.sh
fi
python3 - <<'EOF'
import json
s = json.load(open('status.json'))
print('RESULT:', 'OK' if s.get('ok') else 'FAILED')
print('run_at_utc:', s.get('run_at_utc'))
if s.get('error'): print('error:', s['error'])
print('live_free:', len(s.get('live_free', [])), 'passing:', len(s.get('passing', [])))
print('passing_models:', ', '.join(p['model'] for p in s.get('passing', [])))
print('added:', s.get('added'), 'dropped:', s.get('dropped'))
EOF
