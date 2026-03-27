'use strict';

const crypto = require('crypto');

module.exports = {
  // Warden: list all EXITED exit-requests (students currently outside)
  async listExited(ctx) {
    try {
      // Manually verify JWT since route uses auth: false
      const authHeader = ctx.request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return ctx.unauthorized('No token provided');
      }

      const token = authHeader.replace('Bearer ', '');
      const jwtService = strapi.plugin('users-permissions').service('jwt');
      let payload;
      try {
        payload = await jwtService.verify(token);
      } catch (e) {
        return ctx.unauthorized('Invalid or expired token');
      }

      const fullUser = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        payload.id,
        { populate: ['role'] }
      );

      if (!fullUser || fullUser.role.name !== 'Warden') {
        return ctx.forbidden('Only wardens can view this list');
      }

      const exitedRequests = await strapi.entityService.findMany(
        'api::exit-request.exit-request',
        {
          filters: { statuse: 'EXITED' },
          populate: ['student'],
          sort: { createdAt: 'desc' },
        }
      );

      return ctx.send({ data: exitedRequests });
    } catch (err) {
      console.error('❌ listExited ERROR:', err);
      return ctx.internalServerError('Failed to fetch exited students');
    }
  },

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
            statuse: { $in: ['PENDING', 'EXITED'] },
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
            statuse: 'PENDING',
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

  async createEntry(ctx) {
    try {
      console.log("🔥 CREATE ENTRY QR API HIT");
      const { user } = ctx.state;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check for active "OUT" status (APPROVED or EXITED)
      // We look for the most recent one that hasn't been returned yet
      console.log(`🔍 Searching for active exit for user ${user.id}...`);

      const activeExit = await strapi.db
        .query('api::exit-request.exit-request')
        .findOne({
          where: {
            student: user.id,
            status: { $in: ['APPROVED', 'EXITED'] },
          },
          orderBy: { createdAt: 'desc' }, // Get the latest
        });

      if (!activeExit) {
        console.warn(`⚠️ No active exit found for user ${user.id}. Cannot create entry QR.`);
        return ctx.badRequest('No active exit found. You must exit first to generate an entry QR.');
      }

      console.log(`✅ Found active exit: ${activeExit.id} (Status: ${activeExit.status})`);

      // Check if already returned? The status check above handles it (RETURNED is not in list)

      // Generate token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Create QR Token linked to the SAME exit request
      const qrToken = await strapi.entityService.create('api::qr-token.qr-token', {
        data: {
          hash: tokenHash,
          expires_at: expiresAt,
          consumed: false,
          exit_requests: [activeExit.id],
        },
      });

      console.log("✅ ENTRY QR TOKEN CREATED for Exit Request:", activeExit.id);

      return {
        exitRequestId: activeExit.id,
        qr: {
          t: rawToken,
          e: Math.floor(expiresAt.getTime() / 1000),
        },
      };

    } catch (err) {
      console.error("❌ CREATE ENTRY ERROR:", err);
      return ctx.internalServerError('Entry QR creation failed');
    }
  },
};
