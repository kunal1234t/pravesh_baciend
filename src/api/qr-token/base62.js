'use strict';

/**
 * Base62 Encoding/Decoding Utility
 * Alphabet: 0-9, a-z, A-Z (62 characters)
 * Use case: Convert random bytes to human-readable, QR-friendly tokens
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = ALPHABET.length; // 62

/**
 * Encode a Buffer to Base62 string
 * @param {Buffer} buffer - Input buffer
 * @returns {string} Base62 encoded string
 */
function encode(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Buffer cannot be empty');
  }

  let num = 0n;
  for (let i = 0; i < buffer.length; i++) {
    num = (num << 8n) | BigInt(buffer[i]);
  }

  if (num === 0n) {
    return ALPHABET[0];
  }

  let result = '';
  while (num > 0n) {
    result = ALPHABET[Number(num % BigInt(BASE))] + result;
    num = num / BigInt(BASE);
  }

  return result;
}

/**
 * Decode a Base62 string back to Buffer
 * @param {string} str - Base62 encoded string
 * @returns {Buffer} Decoded buffer
 */
function decode(str) {
  if (!str || str.length === 0) {
    throw new Error('String cannot be empty');
  }

  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const digit = ALPHABET.indexOf(str[i]);
    if (digit === -1) {
      throw new Error(`Invalid character in Base62 string: ${str[i]}`);
    }
    num = num * BigInt(BASE) + BigInt(digit);
  }

  // Convert BigInt to Buffer
  if (num === 0n) {
    return Buffer.from([0]);
  }

  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xFFn));
    num = num >> 8n;
  }

  return Buffer.from(bytes);
}

/**
 * Generate a short, unique token (8 bytes = 10-12 chars in Base62)
 * @returns {string} 10-12 character Base62 token
 */
function generateToken() {
  const crypto = require('crypto');
  const randomBytes = crypto.randomBytes(8); // 8 bytes = 64 bits (guaranteed 10+ chars)
  const encoded = encode(randomBytes);
  // Pad to minimum 10 characters if needed
  return encoded.length >= 10 ? encoded : encoded.padStart(10, '0');
}

/**
 * Validate if string is a valid Base62 token
 * @param {string} token - Token to validate
 * @returns {boolean} True if valid Base62 token
 */
function isValidToken(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  
  // Check length (8 bytes encodes to 10-12 base62 chars)
  if (token.length < 10 || token.length > 12) {
    return false;
  }

  // Check all characters are valid Base62
  for (let char of token) {
    if (ALPHABET.indexOf(char) === -1) {
      return false;
    }
  }

  return true;
}

module.exports = {
  encode,
  decode,
  generateToken,
  isValidToken,
  ALPHABET,
  BASE,
};
