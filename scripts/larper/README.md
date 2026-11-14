# The larper

An LLM writes one named kind of student answer for one phase ("Copied From Summary",
"Compile Error", ...), the answer goes through CLive's own submit path, and a sheet shows
what CLive said back. It is for the categories of answer no participant has given yet.

It is a researcher's tool, not part of the app and not part of the test suite: **every run
makes real model calls and costs money.** It reads the problem from the local database and
writes to no practice session.

Design: `docs/superpowers/specs/2026-11-14-larper-design.md`.

## Running it

```bash
# Once per problem: a known-good answer for each phase, which every category is written against.
LARPER_PROBLEM=<problem id> LARPER_BASELINE=1 npx vitest run --config vitest.larper.config.ts

# Every category of one phase, three answers each.
LARPER_PROBLEM=<problem id> LARPER_PHASE=problem_definition npx vitest run --config vitest.larper.config.ts

# Re-judge the saved answers after changing a prompt, writing nothing new.
LARPER_PROBLEM=<problem id> LARPER_REUSE=1 npx vitest run --config vitest.larper.config.ts
```

| Variable            | Meaning                                                                      | Default                      |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `LARPER_PROBLEM`    | the problem's id in the local database                                       | required                     |
| `LARPER_PHASE`      | `problem_definition`, `case_design`, `algorithm_design` or `implement`       | all four                     |
| `LARPER_CATEGORY`   | one category id from `categories.yaml`                                       | all in the phase             |
| `LARPER_VARIANTS`   | answers written per category                                                 | `3`                          |
| `LARPER_BASELINE=1` | write the baseline instead of running categories                             | off                          |
| `LARPER_REUSE=1`    | write nothing new; submit the saved answers                                  | off                          |
| `LARPER_DRY=1`      | write and save answers; submit nothing                                       | off                          |
| `LARPER_REPEAT=1`   | submit each blocked answer a second time, with the first feedback as history | off                          |
| `LARPER_OUT`        | where the sheets go                                                          | `scripts/larper/out/<time>/` |

## What it writes

- `baseline/<problem id>.json`: the known-good answers. Edit by hand if you want a different starting point.
- `answers/<problem id>/<phase>.json`: every answer, saved before any is submitted. To add one
  of your own, add an entry with `"writtenBy": "hand"`; a later run keeps it and replaces only
  the larper's.
- `out/<time>/<phase>.md`: the sheet to read. Per category: what the student wrote, whether it
  was blocked, what failed, the situation CLive recorded, and the feedback.
- `out/<time>/<phase>.labels.csv`: the same answers in the team's labelling layout, one row per
  answer and criterion, with Label and Reason columns for two labellers left blank. It says
  nothing of the category or of what CLive decided. A criterion judged against earlier work
  (the Design against the student's case, the code against the Design) shows that work too.
- `out/<time>/<phase>.labels-key.csv`: what the labelling sheet leaves out, by the same Row ID:
  the category, CLive's verdict and evidence, the situation and the feedback.
- `out/<time>/results.jsonl`: everything, one result per line.

## Categories and expectations

`categories.yaml` lists the categories and what the larper is told for each. `expect` is blank
until the team decides the expected behaviour; once filled, the sheet marks each row ✓ or ✗.
An expectation never fails a run.

The larper is never shown the rubric, the situations or the reference solution, and a test
(`writer.test.ts`) checks that none of them appear in what it is sent.

## Limits

- Cases is answered and judged as Case 1 only.
- Hidden test cases are not run: in Implement, "passes" means it compiles and passes the
  problem's examples.
- Nothing on screen is tested: not the editor's markers, not where feedback appears.
- A row marked **off-category** is an answer whose code did not do what its category asked
  (a "compile error" that compiles). Read it as a different test, or write the answer by hand.
