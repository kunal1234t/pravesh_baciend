'use strict';

const crypto = require('crypto');

module.exports = {
  async create(ctx) {
    const { user } = ctx.state;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    // Fetch user with role
    const fullUser = await strapi.entityService.findOne(
      'plugin::users-permissions.user',
      user.id,
      { populate: ['role'] }
    );

    if (!fullUser || fullUser.role?.name !== 'STUDENT') {
      return ctx.forbidden('Only students can create exit requests');
    }

    // Check for active exit
    const activeExit = await strapi.db
      .query('api::exit-request.exit-request')
      .findOne({
        where: {
          student: user.id,
          status: { $in: ['PENDING', 'EXITED'] },
        },
      });

    if (activeExit) {
      return ctx.badRequest('You already have an active exit request');
    }

    // Generate token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds

    let exitRequest;

    try {
      await strapi.db.transaction(async (trx) => {
        // 1. Create exit request
        exitRequest = await strapi.entityService.create(
          'api::exit-request.exit-request',
          {
            data: {
              student: user.id,
              status: 'PENDING',
            },
            transaction: trx,
          }
        );

        // 2. Create QR token
        await strapi.entityService.create(
          'api::qr-token.qr-token',
          {
            data: {
              token_hash: tokenHash,
              expires_at: expiresAt,
              exit_request: exitRequest.id,
            },
            transaction: trx,
          }
        );
      });
    } catch (err) {
      strapi.log.error('Exit request creation failed', err);
      return ctx.internalServerError('Failed to create exit request');
    }

    return {
      // @ts-ignore
      exitRequestId: exitRequest.id,
      qr: {
        t: rawToken,
        e: Math.floor(expiresAt.getTime() / 1000),
      },
    };
  },
};
