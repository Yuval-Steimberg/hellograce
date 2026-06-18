import { describe, it, expect } from 'vitest';
import {
  initFieldEncryption,
  encryptField,
  decryptField,
  isEncryptedBlob,
  isEncryptionEnabled,
} from './field-encrypt.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('isEncryptedBlob', () => {
  it('flags an enc:<iv>:<data>:<tag> blob (any case)', () => {
    expect(isEncryptedBlob('enc:0b5f95fcc08abfd1d100b3bbf8:9fc0bd0f16:e869b61ae8988e421a3b221721444616')).toBe(true);
    expect(isEncryptedBlob('ENC:0b5f:9fc0:e869')).toBe(true);
  });
  it('does not flag plaintext', () => {
    expect(isEncryptedBlob('Wegovy')).toBe(false);
    expect(isEncryptedBlob('enc:nothex:zz:yy')).toBe(false);
    expect(isEncryptedBlob('encyclopedia')).toBe(false);
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
    expect(isEncryptedBlob('')).toBe(false);
  });
  it('flags a real encrypted value round-trip', () => {
    initFieldEncryption(KEY);
    const blob = encryptField('Mounjaro');
    expect(isEncryptedBlob(blob)).toBe(true);
    expect(decryptField(blob)).toBe('Mounjaro');
    expect(isEncryptionEnabled()).toBe(true);
  });
});
