import { describe, expect, it } from 'vitest';
import { isFunctionProblem } from './problemKind';

describe('isFunctionProblem', () => {
  it('is true for a problem that defines a function for its test cases', () => {
    const extensionData = {
      builtin_testCase_function: { functions: { 'fn-1': { name: 'checkSecretCode', parameters: [] } } }
    };
    expect(isFunctionProblem(extensionData)).toBe(true);
  });

  it('is false for a problem that reads and prints', () => {
    expect(isFunctionProblem(null)).toBe(false);
    expect(isFunctionProblem({})).toBe(false);
    expect(isFunctionProblem({ clive: { reference_solution: '' } })).toBe(false);
  });

  it('is false when the function list is empty', () => {
    expect(isFunctionProblem({ builtin_testCase_function: { functions: {} } })).toBe(false);
  });
});
