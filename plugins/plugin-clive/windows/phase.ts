/** One row of a `cases`-kind artifact field: an input, its expected output, and how the student got it. */
export interface CaseRow {
  input: string;
  output: string;
  working: string;
}

export type ArtifactFieldKind = 'text' | 'cases' | 'code';

export interface ArtifactField {
  id: string;
  label: string;
  kind: ArtifactFieldKind;
  hint?: string;
  /** A worked example shown under the field. A `cases` field's example is itself a list of rows. */
  example?: string | CaseRow[];
  rows?: number;
  language?: string;
}

export interface PhaseReference {
  label: string;
  url: string;
}

export interface PhaseConfig {
  phase: string;
  label: string;
  order: number;
  taskDescription: string;
  artifactFields: ArtifactField[];
  references?: PhaseReference[];
}

/**
 * The four PCDIT phases, in the order CLive gates them (Problem, Cases, Design,
 * Implement -- `case_design` runs before `algorithm_design` despite the name
 * order, per each phase file's own `order` field).
 *
 * Ported from `clive-userflow/prompts/phases/*.yaml` (the non-versioned ones --
 * `list_phases()`/`load_phase()` build this same shape server-side from those
 * files). Hardcoded here until the plugin has a `/plugin-api/clive/boot` route
 * to serve it; see `windows/api.ts` for the seam that will replace this with a
 * fetch once the native judge port lands.
 */
export const PHASES: readonly PhaseConfig[] = [
  {
    phase: 'problem_definition',
    label: 'Problem',
    order: 1,
    taskDescription:
      'Before you write any code, restate this problem in your own words — two or three sentences ' +
      'explaining the task to a classmate who has not read the statement. Then list every input in the ' +
      'order the program reads it, giving each a definite C type (`int`, `float`, an array of a stated ' +
      'size) along with whatever the statement guarantees about its values — range, sign, count, ' +
      'ordering — or saying explicitly that it guarantees nothing. Finally, state what the program ' +
      'prints and in exactly what form, including any fixed decimal places, rounding, or wording; you ' +
      'are not solving the problem yet, so no algorithm and no code.',
    artifactFields: [
      {
        id: 'summary',
        label: 'Summary',
        kind: 'text',
        rows: 4,
        hint: 'Restate the task in your own words.',
        example:
          'Example, for a different problem — The program checks whether a single word reads the same ' +
          'forwards and backwards. It reads one word and prints whether it is a palindrome.'
      },
      {
        id: 'inputs',
        label: 'Inputs',
        kind: 'text',
        rows: 3,
        hint: 'What the program reads, of what type, and what the statement guarantees about it.',
        example: 'Example — one word: a string of lowercase letters, 1 to 100 characters long, with no spaces'
      },
      {
        id: 'outputs',
        label: 'Outputs',
        kind: 'text',
        rows: 3,
        hint: 'What the program prints, and in what form — one line or many, whatever the problem actually asks for.',
        example: 'Example — exactly "Yes" if the word is a palindrome, exactly "No" otherwise'
      }
    ]
  },
  {
    phase: 'case_design',
    label: 'Cases',
    order: 2,
    taskDescription:
      'Work the problem by hand before you plan a solution. Write out at least one ordinary case — a ' +
      'concrete input, the output you worked out yourself, and the steps that got you there — then at ' +
      'least one boundary case, the smallest or largest or otherwise extreme input the constraints ' +
      'allow, saying what makes it a boundary. Explain what each case is meant to expose; a case copied ' +
      'from the examples you were given does not count, because the point is to find the ones nobody ' +
      'handed you.',
    artifactFields: [
      {
        id: 'normal_cases',
        label: 'Typical cases',
        kind: 'cases',
        hint: 'An ordinary input, the output you worked out, and how you got it. Add a case for each one.',
        example: [
          {
            input: 'level',
            output: 'Yes',
            working: 'reading the word back to front still spells "level", so it matches.'
          },
          { input: 'hello', output: 'No', working: 'reversed it spells "olleh", which does not match "hello".' }
        ]
      },
      {
        id: 'edge_cases',
        label: 'Edge cases',
        kind: 'cases',
        hint: 'Inputs at the boundaries — smallest, largest, zero, ties. Say what each one tests.',
        example: [
          { input: 'a', output: 'Yes', working: 'a single letter is trivially the same reversed, so it counts.' },
          {
            input: 'noon',
            output: 'Yes',
            working: "the longest case here, checking the comparison doesn't stop partway."
          }
        ]
      },
      {
        id: 'reasoning',
        label: 'Why these cases',
        kind: 'text',
        rows: 4,
        hint: 'What each case is meant to expose about the problem.',
        example:
          'Example — the typical cases confirm the ordinary comparison works both ways; the edge cases ' +
          'check the smallest possible input and a longer one, to make sure the check runs to completion ' +
          'instead of stopping early.'
      }
    ]
  },
  {
    phase: 'algorithm_design',
    label: 'Design',
    order: 3,
    taskDescription:
      'Write the plan a person could follow to solve this, in plain language rather than C — numbered ' +
      'steps, in the order they happen, with no semicolons, printf calls, or type declarations. Say what ' +
      'the algorithm keeps track of as it runs: the totals, counters, or arrays that carry between ' +
      'steps, and what each one holds to begin with. Finish with the step that produces the output in ' +
      'the exact form the problem requires; a step that uses a value no earlier step created is a gap, ' +
      'however obvious the fix looks.',
    artifactFields: [
      {
        id: 'steps',
        label: 'Algorithm steps',
        kind: 'text',
        rows: 8,
        hint: 'Numbered steps, in plain language. Not C. A step can return a value from a function as easily as it can print one.',
        example:
          'Example, for a different problem —\n' +
          '1. Read the word the user typed.\n' +
          '2. Compare the first remaining letter to the last remaining letter.\n' +
          '3. If they differ, the word is not a palindrome — skip to step 6.\n' +
          '4. Move one letter in from each end and repeat step 2, until the two positions meet or cross.\n' +
          '5. If every pair matched, the word is a palindrome.\n' +
          '6. Print "Yes" if it is a palindrome, "No" otherwise.'
      },
      {
        id: 'state',
        label: 'What you keep track of',
        kind: 'text',
        rows: 4,
        hint: 'The values carried between steps — totals, counters, arrays — and what each holds.',
        example:
          'Example — two positions, one starting at the front of the word and one at the back, both ' +
          'moving toward the middle; and a flag that starts true and turns false the moment a pair of ' +
          "letters doesn't match."
      },
      {
        id: 'output_step',
        label: 'Producing the output',
        kind: 'text',
        rows: 3,
        hint: 'How the final answer is produced, in the format the problem requires — printed directly, or returned from a function, whichever your solution actually does.',
        example:
          'Example — once the flag is settled, print "Yes" if it is still true or "No" if it was set to ' +
          'false, exactly as the problem asks.'
      }
    ]
  },
  {
    phase: 'implement',
    label: 'Implement',
    order: 4,
    taskDescription:
      'Write the C program that carries out the plan you designed. Read from standard input and print ' +
      'to standard output, exactly in the format the problem asks for — nothing else, no prompts like ' +
      '"Enter a number:".\n\n' +
      'Run checks your program against the examples you were given, as often as you like and at no ' +
      'cost. Submit runs it against those and against cases you have not seen.\n\n' +
      'Your program has to compile with warnings treated as errors, so an unused variable will stop the ' +
      'build. Once every case passes, your code is compared with your Design plan — not to find bugs, ' +
      'but to point out where the two differ. Your plan stays open: click Design in the phase bar above ' +
      'to change it at any time.\n\n' +
      'Hints here are about your plan, not about C syntax. For syntax, use the C reference linked below, ' +
      'or search the web for documentation. Do not use AI assistants (ChatGPT, Copilot, Claude and the ' +
      'like) during this phase.',
    artifactFields: [
      {
        id: 'code',
        label: 'Your C program',
        kind: 'code',
        language: 'c',
        rows: 20,
        hint: 'A complete program. Read from standard input, print to standard output.'
      }
    ],
    references: [{ label: 'C reference (cppreference.com)', url: 'https://en.cppreference.com/w/c' }]
  }
];
