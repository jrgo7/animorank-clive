#!/usr/bin/env bash
# Takes in the practice sessions and history entries that export-sessions.sh wrote on
# another machine. Rows already here are left alone, so it is safe to run again. The
# problem itself must already exist here; students who do not get a placeholder user.
#
#   scripts/clive/import-sessions.sh <file>
#
# Needs DATABASE_URL, as in .env: `set -a; . ./.env; set +a` first.
set -euo pipefail

file=${1:?file from export-sessions.sh}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;

create temp table imported (ord int, t text, row jsonb);
\\copy imported from '$file'

do \$\$
declare missing uuid;
begin
  select distinct (row->>'problem_id')::uuid into missing
  from imported where t = 'PracticeSession'
    and not exists (select 1 from "Problem" p where p.id = (row->>'problem_id')::uuid);
  if missing is not null then
    raise exception 'Problem % is not in this database; add it first.', missing;
  end if;
end \$\$;

-- A placeholder user and student for each student this database does not have.
insert into "User" (id, name, email, "updatedAt")
select distinct (row->>'student_id')::uuid,
       'Imported participant ' || left(row->>'student_id', 8),
       'participant-' || (row->>'student_id') || '@clive.invalid',
       now()
from imported where t = 'PracticeSession'
on conflict (id) do nothing;

insert into "Student" (id)
select distinct (row->>'student_id')::uuid from imported where t = 'PracticeSession'
on conflict (id) do nothing;

create temp table added (t text, n int);

with ins as (
  insert into "PracticeSession"
  select (jsonb_populate_record(null::"PracticeSession", row)).*
  from imported where t = 'PracticeSession'
  on conflict (id) do nothing
  returning 1
) insert into added select 'sessions', count(*) from ins;

with ins as (
  insert into "SessionHistoryEntry"
  select (jsonb_populate_record(null::"SessionHistoryEntry", row)).*
  from imported where t = 'SessionHistoryEntry'
  on conflict (id) do nothing
  returning 1
) insert into added select 'history entries', count(*) from ins;

select t as added, n from added;

commit;
SQL
