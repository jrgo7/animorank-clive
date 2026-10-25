/**
 * An AnimoRank problem as CLive reads it.
 *
 * The same keys the prototype's problem YAML uses (`clive-userflow/cases/problems/*.yaml`),
 * so the prompt templates and the reference check take it unchanged. Hidden test
 * cases are never loaded into this shape — they never reach a model or the student.
 */
import { db } from '$lib/zenstack';
import { JudgeError } from './content/errors';
import type { ProblemForPrompt } from './content/templates';

/** The `extension_data` key CLive authors its per-problem settings under. */
export interface CLiveProblemData {
  reference_solution?: string;
}

/** One function a problem asks the student to write, as its function test cases define it. */
export interface FunctionDef {
  /** The key the problem's function test cases name it by. */
  id: string;
  name: string;
  parameters: { name: string; type: string }[];
  /** `void` when it returns nothing. */
  returnType: string;
}

interface TypeSpec {
  type?: unknown;
}

function typeName(spec: unknown): string {
  const first = Array.isArray(spec) ? spec[0] : spec;
  return String((first as TypeSpec | undefined)?.type ?? 'void');
}

/**
 * The functions a problem defines for its function test cases
 * (`extension_data.builtin_testCase_function.functions`), in the order they are stored.
 */
export function functionDefs(extensionData: unknown): FunctionDef[] {
  const functions = (extensionData as { builtin_testCase_function?: { functions?: unknown } } | null)
    ?.builtin_testCase_function?.functions;
  if (!functions || typeof functions !== 'object') return [];
  return Object.entries(functions as Record<string, Record<string, unknown>>).map(([id, fn]) => ({
    id,
    name: String(fn?.name ?? ''),
    parameters: (Array.isArray(fn?.parameters) ? fn.parameters : []).map((p: Record<string, unknown>) => ({
      name: String(p?.name ?? ''),
      type: typeName(p?.type)
    })),
    returnType: typeName(fn?.returnType)
  }));
}

interface FunctionCaseData {
  function?: string;
  parameters?: { value?: { data?: { value?: unknown } } }[];
  comparisons?: { symbol?: string; value?: { data?: { value?: unknown } } }[];
}

/**
 * Each public function test case as an example a prompt can show: the call, and
 * the value it returns. Hidden cases are never rendered.
 */
export function functionExamples(
  defs: FunctionDef[],
  testCases: { type: string; public: boolean; data: unknown }[]
): { input: string; output: string }[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return testCases
    .filter((c) => c.public === true && c.type === 'function')
    .flatMap((c) => {
      const data = c.data as FunctionCaseData;
      const fn = byId.get(String(data?.function ?? ''));
      if (!fn) return [];
      const args = (data.parameters ?? []).map((p) => String(p?.value?.data?.value ?? ''));
      const returned = (data.comparisons ?? []).find((x) => x?.symbol === 'return');
      return [{ input: `${fn.name}(${args.join(', ')})`, output: String(returned?.value?.data?.value ?? '') }];
    });
}

export async function loadCLiveProblem(problemId: string): Promise<ProblemForPrompt> {
  const problem = await db.problem.findUnique({
    where: { id: problemId },
    include: { test_cases: true }
  });
  if (!problem) throw new JudgeError('Problem not found.');

  const clive = (problem.extension_data as { clive?: CLiveProblemData } | null)?.clive;
  const publicTestCases = problem.test_cases
    .filter((testCase) => testCase.public === true && testCase.type === 'stdio')
    .map((testCase) => {
      const data = testCase.data as { input?: unknown; output?: unknown };
      return { input: String(data?.input ?? ''), output: String(data?.output ?? '') };
    });

  const functions = functionDefs(problem.extension_data);

  return {
    slug: problem.id,
    title: problem.name,
    statement: problem.description,
    starter_code: problem.starter_code,
    public_test_cases: [...publicTestCases, ...functionExamples(functions, problem.test_cases)],
    functions,
    reference_solution: String(clive?.reference_solution ?? '')
  };
}
