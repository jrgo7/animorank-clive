/**
 * Whether a problem asks for a function rather than a whole program: it defines the
 * functions its function test cases call (`extension_data.builtin_testCase_function`,
 * the same entry `server/problem.ts` reads). The phase windows use it to show a
 * function example, and to say "you don't write main" only where that is true.
 */
export function isFunctionProblem(extensionData: unknown): boolean {
  const functions = (extensionData as { builtin_testCase_function?: { functions?: unknown } } | null)
    ?.builtin_testCase_function?.functions;
  return !!functions && typeof functions === 'object' && Object.keys(functions).length > 0;
}
