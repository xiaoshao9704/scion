import { describe, it, expect } from 'vitest';
import { assertIR, emptyIR } from '../src/ir/schema.js';

describe('PluginIR schema', () => {
  it('accepts a minimal IR', () => {
    const ir = emptyIR('/tmp/p', 'claude');
    ir.identity.name = 'demo';
    expect(assertIR(ir).identity.name).toBe('demo');
  });

  it('rejects an IR without identity.name', () => {
    const ir = emptyIR('/tmp/p', 'claude') as Record<string, any>;
    delete ir.identity.name;
    expect(() => assertIR(ir)).toThrow(/name/);
  });

  it('rejects an unknown ecosystem id', () => {
    const ir = emptyIR('/tmp/p', 'claude') as Record<string, any>;
    ir.sourceEcosystem = 'cursor';
    expect(() => assertIR(ir)).toThrow(/sourceEcosystem/);
  });
});
