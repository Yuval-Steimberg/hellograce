import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let encryptionKey: Buffer | null = null;

export function initFieldEncryption(hexKey?: string): void {
  const raw = hexKey ?? process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) return;
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars)');
  }
  encryptionKey = buf;
}

export function isEncryptionEnabled(): boolean {
  return encryptionKey !== null;
}

export function encryptField(plaintext: string): string {
  if (!encryptionKey) return plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptField(stored: string): string {
  if (!encryptionKey) return stored;
  if (!stored.startsWith('enc:')) return stored;
  const parts = stored.slice(4).split(':');
  if (parts.length !== 3) return stored;
  const [ivHex, dataHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const data = Buffer.from(dataHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  const decipher = createDecipheriv(ALGO, encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * True when a value is an at-rest ciphertext blob (`enc:<iv>:<data>:<tag>`)
 * rather than readable plaintext. Used to detect a field that can't be
 * decrypted by the running process (key missing or rotated) so it's never
 * surfaced to a user. Case-insensitive on the prefix because downstream
 * formatters may title-case the leading word.
 */
export function isEncryptedBlob(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(value.trim());
}

export function hashField(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
