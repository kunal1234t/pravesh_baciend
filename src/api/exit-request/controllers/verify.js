'use strict';

const crypto = require('crypto');

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
            exit_request: {
              populate: { user: true },
            },
          },
        });

      if (!qrToken || !qrToken.exit_request) {
        return ctx.badRequest('INVALID_OR_EXPIRED_QR');
      }

      const exitRequest = qrToken.exit_request;

      if (exitRequest.status !== 'PENDING') {
        return ctx.badRequest('INVALID_EXIT_STATE');
      }

      // 4. Atomic consume + exit
      await strapi.db.transaction(async () => {
        await strapi.db.query('api::qr-token.qr-token').update({
          where: { id: qrToken.id },
          data: {
            consumed: true,
            consumed_at: new Date(),
            consumed_by: 'GATE',
          },
        });

        await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          {
            data: {
              status: 'OUT',
              exitedAt: new Date(),
            },
          }
        );
      });

      // 5. Optional audit log
      await strapi.entityService.create('api::scan-log.scan-log', {
        data: {
          exitRequest: exitRequest.id,
          result: 'VERIFIED',
          scannedAt: new Date(),
        },
      });

      // 6. Respond to hardware
      return ctx.send({
        verdict: 'VERIFIED',
        studentId: exitRequest.user.id,
      });
    } catch (err) {
      strapi.log.error(err);
      return ctx.internalServerError('VERIFICATION_FAILED');
    }
  },
};
    