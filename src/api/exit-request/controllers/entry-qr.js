'use strict';

const crypto = require('crypto');

module.exports = {
    async createEntryQR(ctx) {
        try {
            console.log("🔥 CREATE ENTRY QR API HIT (Custom Controller)");
            const { user } = ctx.state;

            console.log("LOGGED IN USER:", user ? `ID: ${user.id}` : 'No User');

            if (!user) {
                return ctx.unauthorized('Authentication required');
            }

            // 1️⃣ Check for active "EXITED" request
            // We only allow entry if they have actually EXITED.
            // If status is still PENDING or APPROVED, they haven't exited yet.
            console.log(`🔍 Searching for active EXITED request for user ${user.id}...`);

            const activeExit = await strapi.db
                .query('api::exit-request.exit-request')
                .findOne({
                    where: {
                        student: user.id,
                        statuse: 'EXITED',
                    },
                    orderBy: { createdAt: 'desc' },
                });

            if (!activeExit) {
                console.warn(`⚠️ No active EXITED request found for user ${user.id}.`);
                return ctx.badRequest('You need to exit first before generating entry QR');
            }

            console.log(`✅ Found active exit: ${activeExit.id} (Status: ${activeExit.statuse})`);

            // 2️⃣ Generate ENTRY QR Token
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto
                .createHash('sha256')
                .update(rawToken)
                .digest('hex');

            const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

            // 3️⃣ Save to qr-token table linked to same exit-request
            const qrToken = await strapi.entityService.create('api::qr-token.qr-token', {
                data: {
                    hash: tokenHash,
                    expires_at: expiresAt,
                    consumed: false,
                    exit_requests: [activeExit.id],
                },
            });

            console.log(`✅ ENTRY QR TOKEN CREATED: ${qrToken.id} for Exit Request ${activeExit.id}`);

            // 4️⃣ Return to Frontend
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
    }
};
