#!/bin/bash
# Daily Kilo free-pool sync. Cron runs this at 00:00 UTC = 6:00 AM Bangladesh time.
# After the sync, model_context.py rewrites the real context windows (from the
# providers' live model lists) that the medical agent uses for its token budget.
cd "$HOME/kilo-router" || exit 1
flock -n /tmp/kilo-free-sync.lock /usr/bin/python3 "$HOME/kilo-router/kilo_free_sync.py" >> "$HOME/kilo-router/cron.log" 2>&1
rc=$?
/usr/bin/python3 "$HOME/kilo-router/model_context.py" >> "$HOME/kilo-router/cron.log" 2>&1
exit $rc
