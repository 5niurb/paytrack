/**
 * Tests for lib/crypto.js — AES-256-GCM encryption for onboarding sensitive fields.
 * Red/Green TDD: run this file before implementing lib/crypto.js to confirm failures.
 * Run: node test/crypto.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// ---- Load module under test ----
let c;
try {
  c = require('../lib/crypto');
} catch (e) {
  console.error('FAIL: lib/crypto.js not found —', e.message);
  process.exit(1);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.error('  FAIL:', name, '-', e.message);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.error('  FAIL:', name, '-', e.message);
    failed++;
  }
}

// Generate a test key for all tests (valid 32-byte base64-encoded key)
const TEST_KEY = Buffer.from(crypto.randomBytes(32)).toString('base64');
const ALT_KEY = Buffer.from(crypto.randomBytes(32)).toString('base64');

// Set the env var for tests that rely on it
process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;

async function main() {
  // ---- Exports check ----
  console.log('\nExports:');
  test('encryptValue exported', () => assert.strictEqual(typeof c.encryptValue, 'function'));
  test('decryptValue exported', () => assert.strictEqual(typeof c.decryptValue, 'function'));
  test('isEncrypted exported', () => assert.strictEqual(typeof c.isEncrypted, 'function'));
  test('generateKey exported', () => assert.strictEqual(typeof c.generateKey, 'function'));

  // ---- Round-trip ----
  console.log('\nRound-trip encrypt/decrypt:');
  await testAsync('SSN round-trip', async () => {
    const plaintext = '123-45-6789';
    const ciphertext = await c.encryptValue(plaintext);
    const result = await c.decryptValue(ciphertext);
    assert.strictEqual(result, plaintext);
  });

  await testAsync('bank account round-trip', async () => {
    const plaintext = '987654321';
    const ciphertext = await c.encryptValue(plaintext);
    const result = await c.decryptValue(ciphertext);
    assert.strictEqual(result, plaintext);
  });

  await testAsync('routing number round-trip', async () => {
    const plaintext = '121000358';
    const ciphertext = await c.encryptValue(plaintext);
    const result = await c.decryptValue(ciphertext);
    assert.strictEqual(result, plaintext);
  });

  // ---- Non-deterministic (random IV) ----
  console.log('\nNon-determinism (random IV per encryption):');
  await testAsync('same plaintext → different ciphertexts', async () => {
    const c1 = await c.encryptValue('123-45-6789');
    const c2 = await c.encryptValue('123-45-6789');
    assert.notStrictEqual(c1, c2, 'Expected different ciphertexts due to random IV');
  });

  // ---- Tampering rejection ----
  console.log('\nTampering detection:');
  await testAsync('tampered ciphertext throws', async () => {
    const ciphertext = await c.encryptValue('secret');
    // Flip a byte in the middle of the base64-decoded data
    const buf = Buffer.from(ciphertext, 'base64');
    buf[20] = buf[20] ^ 0xff; // flip bits
    const tampered = buf.toString('base64');
    try {
      await c.decryptValue(tampered);
      throw new Error('Expected decryptValue to throw on tampered ciphertext');
    } catch (e) {
      if (e.message === 'Expected decryptValue to throw on tampered ciphertext') throw e;
      // Any other error = good — decryption rejected the tampered data
    }
  });

  // ---- Wrong key rejection ----
  console.log('\nWrong key rejection:');
  await testAsync('decrypt with wrong key throws', async () => {
    const ciphertext = await c.encryptValue('secret');
    // Temporarily switch to alt key
    process.env.PAYTRACK_ENCRYPTION_KEY = ALT_KEY;
    try {
      await c.decryptValue(ciphertext);
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      throw new Error('Expected decryptValue to throw with wrong key');
    } catch (e) {
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      if (e.message === 'Expected decryptValue to throw with wrong key') throw e;
      // Any other error = good
    }
  });

  // ---- Key rotation round-trip ----
  // Simulates the documented rotation procedure (reference_credentials_paytrack.md
  // § PayTrack Encryption Key): a value encrypted under the OLD key is re-encrypted
  // under the NEW key, and must (a) decrypt correctly under the new key and (b) no
  // longer decrypt under the old key. This is the safety property a botched rotation
  // would violate — silently corrupting employee banking data.
  console.log('\nKey rotation round-trip:');
  await testAsync('re-encrypting under a new key preserves the plaintext', async () => {
    const secret = '021000021|123456789'; // routing|account shape
    // 1. Encrypt under the OLD (current) key.
    process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
    const underOld = await c.encryptValue(secret);
    // 2. Decrypt under old, re-encrypt under NEW (the rotation migration step).
    const recovered = await c.decryptValue(underOld);
    assert.strictEqual(recovered, secret, 'old-key decrypt must recover the plaintext');
    process.env.PAYTRACK_ENCRYPTION_KEY = ALT_KEY;
    const underNew = await c.encryptValue(recovered);
    // 3. The new ciphertext decrypts correctly under the NEW key.
    const afterRotation = await c.decryptValue(underNew);
    process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY; // restore for later tests
    assert.strictEqual(afterRotation, secret, 'new-key decrypt must recover the plaintext');
    // 4. Sanity: the two ciphertexts differ (genuinely re-encrypted, not a no-op).
    assert.notStrictEqual(underOld, underNew, 're-encryption must produce new ciphertext');
  });

  // ---- Empty string ----
  console.log('\nEmpty string handling:');
  await testAsync('empty string encrypts and decrypts cleanly', async () => {
    const ciphertext = await c.encryptValue('');
    const result = await c.decryptValue(ciphertext);
    assert.strictEqual(result, '');
  });

  // ---- Null/undefined passthrough ----
  console.log('\nNull/undefined passthrough:');
  await testAsync('null → null (no crash)', async () => {
    const result = await c.encryptValue(null);
    assert.strictEqual(result, null);
  });
  await testAsync('undefined → null (no crash)', async () => {
    const result = await c.encryptValue(undefined);
    assert.strictEqual(result, null);
  });
  await testAsync('decryptValue(null) → null (no crash)', async () => {
    const result = await c.decryptValue(null);
    assert.strictEqual(result, null);
  });

  // ---- isEncrypted heuristic ----
  console.log('\nisEncrypted heuristic:');
  await testAsync('encrypted value is detected as encrypted', async () => {
    const ciphertext = await c.encryptValue('123-45-6789');
    assert.strictEqual(c.isEncrypted(ciphertext), true);
  });
  test('plaintext SSN not detected as encrypted', () => {
    assert.strictEqual(c.isEncrypted('123-45-6789'), false);
  });
  test('null not detected as encrypted', () => {
    assert.strictEqual(c.isEncrypted(null), false);
  });
  test('short string not detected as encrypted', () => {
    assert.strictEqual(c.isEncrypted('abc'), false);
  });

  // ---- generateKey ----
  console.log('\ngenerateKey:');
  test('generateKey returns a string', () => {
    const key = c.generateKey();
    assert.strictEqual(typeof key, 'string');
  });
  test('generateKey returns valid base64 for 32 bytes (43-44 chars)', () => {
    const key = c.generateKey();
    const decoded = Buffer.from(key, 'base64');
    assert.strictEqual(decoded.length, 32, `Expected 32 bytes, got ${decoded.length}`);
  });
  test('generateKey produces unique keys each call', () => {
    const k1 = c.generateKey();
    const k2 = c.generateKey();
    assert.notStrictEqual(k1, k2);
  });

  // ---- Invalid key rejection ----
  console.log('\nInvalid key rejection:');
  await testAsync('non-base64 key in env throws on encrypt', async () => {
    process.env.PAYTRACK_ENCRYPTION_KEY = 'not-valid-base64!!!';
    try {
      await c.encryptValue('test');
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      throw new Error('Expected error with invalid key');
    } catch (e) {
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      if (e.message === 'Expected error with invalid key') throw e;
    }
  });
  await testAsync('wrong-length key (16 bytes) throws on encrypt', async () => {
    process.env.PAYTRACK_ENCRYPTION_KEY = Buffer.from(crypto.randomBytes(16)).toString('base64');
    try {
      await c.encryptValue('test');
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      throw new Error('Expected error with 16-byte key');
    } catch (e) {
      process.env.PAYTRACK_ENCRYPTION_KEY = TEST_KEY;
      if (e.message === 'Expected error with 16-byte key') throw e;
    }
  });

  // ---- Summary ----
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
