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

  return {
    slug: problem.id,
    title: problem.name,
    statement: problem.description,
    starter_code: problem.starter_code,
    public_test_cases: publicTestCases,
    reference_solution: String(clive?.reference_solution ?? '')
  };
}
