import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, rewriteCanonicalLinks } from './sender.js';

describe('rewriteCanonicalLinks — settings link points at the deployment (2026-06-13)', () => {
  const web = 'https://grace-admin-silk.vercel.app';
  it('rewrites a protocol URL', () => {
    expect(rewriteCanonicalLinks('Update it at https://graceglp.com/settings', web))
      .toBe('Update it at https://grace-admin-silk.vercel.app/settings');
  });
  it('rewrites a bare host (no protocol), preserving the path', () => {
    expect(rewriteCanonicalLinks('see graceglp.com/settings to change it', web))
      .toBe('see grace-admin-silk.vercel.app/settings to change it');
  });
  it('rewrites www + other paths (e.g. /upgrade)', () => {
    expect(rewriteCanonicalLinks('https://www.graceglp.com/upgrade?phone=x', web))
      .toBe('https://grace-admin-silk.vercel.app/upgrade?phone=x');
  });
  it('no-op when no webUrl, or when the deployment IS graceglp.com', () => {
    expect(rewriteCanonicalLinks('https://graceglp.com/settings')).toBe('https://graceglp.com/settings');
    expect(rewriteCanonicalLinks('https://graceglp.com/settings', 'https://graceglp.com')).toBe('https://graceglp.com/settings');
  });
  it('leaves unrelated text untouched', () => {
    expect(rewriteCanonicalLinks('Aim for 100g protein today.', web)).toBe('Aim for 100g protein today.');
  });
});

describe('sanitizeOutbound — never truncates a trailing URL (2026-06-13)', () => {
  it('preserves a full settings link at the end of the message', () => {
    const msg = "Profile settings can only be updated from the Settings page. Please update it there and I'll use the updated information moving forward: https://grace-admin-silk.vercel.app/settings";
    const out = sanitizeOutbound(msg);
    expect(out).toContain('https://grace-admin-silk.vercel.app/settings');
    expect(out).not.toMatch(/vercel\.?$/); // not chopped to "…vercel" / "…vercel."
  });
  it('preserves a link followed by a period', () => {
    const out = sanitizeOutbound('You can change it at https://grace-admin-silk.vercel.app/settings.');
    expect(out).toContain('grace-admin-silk.vercel.app/settings');
  });
  it('preserves a bare (no-protocol) domain link', () => {
    const out = sanitizeOutbound('Update it at grace-admin-silk.vercel.app/settings');
    expect(out).toContain('grace-admin-silk.vercel.app/settings');
  });
  it('still repairs a genuine mid-word truncation (no URL)', () => {
    const out = sanitizeOutbound('Got it. I was about to say something but');
    expect(out).toBe('Got it.');
  });
});

describe('sanitizeOutbound — encrypted-field leak guard (2026-06-18)', () => {
  it('redacts an undecrypted enc: blob (the prod medication leak)', () => {
    const msg =
      "You're on enc:0b5f95fcc08abfd1d100b3bbf8:9fc0bd0f16e13c33736d4:e869b61ae8988e421a3b221721444616 at 0.5mg, injection day Wed.";
    const out = sanitizeOutbound(msg);
    expect(out).not.toMatch(/enc:/i);
    expect(out).toContain('0.5mg');
    expect(out).toContain('injection day Wed');
  });
  it('leaves a normal message untouched', () => {
    const msg = "You're on Wegovy at 0.5mg, injection day Sunday.";
    expect(sanitizeOutbound(msg)).toContain('Wegovy');
  });
});

describe('sanitizeOutbound — em-dash replacement', () => {
  it('replaces em-dashes with commas', () => {
    const out = sanitizeOutbound('Got it — moved your injection day.');
    expect(out).toBe('Got it, moved your injection day.');
    expect(out).not.toContain('—');
  });

  it('replaces en-dashes with commas', () => {
    const out = sanitizeOutbound('Sucks to hear that – rough night?');
    expect(out).not.toContain('–');
  });

  it('replaces double-dashes with commas', () => {
    const out = sanitizeOutbound('Got it -- handling it now.');
    expect(out).toBe('Got it, handling it now.');
  });

  it('replaces " - " single-hyphen-as-dash with comma', () => {
    const out = sanitizeOutbound('Got it - moved your injection day.');
    expect(out).toBe('Got it, moved your injection day.');
  });

  it('does NOT mangle compound words like easy-to-digest', () => {
    const out = sanitizeOutbound('Try easy-to-digest options.');
    expect(out).toBe('Try easy-to-digest options.');
  });

  it('handles multiple em-dashes in one message', () => {
    const out = sanitizeOutbound('Hey — quick note — your protein is solid today.');
    expect(out).not.toContain('—');
    expect(out).toMatch(/^Hey, quick note, your protein is solid today\.$/);
  });
});

describe('sanitizeOutbound — mid-sentence truncation', () => {
  it('trims trailing hyphen + partial word to last complete sentence', () => {
    const out = sanitizeOutbound('You got this. Try easy-to-');
    expect(out).toBe('You got this.');
  });

  it('drops stranded prepositions when no terminator present', () => {
    const out = sanitizeOutbound('Greek yogurt is a solid pick of');
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toMatch(/\s+of$/i);
  });

  it('adds a period when no terminator and no recoverable sentence', () => {
    const out = sanitizeOutbound('Greek yogurt works');
    expect(out).toBe('Greek yogurt works.');
  });

  it('preserves complete sentences ending with period', () => {
    const out = sanitizeOutbound('Got it, your injection day is now Sunday.');
    expect(out).toBe('Got it, your injection day is now Sunday.');
  });

  it('preserves complete sentences ending with question mark', () => {
    const out = sanitizeOutbound('Rough night of sleep?');
    expect(out).toBe('Rough night of sleep?');
  });

  it('preserves complete sentences ending with emoji', () => {
    const out = sanitizeOutbound('Love hearing that 🧡');
    expect(out).toBe('Love hearing that 🧡');
  });

  it('strips exclamation to period (format-enforcer H5: SMS stays calm)', () => {
    // After 2026-06-04 universal-check pass, sanitizeOutbound runs
    // enforceFormat which strips "!" everywhere per H5 rule.
    const out = sanitizeOutbound('Glad to hear that!');
    expect(out).toBe('Glad to hear that.');
  });

  it('keeps last complete thought when LLM truncates mid-word at the end', () => {
    const out = sanitizeOutbound(
      "You're crushing it this week. For protein, focus on dense, easy-to-",
    );
    expect(out).toBe("You're crushing it this week.");
  });

  it('throws EmptyOutboundError on empty / whitespace-only input', () => {
    // Empty bodies should never reach the user. The sender catches this and
    // substitutes a neutral fallback rather than shipping silence.
    expect(() => sanitizeOutbound('')).toThrow();
    expect(() => sanitizeOutbound('   ')).toThrow();
  });
});

describe('sanitizeOutbound — real production failure modes', () => {
  it('cleans the safety-guard message that has an em-dash', () => {
    const input =
      "That's really one for your prescribing clinician — they can give you the right answer.";
    const out = sanitizeOutbound(input);
    expect(out).not.toContain('—');
    expect(out.endsWith('.')).toBe(true);
  });

  it('cleans the webhook fallback that has an em-dash', () => {
    const out = sanitizeOutbound('My connection blipped — what were you saying?');
    expect(out).not.toContain('—');
    expect(out.endsWith('?')).toBe(true);
  });

  it('cleans a scheduler proactive message that has an em-dash', () => {
    const out = sanitizeOutbound('Morning 🌿 Mid-week check — how are you feeling?');
    expect(out).not.toContain('—');
  });
});

describe('sanitizeOutbound — placeholder & role-marker stripping', () => {
  it('strips unfilled {first_name} placeholders', () => {
    const out = sanitizeOutbound('Hey {first_name}, hope you are doing okay today.');
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
  });

  it('strips [link] placeholders', () => {
    const out = sanitizeOutbound('Head to [link] to subscribe.');
    expect(out).not.toContain('[link]');
  });

  it('strips hallucinated role markers at line start', () => {
    const out = sanitizeOutbound('Assistant: Hey, hope you are well today.');
    expect(out).not.toMatch(/^Assistant:/);
  });

  it('keeps legitimate bracketed content like [laughs]', () => {
    const out = sanitizeOutbound('Tried that yesterday [laughs], it worked.');
    expect(out).toContain('[laughs]');
  });

  it('does not strip mid-sentence words that contain "User"', () => {
    const out = sanitizeOutbound('User testing went well today.');
    expect(out).toContain('User testing');
  });

  // ── Bug 4 remediation: outbound markdown strip (2026-05-30) ────────────
  describe('markdown strip (Bug 4)', () => {
    it('strips **bold**', () => {
      expect(sanitizeOutbound('**Cottage cheese** has 25g protein.')).toBe(
        'Cottage cheese has 25g protein.',
      );
    });

    it('strips *italic*', () => {
      expect(sanitizeOutbound('Try *cold* foods first.')).toBe('Try cold foods first.');
    });

    it('strips _italic_', () => {
      expect(sanitizeOutbound('Try _cold_ foods first.')).toBe('Try cold foods first.');
    });

    it('strips # headers', () => {
      const out = sanitizeOutbound('# Protein\nAim for 100g today.');
      expect(out).not.toContain('# ');
      expect(out).toContain('Protein');
    });

    it('strips bullet markers at line start', () => {
      const out = sanitizeOutbound('- Greek yogurt\n- Cottage cheese\n- Eggs');
      expect(out).not.toMatch(/^\s*-\s/m);
    });

    it('strips numbered-list markers', () => {
      const out = sanitizeOutbound('1. Greek yogurt\n2. Cottage cheese');
      expect(out).not.toMatch(/^\d+\.\s/m);
    });

    it('strips backtick inline code', () => {
      expect(sanitizeOutbound('Use the `log_food` tool.')).toBe('Use the log_food tool.');
    });

    it('does NOT touch normal prose with no markdown', () => {
      const input = 'Greek yogurt, cottage cheese, eggs all sit well on a GLP-1 stomach.';
      expect(sanitizeOutbound(input)).toBe(input);
    });

    // ── Residual-markdown guarantee (2026-06-14) ─────────────────────────
    it('strips a stray bullet after a comma (production failure)', () => {
      const out = sanitizeOutbound(
        "Since you're vegetarian and gentle on a GLP-1 stomach, * Greek yogurt power bowl: Mix nonfat Greek yogurt with blueberries.",
      );
      expect(out).not.toContain('*');
      expect(out).toContain('Greek yogurt power bowl');
    });

    it('strips an unpaired/unclosed asterisk', () => {
      expect(sanitizeOutbound('Try *Greek yogurt for protein today.')).not.toContain('*');
    });
  });
});

describe('sanitizeOutbound — strips leading orphan punctuation (2026-06-16)', () => {
  it('a stripped name leaving a leading comma is cleaned + capitalized', () => {
    // Production: "<name>, what would you like to dig into?" → name stripped →
    // ", what would you like to dig into?"
    expect(sanitizeOutbound(', what would you like to dig into?')).toBe('What would you like to dig into?');
  });
  it('leading semicolon/colon/dash are stripped', () => {
    expect(sanitizeOutbound('; here is the plan.')).toBe('Here is the plan.');
    expect(sanitizeOutbound(': got it.')).toBe('Got it.');
    expect(sanitizeOutbound('- noted.')).toBe('Noted.');
  });
  it('a leading emoji is preserved', () => {
    expect(sanitizeOutbound('🤍 glad to hear it.')).toBe('🤍 glad to hear it.');
  });
  it('a normal sentence is unchanged', () => {
    expect(sanitizeOutbound('That sounds like a good day.')).toBe('That sounds like a good day.');
  });
});
