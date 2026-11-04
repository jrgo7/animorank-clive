#!/usr/bin/env bash
# Exports one problem's practice sessions and their history entries, so another copy
# of the database can take them in with import-sessions.sh. No user rows go out:
# the import makes a placeholder user for each student it does not have.
#
#   scripts/clive/export-sessions.sh <problem id> <out file>
#
# Needs DATABASE_URL, as in .env: `set -a; . ./.env; set +a` first.
set -euo pipefail

problem=${1:?problem id}
out=${2:?out file}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "\\copy (
  select 1 as ord, 'PracticeSession' as t, to_jsonb(s) as row
  from \"PracticeSession\" s
  where s.problem_id = '$problem'
  union all
  select 2, 'SessionHistoryEntry', to_jsonb(h)
  from \"SessionHistoryEntry\" h
  join \"PracticeSession\" s on s.id = h.practice_session_id
  where s.problem_id = '$problem'
  order by 1
) to '$out'"

echo "sessions: $(grep -c $'^1\tPracticeSession' "$out"), history entries: $(grep -c $'^2\tSessionHistoryEntry' "$out") -> $out"
