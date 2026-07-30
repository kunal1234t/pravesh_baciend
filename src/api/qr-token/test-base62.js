// Test script for 12-char Base62 QR tokens
// Run with: node src/api/qr-token/test-base62.js

const base62 = require('./base62');

console.log('\n=== Base62 QR Token System Tests ===\n');

// Test 1: Generate tokens
console.log('✅ Test 1: Token Generation');
for (let i = 0; i < 5; i++) {
  const token = base62.generateToken();
  console.log(`   Generated: ${token} (length: ${token.length})`);
}

// Test 2: Validate token format
console.log('\n✅ Test 2: Token Validation');
const validTokens = [
  base62.generateToken(),
  'A7xK2mN9pQ5R',
  'abcDEF1234567'
];
const invalidTokens = [
  'invalid!@#',
  '12345',  // too short
  'A7xK2mN9pQ5R_extra',  // too long
  '',
  null
];

console.log('Valid tokens:');
validTokens.forEach(token => {
  console.log(`   ${token}: ${base62.isValidToken(token) ? '✓' : '✗'}`);
});

console.log('\nInvalid tokens:');
invalidTokens.forEach(token => {
  console.log(`   ${token}: ${base62.isValidToken(token) ? '✗ FAILED' : '✓'}`);
});

// Test 3: Encode/Decode round-trip
console.log('\n✅ Test 3: Encode/Decode Round-trip');
const crypto = require('crypto');
for (let i = 0; i < 3; i++) {
  const original = crypto.randomBytes(6);
  const encoded = base62.encode(original);
  const decoded = base62.decode(encoded);
  const match = original.equals(decoded);
  console.log(`   ${match ? '✓' : '✗'} Original: ${original.toString('hex')}`);
  console.log(`      Encoded: ${encoded}`);
  console.log(`      Decoded: ${decoded.toString('hex')}`);
}

// Test 4: Token uniqueness (collision probability)
console.log('\n✅ Test 4: Token Uniqueness');
const tokens = new Set();
const collisions = [];
for (let i = 0; i < 10000; i++) {
  const token = base62.generateToken();
  if (tokens.has(token)) {
    collisions.push(token);
  }
  tokens.add(token);
}
console.log(`   Generated 10,000 tokens`);
console.log(`   Unique tokens: ${tokens.size}`);
console.log(`   Collisions: ${collisions.length}`);
console.log(`   Collision probability: ${(collisions.length / 10000 * 100).toFixed(2)}%`);

// Test 5: Token size
console.log('\n✅ Test 5: QR Code Size Improvement');
const newToken = base62.generateToken();
const oldToken = crypto.randomBytes(32).toString('hex');
console.log(`   Old token (SHA256 hex): ${oldToken.length} characters`);
console.log(`   New token (Base62):     ${newToken.length} characters`);
console.log(`   Size reduction: ${((1 - newToken.length / oldToken.length) * 100).toFixed(1)}%`);

console.log('\n=== All Tests Complete ===\n');
