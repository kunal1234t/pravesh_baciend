'use strict';

const crypto = require('crypto');
const base62 = require('../../qr-token/base62');
const redisClient = require('../../redis-client');
const nightCompliance = require('../../night-compliance');

module.exports = {
  // Staff (Warden/Guard): list all EXITED exit-requests (students currently outside)
  async listExited(ctx) {
    try {
      const fullUser = await nightCompliance.verifyUserFromAuthHeader(
        ctx.request.headers.authorization
      );
      if (!fullUser) {
        return ctx.unauthorized('Invalid or expired token');
      }
      if (!nightCompliance.isStaffRole(fullUser?.role?.name)) {
        return ctx.forbidden('Only wardens and guards can view this list');
      }

      const classified = await nightCompliance.fetchOutsideStudentsWithClassification();

      return ctx.send({
        data: classified.students,
        summary: classified.summary,
      });
    } catch (err) {
      console.error('❌ listExited ERROR:', err);
      return ctx.internalServerError('Failed to fetch exited students');
    }
  },

  async outsideSummary(ctx) {
    try {
      const fullUser = await nightCompliance.verifyUserFromAuthHeader(
        ctx.request.headers.authorization
      );
      if (!fullUser) {
        return ctx.unauthorized('Invalid or expired token');
      }
      if (!nightCompliance.isStaffRole(fullUser?.role?.name)) {
        return ctx.forbidden('Only wardens and guards can view this summary');
      }

      const classified = await nightCompliance.fetchOutsideStudentsWithClassification();
      return ctx.send(classified.summary);
    } catch (err) {
      console.error('❌ outsideSummary ERROR:', err);
      return ctx.internalServerError('Failed to fetch outside summary');
    }
  },

  async create(ctx) {
    try {
      console.log("🔥 EXIT REQUEST API HIT");

      const { user } = ctx.state;
      const { reason } = ctx.request.body;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      if (!reason) {
        return ctx.badRequest('Reason is required');
      }

      // ── Rate Limit: 5 exit QR requests per student per minute ──
      const rlAllowed = await redisClient.checkRateLimit(`rl:exit:${user.id}`, 5, 60);
      if (!rlAllowed) {
        console.warn(`🚇 Rate limit hit on exit QR for user ${user.id}`);
        return ctx.tooManyRequests('Too many requests. Please wait before generating another QR.');
      }

      // ── Input Validation: Prevent large payload abuse ──
      if (typeof reason !== 'string' || reason.length > 500) {
        return ctx.badRequest('Reason must be a string under 500 characters');
      }

      // 1. Verify User Role
      const fullUser = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        user.id,
        { populate: ['role'] }
      );

      if (!fullUser || fullUser.role.name !== 'Student') {
        return ctx.forbidden('Only students can create exit requests');
      }

      // Check if current time is within restricted hours (10 PM - 5 AM IST)
      const now = new Date();
      const istHour = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
      const hour = parseInt(istHour, 10);

      // Local testing only: production remains locked unless this environment
      // variable is deliberately enabled.
      const allowNightQrTesting = process.env.ALLOW_NIGHT_QR_TESTING === 'true';
      if (!allowNightQrTesting && (hour >= 22 || hour < 5)) {
        console.log(`⚠️ Exit blocked during night hours (${hour}:00 IST).`);
        return ctx.forbidden('Gate is locked. Exit requests are not permitted between 10 PM and 5 AM.');
      }

      // 2. ⚡ OPTIMIZED: Check only latest record for active exit (O(1) with index)
      console.log(`🔍 Checking for existing exit requests for student ${user.id}...`);

      const latestRequest = await strapi.entityService.findMany(
        'api::exit-request.exit-request',
        {
          filters: { student: user.id },
          sort: { createdAt: 'desc' },
          limit: 1,
        }
      );

      if (latestRequest && latestRequest.length > 0) {
        const latest = latestRequest[0];

        // Case 1: Latest is PENDING and NOT expired → Block (already active)
        if (latest.statuse === 'PENDING' && new Date(latest.expiresAt) > now) {
          return ctx.badRequest('You already have a valid pending QR code. Scan it at the gate.');
        }

        // Case 2: Latest is APPROVED → Block (already approved to exit)
        if (latest.statuse === 'APPROVED') {
          return ctx.badRequest('You already have an approved exit request. Please use the existing QR code at the gate.');
        }

        // Case 3: Latest is EXITED but NOT ENTERED yet → Block (student still outside)
        if (latest.statuse === 'EXITED') {
          return ctx.badRequest('You are already marked as OUTSIDE. Please generate an Entry QR first.');
        }
      }

      // 3. Generate Security Token (Base62)
      const qrToken = base62.generateToken();
      console.log(`✅ Generated Exit QR Token successfully`);

      const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2-minute window

      // 4. Create Exit Request
      const exitRequest = await strapi.entityService.create(
        'api::exit-request.exit-request',
        {
          data: {
            student: user.id,
            reasonType: reason,
            statuse: 'PENDING',
            expiresAt: expiresAt,
          },
        }
      );

      console.log("✅ EXIT REQUEST CREATED:", exitRequest.id);

      // 5. Create and link QR Token with hash
      const tokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');

      await strapi.entityService.create('api::qr-token.qr-token', {
        data: {
          token: qrToken,
          hash: tokenHash,
          expires_at: expiresAt,
          consumed: false,
          exit_requests: exitRequest.id,
        },
      });

      // 6. ── ATOMIC: Write QR token to Redis for race-condition-safe validation ──
      const ttlSeconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);

      const stored = await redisClient.storeQrToken(qrToken, {
        exitRequestId: exitRequest.id,
        studentId: user.id,
        statuse: 'PENDING',
        expiresAt: expiresAt.toISOString(),
      }, ttlSeconds);

      if (stored) {
        console.log(`✅ QR token written to Redis with ${ttlSeconds}s TTL`);
      } else {
        console.warn('⚠️ Redis write failed — DB-only validation will be used');
      }

      // 7. Set Redis TTL key for exit request auto-rejection
      const expirySet = await redisClient.setExitExpiry(exitRequest.id, ttlSeconds);
      if (expirySet) {
        console.log(`⏱️ Redis TTL Set: Exit Request ${exitRequest.id} will auto-reject in ${ttlSeconds}s`);
      } else {
        console.warn(`⚠️ Redis TTL not set for ${exitRequest.id}: Cron job will handle cleanup`);
      }

      // 8. Success Response
      return {
        exitRequestId: exitRequest.id,
        qr: qrToken,
        expiresAt: expiresAt.toISOString(),
      };

    } catch (err) {
      console.error("❌ EXIT REQUEST ERROR:", err);
      return ctx.internalServerError(`Exit request creation failed: ${err.message}`);
    }
  },

  /**
   * @param {import('koa').ParameterizedContext} ctx
   */
  async createEntry(ctx) {
    try {
      console.log("🔥 CREATE ENTRY QR API HIT");
      const { user } = ctx.state;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // ── Rate Limit: 5 entry QR requests per student per minute ──
      const rlAllowed = await redisClient.checkRateLimit(`rl:entry:${user.id}`, 5, 60);
      if (!rlAllowed) {
        console.warn(`🚇 Rate limit hit on entry QR for user ${user.id}`);
        return ctx.tooManyRequests('Too many requests. Please wait before generating another QR.');
      }

      const now = new Date();
      const isNightWindow = nightCompliance.isNightWindow();

      // An entry QR is valid only after the exit QR has been consumed.
      // ⚡ limit:1 prevents full-table scan even with 1000s of historical records
      const activeExit = await strapi.db
        .query('api::exit-request.exit-request')
        .findOne({
          where: {
            student: user.id,
            statuse: 'EXITED',
          },
          orderBy: { createdAt: 'desc' },
          limit: 1,
        });

      if (!activeExit) {
        return ctx.badRequest('No active exit found. You must exit first to generate an entry QR.');
      }

      console.log(`✅ Found active exit: ${activeExit.id} (Status: ${activeExit.statuse})`);

      if (isNightWindow) {
        const lateEntry = await strapi.db
          .query('api::late-entry-request.late-entry-request')
          .findOne({
            where: {
              users_permissions_user: user.id,
              stat: 'approved',
            },
            orderBy: { createdAt: 'desc' },
          });

        if (!lateEntry) {
          return ctx.forbidden('Late night approval required to enter the campus.');
        }

        const validUntil = lateEntry.validUntil
          ? new Date(lateEntry.validUntil)
          : lateEntry.expectedreturntime
            ? new Date(new Date(lateEntry.expectedreturntime).getTime() + 60 * 60 * 1000)
            : null;
        const adminOverride = lateEntry.adminOverride === true;
        if (!adminOverride && (!validUntil || now > validUntil)) {
          return ctx.forbidden('Late night approval has expired.');
        }
      }

      // Generate token (Base62)
      const qrToken = base62.generateToken();
      console.log(`✅ Generated Entry QR Token successfully`);

      const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

      // Create QR Token linked to the SAME exit request
      await strapi.entityService.create('api::qr-token.qr-token', {
        data: {
          token: qrToken,
          expires_at: expiresAt,
          consumed: false,
          exit_requests: [activeExit.id],
        },
      });

      // ── ATOMIC: Write QR token to Redis for race-condition-safe validation ──
      const ttlSeconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);

      const stored = await redisClient.storeQrToken(qrToken, {
        exitRequestId: activeExit.id,
        studentId: user.id,
        statuse: activeExit.statuse, // 'EXITED' → will become ENTERED
        expiresAt: expiresAt.toISOString(),
      }, ttlSeconds);

      if (stored) {
        console.log(`✅ Entry QR token written to Redis with ${ttlSeconds}s TTL`);
      }

      console.log("✅ ENTRY QR TOKEN CREATED for Exit Request:", activeExit.id);

      // Preserve the response shape expected by clients using the legacy
      // /exit-requests/entry-qr alias while sharing this Redis-backed flow.
      if (ctx.path.endsWith('/exit-requests/entry-qr')) {
        return {
          exitRequestId: activeExit.id,
          qr: {
            t: qrToken,
            e: expiresAt.toISOString(),
          },
        };
      }

      return {
        exitRequestId: activeExit.id,
        qr: qrToken,
      };

    } catch (err) {
      console.error("❌ CREATE ENTRY ERROR:", err);
      return ctx.internalServerError('Entry QR creation failed');
    }
  },

  /**
   * Fetches the latest exit request for the authenticated user.
   * If the request is still PENDING and valid, generates a NEW QR token for it.
   * ⚡ OPTIMIZED: Uses indexed query for O(1) lookup
   * @param {import('koa').ParameterizedContext} ctx
   */
  async latest(ctx) {
    try {
      console.log("🔍 LATEST EXIT REQUEST API HIT");
      const authUser =
        ctx.state.user ||
        (await nightCompliance.verifyUserFromAuthHeader(
          ctx.request.headers.authorization
        ));

      if (!authUser) {
        return ctx.unauthorized('Authentication required');
      }

      // ── IDOR Protection: Only query the authenticated user's own data ──
      // ctx.state.user is set by Strapi's auth middleware from the JWT,
      // so this is already scoped. No req.params.studentId to abuse.

      const latestRequest = await strapi.db.query('api::exit-request.exit-request')
        .findOne({
          select: ['id', 'statuse', 'expiresAt', 'createdAt', 'reasonType'],
          where: { student: authUser.id },
          orderBy: { createdAt: 'DESC' },
        });

      if (!latestRequest) {
        return ctx.notFound('No exit request found');
      }

      const now = new Date();
      const expiry = new Date(latestRequest.expiresAt);
      let qrData = null;

      // Logic for PENDING requests
      if (latestRequest.statuse === 'PENDING') {
        if (now > expiry) {
          // ⏰ EXPIRED: Mark REJECTED and immediately clean up the linked QR token row
          const updated = await strapi.entityService.update('api::exit-request.exit-request', latestRequest.id, {
            data: { statuse: 'REJECTED' }
          });

          // ── Fix #4: Inline QR token cleanup on expiry detection ──
          // Delete the expired token row immediately so it never bloats qr_tokens table
          try {
            await strapi.db.query('api::qr-token.qr-token').deleteMany({
              where: {
                exit_requests: latestRequest.id,
                consumed: false,
              },
            });
            console.log(`🗑️  Cleaned up expired QR tokens for exit request ${latestRequest.id}`);
          } catch (cleanupErr) {
            // Non-critical — cron job will catch it later
            console.warn(`⚠️ Inline QR cleanup failed for ${latestRequest.id}:`, cleanupErr.message);
          }

          return {
            id: updated.id,
            reason: updated.reasonType,
            statuse: 'REJECTED',
            expiresAt: updated.expiresAt,
            qr: null,
          };
        } else {
          // ✅ STILL VALID: Generate a new token so the student can scan
          const qrToken = base62.generateToken();

          await strapi.entityService.create('api::qr-token.qr-token', {
            data: {
              token: qrToken,
              expires_at: latestRequest.expiresAt,
              consumed: false,
              exit_requests: [latestRequest.id],
            },
          });

          // Also write to Redis for atomic validation
          const ttlSeconds = Math.ceil((expiry.getTime() - Date.now()) / 1000);
          await redisClient.storeQrToken(qrToken, {
            exitRequestId: latestRequest.id,
            studentId: authUser.id,
            statuse: 'PENDING',
            expiresAt: latestRequest.expiresAt,
          }, ttlSeconds);

          qrData = qrToken;
        }
      }

      // Build response matching Flutter's expected format
      return {
        id: latestRequest.id,
        reason: latestRequest.reasonType,
        statuse: latestRequest.statuse,
        expiresAt: latestRequest.expiresAt,
        createdAt: latestRequest.createdAt,
        qr: qrData,
      };

    } catch (err) {
      console.error("❌ LATEST REQUEST ERROR:", err);
      return ctx.internalServerError('Failed to fetch latest request');
    }
  },
};
