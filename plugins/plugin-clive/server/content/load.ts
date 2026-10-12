/**
 * The one place that reads CLive's authored content.
 *
 * The rubric, the phase documents and the shared hint/nudge documents stay YAML
 * (the prototype authors them that way), are imported as raw text — the `?raw`
 * pattern `src/lib/plugin/loader.ts` uses for `manifest.json`, inlined into the
 * plugin's server bundle at build time — and parsed once here. Nothing else
 * reads a file.
 */
import { parse } from 'yaml';
import problemDefinitionYaml from '../../content/phases/problem_definition.yaml?raw';
import caseDesignYaml from '../../content/phases/case_design.yaml?raw';
import algorithmDesignYaml from '../../content/phases/algorithm_design.yaml?raw';
import implementYaml from '../../content/phases/implement.yaml?raw';
import problemDefinitionCriteriaYaml from '../../content/criteria/problem_definition.yaml?raw';
import caseDesignCriteriaYaml from '../../content/criteria/case_design.yaml?raw';
import algorithmDesignCriteriaYaml from '../../content/criteria/algorithm_design.yaml?raw';
import implementCriteriaYaml from '../../content/criteria/implement.yaml?raw';
import hintYaml from '../../content/base/hint.yaml?raw';
import nudgeYaml from '../../content/base/nudge.yaml?raw';
import outputSchemaRaw from '../../content/base/output_schema.json?raw';
import { JudgeError } from './errors';

export type FieldKind = 'text' | 'code' | 'cases' | 'steps';

/** One field a phase's artifact holds, as the phase YAML declares it. */
export interface FieldDoc {
  id: string;
  label: string;
  kind: FieldKind;
  prompt?: string;
  hint?: string;
  example?: unknown;
  rows?: number;
  added?: boolean;
  language?: string;
}

/** One phase document (`prompts/phases/<phase>.yaml`). */
export interface PhaseDoc {
  id: string;
  version: number;
  phase: string;
  label: string;
  order: number;
  layout?: 'steps';
  judge?: 'per_step';
  gate?: 'criteria' | 'tests';
  task_description: string;
  example_problem?: string;
  artifact_fields: FieldDoc[];
  model: { id?: string; effort?: string; max_output_tokens?: number };
  system_prompt: string;
  user_template: string;
  references?: { label: string; url: string }[];
}

/** The shared hint or nudge document (`prompts/base/{hint,nudge}.yaml`). */
export interface PromptDoc {
  id: string;
  version: number;
  model?: { effort?: string; max_output_tokens?: number };
  system_prompt: string;
  user_template: string;
}

/** One rubric criterion (`criteria/<phase>.yaml`). */
export interface CriterionDoc {
  id: string;
  text: string;
  gate: 'gating' | 'advisory';
  check?: 'reference';
  fields?: string[];
  not_met?: string;
  explain?: string;
  guidance: string;
}

/** One phase's rubric file. */
export interface RubricDoc {
  id: string;
  phase: string;
  version: number;
  criteria: CriterionDoc[];
}

function parseFile<T>(source: string, name: string): T {
  try {
    return parse(source) as T;
  } catch (cause) {
    throw new JudgeError(
      `CLive content ${name} is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

function normalisePhase(doc: PhaseDoc, name: string): PhaseDoc {
  if (!Array.isArray(doc.artifact_fields) || !doc.system_prompt || !doc.user_template) {
    throw new JudgeError(`CLive content ${name} is missing artifact_fields, system_prompt or user_template.`);
  }
  return {
    ...doc,
    gate: doc.gate ?? 'criteria',
    artifact_fields: doc.artifact_fields.map((field) => ({ ...field, kind: field.kind ?? 'text' }))
  };
}

function normaliseRubric(doc: RubricDoc, name: string): RubricDoc {
  if (!Array.isArray(doc.criteria)) {
    throw new JudgeError(`CLive content ${name} has no criteria list.`);
  }
  return {
    ...doc,
    criteria: doc.criteria.map((criterion) => ({ ...criterion, gate: criterion.gate ?? 'gating' }))
  };
}

const PHASES: Record<string, PhaseDoc> = {
  problem_definition: normalisePhase(
    parseFile(problemDefinitionYaml, 'phases/problem_definition.yaml'),
    'phases/problem_definition.yaml'
  ),
  case_design: normalisePhase(parseFile(caseDesignYaml, 'phases/case_design.yaml'), 'phases/case_design.yaml'),
  algorithm_design: normalisePhase(
    parseFile(algorithmDesignYaml, 'phases/algorithm_design.yaml'),
    'phases/algorithm_design.yaml'
  ),
  implement: normalisePhase(parseFile(implementYaml, 'phases/implement.yaml'), 'phases/implement.yaml')
};

const RUBRICS: Record<string, RubricDoc> = {
  problem_definition: normaliseRubric(
    parseFile(problemDefinitionCriteriaYaml, 'criteria/problem_definition.yaml'),
    'criteria/problem_definition.yaml'
  ),
  case_design: normaliseRubric(
    parseFile(caseDesignCriteriaYaml, 'criteria/case_design.yaml'),
    'criteria/case_design.yaml'
  ),
  algorithm_design: normaliseRubric(
    parseFile(algorithmDesignCriteriaYaml, 'criteria/algorithm_design.yaml'),
    'criteria/algorithm_design.yaml'
  ),
  implement: normaliseRubric(parseFile(implementCriteriaYaml, 'criteria/implement.yaml'), 'criteria/implement.yaml')
};

/** The phase document for `phase`; an unknown phase is a programming error. */
export function phaseDoc(phase: string): PhaseDoc {
  const doc = PHASES[phase];
  if (!doc) throw new JudgeError(`Unknown CLive phase '${phase}'.`);
  return doc;
}

/** The rubric for `phase`; an unknown phase is a programming error. */
export function rubricDoc(phase: string): RubricDoc {
  const doc = RUBRICS[phase];
  if (!doc) throw new JudgeError(`Unknown CLive phase '${phase}'.`);
  return doc;
}

export const HINT_DOC: PromptDoc = parseFile(hintYaml, 'base/hint.yaml');
export const NUDGE_DOC: PromptDoc = parseFile(nudgeYaml, 'base/nudge.yaml');

/** The judge output JSON Schema, as shipped, for the provider that is told its shape. */
export const JUDGE_JSON_SCHEMA: unknown = JSON.parse(outputSchemaRaw);

/** The same schema as text, indented, for a system message. */
export const JUDGE_JSON_SCHEMA_TEXT: string = JSON.stringify(JUDGE_JSON_SCHEMA, null, 2);
