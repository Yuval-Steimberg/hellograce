import { describe, it, expect } from 'vitest';
import { buildPaidWelcome } from './paid-welcome.js';

describe('buildPaidWelcome', () => {
  it('greets by name, does NOT re-introduce Grace, and reminds the options', () => {
    const msg = buildPaidWelcome({ first_name: 'Yuval' });
    expect(msg).toContain('Yuval');
    expect(msg).toMatch(/glad you're staying|keep going together/i);
    // Never re-introduces herself.
    expect(msg).not.toMatch(/i'?m grace|this is grace|i am grace/i);
    // Reminds the key options.
    expect(msg.toLowerCase()).toContain('protein');
    expect(msg.toLowerCase()).toContain('shot');
    expect(msg.toLowerCase()).toContain('dashboard');
  });

  it('falls back gracefully when the name is missing or an unrecoverable cipher blob', () => {
    const noName = buildPaidWelcome({ first_name: null });
    expect(noName).toMatch(/glad you're staying/i);
    const encName = buildPaidWelcome({ first_name: 'enc:2302ab:137bf1:8330cd' });
    expect(encName).not.toContain('enc:');
    expect(encName).toMatch(/glad you're staying/i);
  });
});
