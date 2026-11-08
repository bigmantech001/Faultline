#!/bin/bash
# Exit 0 once Faultline's recorder holds a chaos rule for the webhook route (used by the take's wait_until step).
DB="${FAULTLINE_DB:-/private/tmp/claude-501/-Users-bigmantech001-Faultline/24ea2fa7-aaf2-4fa6-8efe-c0431050eb42/scratchpad/film-home/plugin-data/faultline/faultline.db}"
n=$(sqlite3 "$DB" "select count(*) from chaos_rules where path_pattern like '%webhooks%'" 2>/dev/null || echo 0)
[ "${n:-0}" -gt 0 ]
