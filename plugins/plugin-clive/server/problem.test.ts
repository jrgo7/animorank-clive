/**
 * How a function problem reaches the prompts: its signature, and its public
 * function test cases rendered as examples a student and a model can read.
 */
import { describe, expect, it } from 'vitest';
import { functionDefs, functionExamples } from './problem';

const FN = '0205d123-8b7b-4b9e-ab6b-a0c0d4bcac68';

const intType = { type: 'int', options: { size: 32, signed: null } };

const RED_WILDLINGS = {
  builtin_testCase_function: {
    functions: {
      [FN]: {
        name: 'checkSecretCode',
        parameters: [
          { id: 'a', name: 'nAlice', type: intType },
          { id: 'b', name: 'nGuest', type: intType }
        ],
        returnType: [intType]
      }
    }
  }
};

function functionCase(isPublic: boolean, args: string[], returned: string) {
  return {
    type: 'function',
    public: isPublic,
    data: {
      function: FN,
      parameters: args.map((value) => ({ name: '', value: { type: 'int', data: { value } } })),
      comparisons: [
        { symbol: 'return', operator: { type: 'equal' }, value: { type: 'int', data: { value: returned } } }
      ]
    }
  };
}

describe('functionDefs', () => {
  it('reads the signature of each function a problem defines', () => {
    expect(functionDefs(RED_WILDLINGS)).toEqual([
      {
        id: FN,
        name: 'checkSecretCode',
        parameters: [
          { name: 'nAlice', type: 'int' },
          { name: 'nGuest', type: 'int' }
        ],
        returnType: 'int'
      }
    ]);
  });

  it('finds none in a problem without function test cases', () => {
    expect(functionDefs({})).toEqual([]);
    expect(functionDefs(null)).toEqual([]);
  });

  it('names a function that returns nothing void', () => {
    const data = {
      builtin_testCase_function: {
        functions: { x: { name: 'show', parameters: [], returnType: [{ type: 'void', options: {} }] } }
      }
    };
    expect(functionDefs(data)[0].returnType).toBe('void');
  });
});

describe('functionExamples', () => {
  it('renders a public function test case as a call and the value it returns', () => {
    const defs = functionDefs(RED_WILDLINGS);
    expect(functionExamples(defs, [functionCase(true, ['123', '999999999'], '0')])).toEqual([
      { input: 'checkSecretCode(123, 999999999)', output: '0' }
    ]);
  });

  it('never renders a hidden test case', () => {
    const defs = functionDefs(RED_WILDLINGS);
    expect(functionExamples(defs, [functionCase(false, ['1', '2'], '1')])).toEqual([]);
  });
});
