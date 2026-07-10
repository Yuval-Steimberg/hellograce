import { describe, it, expect } from 'vitest';
import { isDeviceAutoReply } from './auto-reply-filter.js';

describe('isDeviceAutoReply', () => {
  it('detects Apple Driving Focus / DND-while-driving auto-replies', () => {
    expect(isDeviceAutoReply("I'm driving with Focus turned on. I'll see your message when I get where I'm going.")).toBe(true);
    expect(isDeviceAutoReply("I'm driving with Do Not Disturb While Driving turned on. I'll see your message when I get where I'm going.")).toBe(true);
    expect(isDeviceAutoReply('Do Not Disturb While Driving is on.')).toBe(true);
  });

  it('detects a plain "driving, get back to you" auto-reply and an auto-reply prefix', () => {
    expect(isDeviceAutoReply("I'm driving right now, I'll get back to you soon.")).toBe(true);
    expect(isDeviceAutoReply('Auto-Reply: I am currently unavailable.')).toBe(true);
  });

  it('does NOT filter a real message that merely mentions driving', () => {
    expect(isDeviceAutoReply("I'm driving now but I had 2 eggs for breakfast")).toBe(false);
    expect(isDeviceAutoReply('Can I eat before driving to my appointment?')).toBe(false);
    expect(isDeviceAutoReply('driving me crazy how hungry I am today')).toBe(false);
  });

  it('does NOT filter ordinary messages or empties', () => {
    expect(isDeviceAutoReply('how much protein today?')).toBe(false);
    expect(isDeviceAutoReply('')).toBe(false);
    expect(isDeviceAutoReply(null)).toBe(false);
    expect(isDeviceAutoReply(undefined)).toBe(false);
  });
});
