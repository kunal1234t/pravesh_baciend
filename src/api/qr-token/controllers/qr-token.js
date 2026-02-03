'use strict';

const crypto = require('crypto');

module.exports = {
  async validate(ctx) {
    try {
      console.log('🔥 QR VALIDATE API HIT');

      let { token } = ctx.request.body;
      console.log("🔥 RECEIVED RAW TOKEN:", JSON.stringify(token));

      if (!token) return ctx.badRequest('Token is required');

      // Handle composite token format (token|timestamp|uuid...)
      if (token.includes('|')) {
        console.log("ℹ️ Parsing composite token...");
        token = token.split('|')[0];
        console.log("✅ Parsed Token:", token);
      }

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

      console.log('QR TOKEN:', qrToken);

      if (!qrToken) {
        const all = await strapi.db.query('api::qr-token.qr-token').findMany({ select: ['hash'] });
        console.log('DEBUG: EXISTING HASHES:', all.map(t => t.hash));
        return ctx.notFound('Invalid QR token');
      }
      if (qrToken.consumed) return ctx.badRequest('QR already used');

      if (!qrToken.exit_requests || qrToken.exit_requests.length === 0) {
        console.error('❌ exit_requests empty');
        return ctx.badRequest('No associated exit request found for this QR token');
      }

      const exitRequest = qrToken.exit_requests[0];

      if (new Date(qrToken.expires_at) < new Date()) {
        console.log('❌ QR Expired. Updating status to REJECTED.');
        await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          { data: { statuse: 'REJECTED' } }
        );
        return ctx.badRequest('QR expired');
      }

      if (!exitRequest.student) {
        return ctx.internalServerError('Student relation missing');
      }

      const student = exitRequest.student;

      // ✅ DETECT ENTRY VS EXIT
      // If statuse is PENDING, it's an EXIT attempt.
      // If statuse is EXITED, it's an ENTRY attempt.
      const isExit = exitRequest.statuse === 'PENDING';
      const isEntry = exitRequest.statuse === 'EXITED';

      console.log(`ℹ️ Token Type Detected: ${isExit ? 'EXIT' : 'ENTRY'} (Statuse: ${exitRequest.statuse})`);

      if (!isExit && !isEntry) {
        // Edge case: Maybe already ENTERED or REJECTED
        return ctx.badRequest(`Invalid Exit Request statuse: ${exitRequest.statuse}`);
      }

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

      console.log(`🔄 Attempting to update ExitRequest [${exitRequest.id}] status...`);

      const updateData = {};

      if (isExit) {
        // EXIT FLOW
        updateData.statuse = 'EXITED'; // User successfully exited
      } else {
        // ENTRY FLOW
        updateData.statuse = 'ENTERED'; // User successfully entered
        updateData.entryTime = new Date(); // USER REQUIREMENT
      }

      try {
        const updateResult = await strapi.entityService.update(
          'api::exit-request.exit-request',
          exitRequest.id,
          {
            data: updateData,
          }
        );
        console.log('✅ Update Result:', JSON.stringify(updateResult, null, 2));
      } catch (updateError) {
        console.error('❌ FAILED to update ExitRequest:', updateError);
      }

      // Emit event for frontend
      if (strapi.io) {
        console.log('📢 Emitting qr-validated for token:', token);
        strapi.io.emit('qr-validated', {
          token: token,
          allowed: true,
          action: isExit ? 'exit' : 'entry',
          timestamp: new Date().toISOString()
        });
      }

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
