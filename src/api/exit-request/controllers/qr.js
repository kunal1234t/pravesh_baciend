'use strict';

const crypto = require('crypto');

module.exports = {
  async verify(ctx) {
    const { t, scanner_id } = ctx.request.body;

    // 1️⃣ Validate input
    if (!t) {
      return ctx.badRequest('QR token is required');
    }

    // 2️⃣ Hash raw token
    const tokenHash = crypto
      .createHash('sha256')
      .update(t)
      .digest('hex');

    // 3️⃣ Fetch QR token
    const qrToken = await strapi.db
      .query('api::qr-token.qr-token')
      .findOne({
        where: { hash: tokenHash },
        populate: {
          exit_request: {
            populate: {
              student: true,
            },
          },
        },
      });

    if (!qrToken) {
      return ctx.unauthorized('Invalid QR code');
    }

    // 4️⃣ Expiry check
    if (new Date(qrToken.expires_at) < new Date()) {
      return ctx.unauthorized('QR code expired');
    }

    // 5️⃣ One-time usage check
    if (qrToken.used_at) {
      return ctx.unauthorized('QR code already used');
    }

    const exitRequest = qrToken.exit_request;

    if (!exitRequest) {
      return ctx.badRequest('Exit request not found');
    }

    // 6️⃣ Exit request state check
    if (exitRequest.status !== 'PENDING') {
      return ctx.unauthorized('Exit request is not valid');
    }

    // 7️⃣ Atomic state update (THIS IS THE EXIT MOMENT)
    try {
      await strapi.db.transaction(async (trx) => {
        // Mark QR as used
        await strapi.entityService.update(
          'api::qr-token.qr-token',
          qrToken.id,
          {
            data: {
              used_at: new Date(),
              scanner_id: scanner_id || null,
            },
            transaction: trx,
          }
        );

        // Update exit request
        await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          {
            data: {
              status: 'EXITED',
              exited_at: new Date(),
            },
            transaction: trx,
          }
        );

        // OPTIONAL (recommended): update student_status
        const existingStatus = await strapi.db
          .query('api::student-status.student-status')
          .findOne({
            where: { student: exitRequest.student.id },
            transaction: trx,
          });

        if (existingStatus) {
          await strapi.entityService.update(
            'api::student-status.student-status',
            existingStatus.id,
            {
              data: {
                is_outside: true,
                last_exit_at: new Date(),
              },
              transaction: trx,
            }
          );
        } else {
          await strapi.entityService.create(
            'api::student-status.student-status',
            {
              data: {
                student: exitRequest.student.id,
                is_outside: true,
                last_exit_at: new Date(),
              },
              transaction: trx,
            }
          );
        }
      });
    } catch (err) {
      strapi.log.error('QR verification failed', err);
      return ctx.internalServerError('Failed to verify QR');
    }

    // 8️⃣ Success response to guard / scanner
    return {
      verdict: 'VERIFIED',
      student: {
        id: exitRequest.student.id,
        name: exitRequest.student.username,
      },
      purpose: exitRequest.purpose || null,
    };
  },
};
