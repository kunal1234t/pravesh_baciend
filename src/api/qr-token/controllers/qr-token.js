'use strict';

const crypto = require('crypto');

module.exports = {
  async validate(ctx) {
    try {
      console.log('🔥 QR VALIDATE API HIT');

      const { token } = ctx.request.body;

      if (!token) return ctx.badRequest('Token is required');

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      console.log('HASH:', tokenHash);

      const qrToken = await strapi.db
        .query('api::qr-token.qr-token')
        .findOne({
          where: { hash: tokenHash }, // ✅ correct field
          populate: {
            exit_requests: {
              populate: ['student'],
            },
          },
        });

      console.log('QR TOKEN:', qrToken);

      if (!qrToken) return ctx.notFound('Invalid QR token');
      if (qrToken.consumed) return ctx.badRequest('QR already used');
      if (new Date(qrToken.expires_at) < new Date()) {
        return ctx.badRequest('QR expired');
      }

      if (!qrToken.exit_requests || qrToken.exit_requests.length === 0) {
        console.error('❌ exit_requests empty');
        return ctx.badRequest('No associated exit request found for this QR token');
      }

      const exitRequest = qrToken.exit_requests[0];

      if (!exitRequest.student) {
        return ctx.internalServerError('Student relation missing');
      }

      const student = exitRequest.student;
      const isExit = exitRequest.status === 'PENDING';

      await strapi.entityService.update(
        'api::qr-token.qr-token',
        qrToken.id,
        {
          data: {
            consumed: true,
            consumedAt: new Date(),
            consumed_by: 'gate',
          },
        }
      );

      await strapi.entityService.update(
        'api::exit-request.exit-request',
        exitRequest.id,
        {
          data: {
            status: isExit ? 'EXITED' : 'RETURNED',
          },
        }
      );

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
};
