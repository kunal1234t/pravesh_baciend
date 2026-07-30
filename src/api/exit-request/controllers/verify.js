'use strict';

const crypto = require('crypto');
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
  async verify(ctx) {
    try {
      const gateKey = ctx.request.headers['x-gate-key'];
      const { token } = ctx.request.body;

      // 1. Authenticate gate hardware
      if (!gateKey || gateKey !== process.env.GATE_API_KEY) {
        return ctx.unauthorized('INVALID_GATE');
      }

      if (!token) {
        return ctx.badRequest('TOKEN_REQUIRED');
      }

      // 2. Hash token
      const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      // 3. Find valid QR token
      const qrToken = await strapi.db
        .query('api::qr-token.qr-token')
        .findOne({
          where: {
            hash: tokenHash,
            consumed: false,
            expires_at: { $gt: new Date() },
          },
          populate: {
            exit_requests: {
              populate: { student: true },
            },
          },
        });

      if (!qrToken || !qrToken.exit_requests) {
        console.log(`❌ QR Token not found or no exit_request relationship. Token:`, qrToken);
        return ctx.badRequest('INVALID_OR_EXPIRED_QR');
      }

      const exitRequest = qrToken.exit_requests;

      if (exitRequest.statuse !== 'PENDING' && exitRequest.statuse !== 'EXITED') {
        return ctx.badRequest('INVALID_EXIT_STATE');
      }

      // 4. Atomic consume + update status
      const newStatus = exitRequest.statuse === 'PENDING' ? 'EXITED' : 'ENTERED';

      if (newStatus === 'ENTERED') {
        const nightCheck = await enforceNightEntryRules(exitRequest.student.id);
        if (!nightCheck.allowed) {
          return ctx.forbidden(nightCheck.reason);
        }
        await markLateEntryEntered(exitRequest.student.id);
      }
      
      await strapi.db.transaction(async () => {
        await strapi.db.query('api::qr-token.qr-token').update({
          where: { id: qrToken.id },
          data: {
            consumed: true,
            consumed_at: new Date(),
            consumed_by: 'GATE',
          },
        });

        const updateData = {
          statuse: newStatus,
          consumedAt: new Date().toISOString(),
        };
        
        // Set appropriate timestamp based on action
        if (newStatus === 'EXITED') {
          updateData.consumedAt = new Date().toISOString(); 
        } else if (newStatus === 'ENTERED') {
          updateData.entryTime = new Date().toISOString(); 
        }

        await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          { data: updateData }
        );
      });

      // 5. Emit socket event to frontend
      // Send the scanned token plaintext so frontend can match it against stored QR data
      const io = strapi.io;
      if (io) {
        io.to(`user:${exitRequest.student.id}`).emit('qr-validated', {
          qrToken: token,  // Plain token for matching
          allowed: true,
          action: newStatus === 'EXITED' ? 'exit' : 'entry',  // Use NEW status (after update)
          timestamp: new Date().toISOString(),
        });
      }
      await nightCompliance.emitOutsideStudentStatusUpdated(exitRequest.student.id);

      // 6. Optional audit log
      await strapi.entityService.create('api::scan-log.scan-log', {
        data: {
          exitRequest: exitRequest.id,
          result: 'verified',
          scannedAt: new Date(),
        },
      });

      // 7. Respond to hardware
      return ctx.send({
        verdict: 'VERIFIED',
        studentId: exitRequest.student,
      });
    } catch (err) {
      strapi.log.error(err);
      return ctx.internalServerError('VERIFICATION_FAILED');
    }
  },
};
    
