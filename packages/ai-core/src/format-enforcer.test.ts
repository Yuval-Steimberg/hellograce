import { describe, it, expect } from 'vitest';
import { enforceFormat } from './format-enforcer.js';

describe('enforceFormat', () => {
  describe('em / en / double dashes', () => {
    it('replaces em dash with comma', () => {
      const { text, fixes } = enforceFormat('Greek yogurt — easy 17g hit on a GLP-1 stomach.');
      expect(text).toBe('Greek yogurt, easy 17g hit on a GLP-1 stomach.');
      expect(fixes).toContain('em_dash_replaced');
    });

    it('replaces en dash with comma', () => {
      const { text } = enforceFormat('Range is 1.2–1.6g/kg.');
      expect(text).toBe('Range is 1.2, 1.6g/kg.');
    });

    it('replaces double dash with comma', () => {
      const { text, fixes } = enforceFormat('Solid choice -- you are doing great.');
      expect(text).toBe('Solid choice, you are doing great.');
      expect(fixes).toContain('double_dash_replaced');
    });

    it('replaces " - " hyphen-dash with comma', () => {
      const { text } = enforceFormat('Logged - you are at 30g today.');
      expect(text).toBe('Logged, you are at 30g today.');
    });

    it('preserves compound words like easy-to-digest', () => {
      const { text } = enforceFormat('Look for easy-to-digest foods.');
      expect(text).toBe('Look for easy-to-digest foods.');
    });
  });

  describe('markdown stripping', () => {
    it('strips **bold** markdown', () => {
      const { text, fixes } = enforceFormat('Try **Greek yogurt** for protein.');
      expect(text).toBe('Try Greek yogurt for protein.');
      expect(fixes).toContain('markdown_bold_stripped');
    });

    it('strips *italic* markdown', () => {
      const { text } = enforceFormat('That is *really* important.');
      expect(text).toBe('That is really important.');
    });

    it('strips _underscore_ italic', () => {
      const { text } = enforceFormat('That is _really_ important.');
      expect(text).toBe('That is really important.');
    });

    it('does not strip apostrophes or contractions', () => {
      const { text } = enforceFormat("Don't worry, it's fine.");
      expect(text).toBe("Don't worry, it's fine.");
    });

    it('strips markdown headers', () => {
      const { text, fixes } = enforceFormat('## Protein options\nGreek yogurt is great.');
      expect(text).toBe('Protein options\nGreek yogurt is great.');
      expect(fixes).toContain('markdown_header_stripped');
    });
  });

  describe('list flattening', () => {
    it('flattens numbered lists into prose', () => {
      const input = 'Good options:\n1. Greek yogurt\n2. Cottage cheese\n3. Eggs';
      const { text, fixes } = enforceFormat(input);
      expect(text).toBe('Good options:\nGreek yogurt, Cottage cheese, and Eggs');
      expect(fixes).toContain('numbered_list_flattened');
    });

    it('flattens bulleted lists into prose', () => {
      const input = '- Greek yogurt\n- Cottage cheese\n- Eggs';
      const { text, fixes } = enforceFormat(input);
      expect(text).toBe('Greek yogurt, Cottage cheese, and Eggs');
      expect(fixes).toContain('bullet_list_flattened');
    });

    it('does not flatten a lone numbered item (could be an ordinal)', () => {
      const { text, fixes } = enforceFormat('1. is the priority.');
      expect(text).toBe('1. is the priority.');
      expect(fixes).not.toContain('numbered_list_flattened');
    });
  });

  describe('greeting exclamation strip', () => {
    it('replaces "Good morning!" with "Good morning."', () => {
      const { text, fixes } = enforceFormat('Good morning! Hope you slept well.');
      expect(text).toBe('Good morning. Hope you slept well.');
      expect(fixes).toContain('greeting_exclamation_stripped');
    });

    it('replaces "Hi Sarah!" with "Hi Sarah."', () => {
      const { text } = enforceFormat('Hi Sarah! How are you feeling today.');
      expect(text).toBe('Hi Sarah. How are you feeling today.');
    });

    it('does not touch "thanks!" or mid-sentence exclamations', () => {
      const { text } = enforceFormat('Sounds great, thanks!');
      expect(text).toBe('Sounds great, thanks!');
    });
  });

  describe('[link] placeholder', () => {
    it('replaces "[link]" with the real settings URL', () => {
      const { text, fixes } = enforceFormat('Update it here: [link]');
      expect(text).toBe('Update it here: https://graceglp.com/settings');
      expect(fixes).toContain('link_placeholder_replaced');
    });

    it('replaces "[settings link]" with the URL', () => {
      const { text } = enforceFormat('Use [settings link] to change it.');
      expect(text).toBe('Use https://graceglp.com/settings to change it.');
    });
  });

  describe('first name stripping', () => {
    it('strips name with trailing comma: "Got it, Yuval."', () => {
      const { text, fixes } = enforceFormat('Got it, Yuval. I will keep that in mind.', { stripFirstName: 'Yuval' });
      expect(text).toBe('Got it. I will keep that in mind.');
      expect(fixes).toContain('user_name_stripped');
    });

    it('strips name with leading comma: "Sarah, that is great."', () => {
      const { text } = enforceFormat('Sarah, that is great.', { stripFirstName: 'Sarah' });
      expect(text).toBe('That is great.');
    });

    it('strips standalone name occurrence', () => {
      const { text } = enforceFormat('You are doing great Sarah today.', { stripFirstName: 'Sarah' });
      expect(text).toBe('You are doing great today.');
    });

    it('does not strip when stripFirstName is not provided', () => {
      const { text } = enforceFormat('Got it, Yuval. I will keep that in mind.');
      expect(text).toBe('Got it, Yuval. I will keep that in mind.');
    });

    it('case-insensitive name matching', () => {
      const { text } = enforceFormat('Got it, YUVAL. Cool.', { stripFirstName: 'Yuval' });
      expect(text).toBe('Got it. Cool.');
    });
  });

  describe('combined real-world response', () => {
    it('cleans the production screenshot bug: "Got it, Yuval. ..."', () => {
      const input = 'Got it, Yuval — I\'ll **definitely** keep that in mind for any food ideas!';
      const { text } = enforceFormat(input, { stripFirstName: 'Yuval' });
      expect(text).not.toContain('Yuval');
      expect(text).not.toContain('—');
      expect(text).not.toContain('**');
    });
  });
});
