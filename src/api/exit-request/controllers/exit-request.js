'use strict';

const crypto = require('crypto');

module.exports = {
  async create(ctx) {
    try {
      console.log("🔥 EXIT REQUEST API HIT");

      const { user } = ctx.state;
      const { reason } = ctx.request.body;

      console.log("USER:", user);
      console.log("BODY:", ctx.request.body);

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      if (!reason) {
        return ctx.badRequest('Reason is required');
      }

      // Fetch full user with role
      const fullUser = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        user.id,
        { populate: ['role'] }
      );

      console.log("ROLE:", fullUser?.role?.name);

      if (!fullUser || fullUser.role.name !== 'Student') {
        return ctx.forbidden('Only students can create exit requests');
      }

      // Check active exit
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

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // ✅ CREATE EXIT REQUEST (match schema)
      const exitRequest = await strapi.entityService.create(
        'api::exit-request.exit-request',
        {
          data: {
            student: user.id,
            reasonType: reason,   // REQUIRED FIELD
            status: 'PENDING',
            expiresAt: expiresAt, // REQUIRED FIELD
          },
        }
      );

      console.log("✅ EXIT REQUEST CREATED:", exitRequest.id);

      // ✅ CREATE QR TOKEN (match schema)
      const qrToken = await strapi.entityService.create('api::qr-token.qr-token', {
  data: {
    hash: tokenHash,
    expires_at: expiresAt,
    consumed: false,
    exit_requests: [exitRequest.id], // 👈 THIS is why yours was empty
  },
});


      console.log("✅ QR TOKEN CREATED:", qrToken.id);

      return {
        exitRequestId: exitRequest.id,
        qr: {
          t: rawToken,
          e: Math.floor(expiresAt.getTime() / 1000),
        },
      };

    } catch (err) {
      console.error("❌ EXIT REQUEST ERROR:", err);
      return ctx.internalServerError('Exit request creation failed');
    }
  },
};
