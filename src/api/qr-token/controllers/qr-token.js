'use strict';

const crypto = require('crypto');
const base62 = require('../base62');
const redisClient = require('../../redis-client');
const nightCompliance = require('../../night-compliance');

const resolveValidUntil = (lateEntry) => {
  if (lateEntry?.validUntil) {
    return new Date(lateEntry.validUntil);
  }
  if (lateEntry?.expectedreturntime) {
    return new Date(new Date(lateEntry.expectedreturntime).getTime() + 60 * 60 * 1000);
  }
  return null;
};

const markLateEntryEntered = async (studentId) => {
  const approvedEntry = await strapi.db
    .query('api::late-entry-request.late-entry-request')
    .findOne({
      where: {
        users_permissions_user: studentId,
        stat: 'approved',
      },
      orderBy: { createdAt: 'desc' },
    });

  if (!approvedEntry) return;

  await strapi.entityService.update(
    'api::late-entry-request.late-entry-request',
    approvedEntry.id,
    {
      data: {
        stat: 'entered',
        enteredAt: new Date(),
      },
    }
  );
};

const enforceNightEntryRules = async (studentId) => {
  if (!nightCompliance.isNightWindow()) {
    return { allowed: true };
  }

  const lateEntry = await strapi.db.query('api::late-entry-request.late-entry-request').findOne({
    where: {
      users_permissions_user: studentId,
      stat: 'approved',
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!lateEntry) {
    return { allowed: false, reason: 'NIGHT_PASS_REQUIRED' };
  }

  const validUntil = resolveValidUntil(lateEntry);
  const adminOverride = lateEntry.adminOverride === true;
  if (!adminOverride && (!validUntil || new Date() > validUntil)) {
    return { allowed: false, reason: 'NIGHT_PASS_EXPIRED' };
  }

  return { allowed: true };
};

module.exports = {
  async validate(ctx) {
    try {
      console.log('🔥 QR VALIDATE API HIT');

      // ── Gate API Key Authentication ──
      // Hardware scanners must include this header to prevent unauthorized API calls
      const gateApiKey = ctx.request.headers['x-gate-api-key'];
      const expectedKey = process.env.GATE_API_KEY;
      if (expectedKey && gateApiKey !== expectedKey) {
        console.warn('🚨 SECURITY: QR validate called without valid gate API key');
        return ctx.unauthorized('Invalid gate credentials');
      }

      let { token } = ctx.request.body;
      console.log("🔥 RECEIVED QR TOKEN:", JSON.stringify(token));

      if (!token) return ctx.badRequest('Token is required');

      // ── MASTER QR: Reusable override tokens (never consumed, bypass all checks) ──
      const masterTokens = (process.env.MASTER_QR_TOKENS || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      if (masterTokens.length > 0 && masterTokens.includes(token)) {
        console.log('🔑 MASTER QR VALIDATED:', token);
        return {
          allowed: true,
          action: 'master',
          BTID: 'MASTER_ACCESS',
          name: 'Authorized Personnel',
          reason: 'Master QR Override',
          is_out: false,
          timestamp: new Date().toISOString(),
        };
      }

      // ── Normal flow continues below (untouched) ──

      // Validate token format (Base62, 10-12 chars)
      if (!base62.isValidToken(token)) {
        console.warn(`⚠️ Invalid token format: ${token}`);
        return ctx.badRequest('Invalid token format. Expected 10-12 character Base62 token.');
      }

      // ── ATOMIC VALIDATION: Try Redis first ──
      // Redis MULTI ensures only ONE scanner gets the data.
      // If two guards scan the same QR simultaneously, the second one
      // sees delCount === 0 and gets rejected immediately.
      const redisData = await redisClient.burnQrToken(token);

      if (redisData) {
        // Token was found and atomically deleted from Redis — this scanner wins
        console.log('✅ Redis atomic burn succeeded for token:', token);

        const { exitRequestId, studentId, statuse } = redisData;

        // Determine action
        const isExit = statuse === 'PENDING';
        const isEntry = statuse === 'EXITED';

        if (!isExit && !isEntry) {
          return ctx.badRequest(`Invalid Exit Request statuse: ${statuse}`);
        }

        if (isEntry) {
          const nightCheck = await enforceNightEntryRules(studentId);
          if (!nightCheck.allowed) {
            return ctx.forbidden(nightCheck.reason);
          }
          await markLateEntryEntered(studentId);
        }

        // Update exit request status in database
        const updateData = {};
        if (isExit) {
          updateData.statuse = 'EXITED';
          updateData.consumedAt = new Date().toISOString();
        } else {
          updateData.statuse = 'ENTERED';
          updateData.entryTime = new Date().toISOString();
        }

        try {
          await strapi.entityService.update(
            'api::exit-request.exit-request',
            exitRequestId,
            { data: updateData }
          );
          console.log(`✅ Exit request ${exitRequestId} updated to ${updateData.statuse}`);
        } catch (updateError) {
          console.error('❌ FAILED to update ExitRequest:', updateError);
        }

        // Mark QR token as consumed in database (idempotent)
        try {
          const qrTokenRecords = await strapi.entityService.findMany(
            'api::qr-token.qr-token',
            { filters: { token }, limit: 1 }
          );
          if (qrTokenRecords && qrTokenRecords.length > 0) {
            await strapi.entityService.update(
              'api::qr-token.qr-token',
              qrTokenRecords[0].id,
              {
                data: {
                  consumed: true,
                  consumedAt: new Date(),
                  consumed_by: 'gate',
                },
              }
            );
          }
        } catch (consumeError) {
          console.error('❌ FAILED to mark QR as consumed in DB:', consumeError);
        }

        // Fetch student info for response
        let studentEmail = '';
        let studentName = '';
        let exitReason = '';
        try {
          const student = await strapi.entityService.findOne(
            'plugin::users-permissions.user',
            studentId
          );
          studentEmail = student?.email || '';
          studentName = student?.username || '';

          const exitReq = await strapi.entityService.findOne(
            'api::exit-request.exit-request',
            exitRequestId
          );
          exitReason = exitReq?.reasonType || '';
        } catch (e) {
          // Non-critical, response still works
        }

        // Emit event for frontend
        if (strapi.io) {
          console.log(`📢 Emitting qr-validated to user:${studentId} for token:`, token);
          strapi.io?.to(`user:${studentId}`).emit('qr-validated', {
            qrToken: token,
            allowed: true,
            action: isExit ? 'exit' : 'entry',
            timestamp: new Date().toISOString()
          });
        }
        await nightCompliance.emitOutsideStudentStatusUpdated(studentId);

        return {
          allowed: true,
          action: isExit ? 'exit' : 'entry',
          BTID: studentEmail,
          name: studentName,
          reason: exitReason,
          is_out: isExit,
          timestamp: new Date().toISOString(),
        };
      }

      // ── FALLBACK: Redis unavailable or token not in Redis ──
      // Fall back to database-based validation (original logic)
      console.log('⚠️ Redis miss, falling back to database validation for token:', token);

      const qrToken = await strapi.entityService.findMany(
        'api::qr-token.qr-token',
        {
          filters: { token: token },
          populate: { exit_requests: { populate: ['student'] } },
          limit: 1
        }
      );

      if (!qrToken || qrToken.length === 0) {
        console.warn(`⚠️ QR Token not found in database: ${token}`);
        return ctx.notFound('Invalid QR token');
      }

      const tokenRecord = qrToken[0];

      if (tokenRecord.consumed) return ctx.badRequest('QR already used');

      if (new Date(tokenRecord.expires_at) < new Date()) {
        console.log('❌ QR Expired');
        return ctx.badRequest('QR expired');
      }

      // Get exit request with student info
      let exitRequest = null;
      if (Array.isArray(tokenRecord.exit_requests)) {
        if (tokenRecord.exit_requests.length === 0) {
          return ctx.badRequest('Exit request not found');
        }
        exitRequest = tokenRecord.exit_requests[0];
      } else if (tokenRecord.exit_requests) {
        exitRequest = tokenRecord.exit_requests;
      }

      if (!exitRequest) {
        return ctx.badRequest('Exit request not found');
      }

      const student = exitRequest.student;
      if (!student) {
        return ctx.badRequest('Student not associated with exit request');
      }

      // Detect entry vs exit
      const isExit = exitRequest.statuse === 'PENDING';
      const isEntry = exitRequest.statuse === 'EXITED';

      if (!isExit && !isEntry) {
        return ctx.badRequest(`Invalid Exit Request statuse: ${exitRequest.statuse}`);
      }

      if (isEntry) {
        const nightCheck = await enforceNightEntryRules(student.id);
        if (!nightCheck.allowed) {
          return ctx.forbidden(nightCheck.reason);
        }
        await markLateEntryEntered(student.id);
      }

      const updateData = {};
      if (isExit) {
        updateData.statuse = 'EXITED';
      } else {
        updateData.statuse = 'ENTERED';
        updateData.entryTime = new Date();
      }

      try {
        await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          { data: updateData }
        );
      } catch (updateError) {
        console.error('❌ FAILED to update ExitRequest:', updateError);
      }

      // Mark QR token as consumed
      try {
        await strapi.entityService.update(
          'api::qr-token.qr-token',
          tokenRecord.id,
          {
            data: {
              consumed: true,
              consumedAt: new Date(),
              consumed_by: 'gate',
            },
          }
        );
      } catch (consumeError) {
        console.error('❌ FAILED to mark QR as consumed:', consumeError);
      }

      // Emit event for frontend
      if (strapi.io) {
        const studentId = student.id;
        strapi.io?.to(`user:${studentId}`).emit('qr-validated', {
          qrToken: token,
          allowed: true,
          action: isExit ? 'exit' : 'entry',
          timestamp: new Date().toISOString()
        });
      }
      await nightCompliance.emitOutsideStudentStatusUpdated(student.id);

      return {
        allowed: true,
        action: isExit ? 'exit' : 'entry',
        BTID: student.email,
        name: student.username,
        reason: exitRequest.reason,
        is_out: isExit,
        timestamp: new Date().toISOString(),
      };

    } catch (err) {
      console.error('❌ QR VALIDATE ERROR:', err);
      return ctx.internalServerError('QR validation failed');
    }
  },
  async forceStatus(ctx) {
    try {
      console.log('🔥 GUARD OVERRIDE API HIT');

      // ── Gate API Key Authentication ──
      const gateApiKey = ctx.request.headers['x-gate-api-key'];
      const expectedKey = process.env.GATE_API_KEY;
      if (!expectedKey || gateApiKey !== expectedKey) {
        console.warn('🚨 SECURITY: Guard override called without valid gate API key');
        return ctx.unauthorized('Invalid gate credentials');
      }

      const { btid, action } = ctx.request.body;
      if (!btid || !action) {
        return ctx.badRequest('btid and action are required');
      }

      if (action !== 'entry' && action !== 'exit') {
        return ctx.badRequest('action must be either "entry" or "exit"');
      }

      // 1. Find the student
      const users = await strapi.db.query('plugin::users-permissions.user').findMany({
        where: { email: btid },
        limit: 1
      });

      if (users.length === 0) {
        return ctx.notFound(`Student with BTID ${btid} not found`);
      }
      const student = users[0];

      // 2. Enforce Night Entry Rules if it is an Entry
      if (action === 'entry') {
        const nightCheck = await enforceNightEntryRules(student.id);
        if (!nightCheck.allowed) {
           return ctx.forbidden(nightCheck.reason);
        }
        await markLateEntryEntered(student.id);
      }

      // 3. Update or Create Exit Request
      let exitReason = 'Guard Manual Override';
      
      if (action === 'exit') {
        // Just create a new EXITED request
        await strapi.entityService.create('api::exit-request.exit-request', {
          data: {
            student: student.id,
            statuse: 'EXITED',
            reasonType: exitReason,
            consumedAt: new Date().toISOString()
          }
        });
      } else {
        // Entry: Try to find an active EXITED request
        const activeExit = await strapi.db.query('api::exit-request.exit-request').findOne({
          where: { student: student.id, statuse: 'EXITED' },
          orderBy: { createdAt: 'desc' }
        });

        if (activeExit) {
          exitReason = activeExit.reasonType;
          await strapi.entityService.update('api::exit-request.exit-request', activeExit.id, {
            data: {
              statuse: 'ENTERED',
              entryTime: new Date().toISOString()
            }
          });
        } else {
           // Sneaking in? Just create a forced ENTERED request
           await strapi.entityService.create('api::exit-request.exit-request', {
            data: {
              student: student.id,
              statuse: 'ENTERED',
              reasonType: 'Guard Forced Entry',
              entryTime: new Date().toISOString()
            }
          });
        }
      }

      // Emit event for frontend
      if (strapi.io) {
        strapi.io?.to(`user:${student.id}`).emit('qr-validated', {
          qrToken: 'manual_override',
          allowed: true,
          action: action,
          timestamp: new Date().toISOString()
        });
      }
      
      // Notify night compliance engine
      await nightCompliance.emitOutsideStudentStatusUpdated(student.id);

      return {
        allowed: true,
        action: action,
        BTID: student.email,
        name: student.username,
        reason: exitReason,
        is_out: action === 'exit',
        timestamp: new Date().toISOString(),
      };

    } catch (err) {
      console.error('❌ GUARD OVERRIDE ERROR:', err);
      return ctx.internalServerError('Guard override failed');
    }
  },
};
