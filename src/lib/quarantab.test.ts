import { describe, expect, test } from '@jest/globals';
import { QuaranTab } from "./quarantab";

describe('QuaranTab', () => {
  const instance = new QuaranTab({
    contextualIdentities: {
      query: async () => [],
    }
  } as any);
  test('container name', () => {
    expect(instance._generateQuaranTabContainerName().startsWith('QuaranTab')).toBeTruthy();
    expect(instance._isQuranTabContainerName(instance._generateQuaranTabContainerName())).toBeTruthy();
  });
});