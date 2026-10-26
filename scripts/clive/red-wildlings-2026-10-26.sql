-- Red Wildlings fixes from 2026-10-26, for a copy of the database that does not have them.
-- Safe to run more than once: each change matches only the old text or the broken case.
-- Run from the repo root, with DATABASE_URL set from .env:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/clive/red-wildlings-2026-10-26.sql
begin;

-- The hidden case with nAlice = 100000999, nGuest = 1 and no expected return value.
delete from "ProblemTestCase"
where problem_id = '9d5145fa-ca83-4467-816f-a96ba445a33a'
  and data::text like '%"100000999"%';

-- "Each digit..." on its own line, and the function checks one guest (no "100 guests").
update "Problem" set
  description = replace(replace(description,
    E'section 3**.\n  Each digit',
    E'section 3**.\n\nEach digit'),
    'Since the party is expecting around 100 guests, they want you to **write a C function that accepts Alice''s number and a guest''s response as an `int`. The function returns `1` if the guest is to be let in and `0` otherwise.**',
    'Alice wants you to **write a C function that checks one guest: it accepts Alice''s number and that guest''s response as `int`s, and returns `1` if the guest is to be let in and `0` otherwise.**'),
  updated_at = now()
where id = '9d5145fa-ca83-4467-816f-a96ba445a33a';

-- Expect 12 test cases and 1 for each check below.
select count(*) as test_cases from "ProblemTestCase" where problem_id = '9d5145fa-ca83-4467-816f-a96ba445a33a';
select (description like '%checks one guest%')::int as one_guest,
       (description like E'%section 3**.\n\nEach digit%')::int as bullet_fixed
from "Problem" where id = '9d5145fa-ca83-4467-816f-a96ba445a33a';

commit;
