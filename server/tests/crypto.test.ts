import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, hashPassword, hashToken, verifyPassword } from '../src/crypto.js';

describe('cryptography', () => {
  it('encrypts secrets with authenticated randomized ciphertext', () => {
    const box = new SecretBox(randomBytes(32));
    const first = box.encrypt('connector-secret');
    const second = box.encrypt('connector-secret');
    expect(first).not.toBe(second);
    expect(box.decrypt(first)).toBe('connector-secret');
  });

  it('uses Argon2id password hashes and verifies safely', async () => {
    const hash = await hashPassword('a sufficiently long password');
    expect(hash).toContain('$argon2id$');
    await expect(verifyPassword(hash, 'a sufficiently long password')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('creates deterministic non-reversible token lookup hashes', () => {
    expect(hashToken('token')).toBe(hashToken('token'));
    expect(hashToken('token')).not.toContain('token');
  });
});
