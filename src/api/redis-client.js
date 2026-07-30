'use strict';

/**
 * Shared Redis Client (Singleton)
 * 
 * Provides a single, reusable Redis connection for the entire app.
 * Prevents connection leaks from creating new instances per request.
 * Supports password authentication via REDIS_URL env var.
 */

let _client = null;

function getClient() {
  // ioredis manages reconnects internally. Once created, always reuse this
  // instance—even while it is connecting or reconnecting.
  if (_client) {
    return _client;
  }

  try {
    const Redis = require('ioredis');
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    _client = new Redis(redisUrl, {
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    _client.on('ready', () => {
      console.log('✅ Shared Redis client connected');
    });

    _client.on('error', (err) => {
      // Suppress noisy connection errors in logs
      if (err.code !== 'ECONNREFUSED') {
        console.warn('⚠️ Redis client error:', err.message);
      }
    });

    _client.on('reconnecting', () => {
      console.log('🔄 Shared Redis client reconnecting');
    });

    return _client;
  } catch (err) {
    console.warn('⚠️ Redis client creation failed:', err.message);
    return null;
  }
}

/**
 * Store a QR token in Redis with TTL for atomic validation
 * @param {string} token - The QR token string
 * @param {object} data - Data to store (exit request info)
 * @param {number} ttlSeconds - Time to live in seconds
 */
async function storeQrToken(token, data, ttlSeconds) {
  const client = getClient();
  if (!client) return false;

  try {
    await client.set(
      `qr:${token}`,
      JSON.stringify(data),
      'EX',
      ttlSeconds
    );
    return true;
  } catch (err) {
    console.warn(`⚠️ Redis storeQrToken failed: ${err.message}`);
    return false;
  }
}

/**
 * Atomically read-and-delete a QR token from Redis
 * Uses MULTI/EXEC to ensure only ONE scanner gets the token data
 * 
 * @param {string} token - The QR token to burn
 * @returns {object|null} - Token data if valid, null if already consumed/expired
 */
async function burnQrToken(token) {
  const client = getClient();
  if (!client) return null;

  try {
    // MULTI ensures atomicity: if two guards scan simultaneously,
    // only one gets the data (the other sees delCount === 0)
    const results = await client.multi()
      .get(`qr:${token}`)
      .del(`qr:${token}`)
      .exec();

    // results = [[null, 'data_string'], [null, 1]]
    // results[0][1] = GET result, results[1][1] = DEL result (count)
    if (!results || results.length < 2) return null;

    const [getErr, tokenData] = results[0];
    const [delErr, delCount] = results[1];

    if (getErr || delErr) {
      console.error('❌ Redis MULTI error:', getErr || delErr);
      return null;
    }

    // If tokenData is null → token didn't exist (expired or never stored)
    // If delCount is 0 → another scanner already deleted it (race lost)
    if (!tokenData || delCount === 0) {
      return null;
    }

    return JSON.parse(tokenData);
  } catch (err) {
    console.warn(`⚠️ Redis burnQrToken failed: ${err.message}`);
    return null;
  }
}

/**
 * Set an expiry key for exit request auto-rejection
 * @param {number} requestId - Exit request ID
 * @param {number} ttlSeconds - Seconds until expiry
 */
async function setExitExpiry(requestId, ttlSeconds) {
  const client = getClient();
  if (!client) return false;

  try {
    await client.set(`exit_expiry:${requestId}`, 'active', 'EX', ttlSeconds);
    return true;
  } catch (err) {
    console.warn(`⚠️ Redis setExitExpiry failed: ${err.message}`);
    return false;
  }
}

/**
 * Set a key-value pair with TTL (in seconds)
 * Used for OTP storage
 *
 * @param {string} key - Redis key
 * @param {number} ttlSeconds - Time to live in seconds
 * @param {string} value - Value to store
 * @returns {Promise<boolean>} - Success/failure
 */
async function setex(key, ttlSeconds, value) {
  const client = getClient();
  if (!client) return false;

  try {
    await client.setex(key, ttlSeconds, value);
    return true;
  } catch (err) {
    console.warn(`⚠️ Redis setex failed for key ${key}: ${err.message}`);
    return false;
  }
}

/**
 * Get a value from Redis
 * Used for OTP retrieval and rate limiting
 *
 * @param {string} key - Redis key
 * @returns {Promise<string|null>} - Value or null if not found
 */
async function get(key) {
  const client = getClient();
  if (!client) return null;

  try {
    return await client.get(key);
  } catch (err) {
    console.warn(`⚠️ Redis get failed for key ${key}: ${err.message}`);
    return null;
  }
}

/**
 * Atomically check OTP and delete it (check-and-delete pattern)
 * Uses MULTI/EXEC to ensure only one verification succeeds
 *
 * @param {string} key - Redis key (otp_verify:email or otp_reset:email)
 * @param {string} expectedValue - Expected OTP value
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function checkAndDelete(key, expectedValue) {
  const client = getClient();
  if (!client) {
    return {
      success: false,
      message: 'Redis client unavailable',
    };
  }

  try {
    // Atomic transaction: GET then check value, then DELETE
    const results = await client.multi()
      .get(key)
      .del(key)
      .exec();

    if (!results || results.length < 2) {
      return {
        success: false,
        message: 'Redis transaction failed',
      };
    }

    const [getErr, storedOtp] = results[0];
    const [delErr, delCount] = results[1];

    if (getErr || delErr) {
      console.error('❌ Redis MULTI error:', getErr || delErr);
      return {
        success: false,
        message: 'Redis transaction error',
      };
    }

    // OTP not found = expired or never stored
    if (!storedOtp) {
      return {
        success: false,
        message: 'OTP not found or expired',
      };
    }

    // OTP doesn't match
    if (storedOtp !== expectedValue) {
      return {
        success: false,
        message: 'Invalid OTP',
      };
    }

    // OTP already consumed by another request (delCount = 0)
    // This is a race condition where another request consumed it first
    if (delCount === 0) {
      return {
        success: false,
        message: 'OTP already used',
      };
    }

    // Success - OTP matched and was deleted
    return {
      success: true,
      message: 'OTP verified',
    };
  } catch (err) {
    console.warn(`⚠️ Redis checkAndDelete failed: ${err.message}`);
    return {
      success: false,
      message: 'Failed to verify OTP',
    };
  }
}

/**
 * Redis-based rate limiter — sliding window counter.
 * Returns true if the request is ALLOWED, false if RATE LIMITED.
 *
 * @param {string} key     - Unique key e.g. `rl:login:user@email.com`
 * @param {number} limit   - Max requests allowed in the window
 * @param {number} windowSec - Window size in seconds
 */
async function checkRateLimit(key, limit = 10, windowSec = 60) {
  const client = getClient();
  // If Redis is unavailable, allow all requests (fail open)
  if (!client || client.status !== 'ready') return true;

  try {
    const current = await client.incr(key);
    if (current === 1) {
      // First request in window — set the expiry
      await client.expire(key, windowSec);
    }
    return current <= limit;
  } catch (err) {
    console.warn(`⚠️ Rate limit check failed for ${key}:`, err.message);
    return true; // Fail open on Redis error
  }
}

module.exports = {
  getClient,
  storeQrToken,
  burnQrToken,
  setExitExpiry,
  get,
  setex,
  checkAndDelete,
  checkRateLimit,
};
