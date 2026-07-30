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

module.exports = {
    /**
     * @param {any} ctx
     */
    async createEntryQR(ctx) {
        try {
            console.log("🔥 CREATE ENTRY QR API HIT (Custom Controller)");
            const { user } = ctx.state;

            console.log("LOGGED IN USER:", user ? `ID: ${user.id}` : 'No User');

            if (!user) {
                return ctx.unauthorized('Authentication required');
            }

            const now = new Date();
            const isNightWindow = nightCompliance.isNightWindow();

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

            if (isNightWindow) {
                const lateEntry = await strapi.db
                    .query('api::late-entry-request.late-entry-request')
                    .findOne({
                        where: {
                            users_permissions_user: user.id,
                            stat: 'approved',
                        },
                        orderBy: { createdAt: 'desc' },
                    });

                if (!lateEntry) {
                    return ctx.forbidden('Late night approval required to enter the campus.');
                }

                const validUntil = resolveValidUntil(lateEntry);
                const adminOverride = lateEntry.adminOverride === true;

                if (!adminOverride && (!validUntil || now > validUntil)) {
                    return ctx.forbidden('Late night approval has expired.');
                }
            }

            // 2️⃣ Reuse existing active ENTRY token if present
            const existingToken = await strapi.db
                .query('api::qr-token.qr-token')
                .findOne({
                    where: {
                        exit_requests: activeExit.id,
                        consumed: false,
                        expires_at: { $gt: now },
                    },
                    orderBy: { createdAt: 'desc' },
                });

            if (existingToken) {
                return {
                    exitRequestId: activeExit.id,
                    qr: {
                        t: existingToken.token,
                        e: new Date(existingToken.expires_at).toISOString(),
                    },
                };
            }

            // 3️⃣ Generate ENTRY QR Token
            const base62 = require('../../qr-token/base62');
            const qrToken = base62.generateToken(); // Generate 12-char token like exit flow
            
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

            // 4️⃣ Save to qr-token table linked to same exit-request
            // Hash the token for verification
            const tokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');
            
            const createdQRToken = await strapi.entityService.create('api::qr-token.qr-token', {
                data: {
                    token: qrToken,
                    hash: tokenHash,  // Store hash for verification
                    expires_at: expiresAt,
                    consumed: false,
                    exit_requests: activeExit.id,  // Single ID, not array (manyToOne)
                },
            });

            console.log(`✅ ENTRY QR TOKEN CREATED: ${createdQRToken.id} with token: ${qrToken}`);

            // 5️⃣ Return to Frontend (simplified format: just token, like exit QR)
            // This makes entry QR easier to scan (shorter string)
            return {
                exitRequestId: activeExit.id,
                qr: {
                    t: qrToken,  // 't' for token only (simplified)
                    e: expiresAt.toISOString()  // 'e' for expiration (for timer)
                }
            };

        } catch (err) {
            console.error("❌ CREATE ENTRY ERROR:", err);
            return ctx.internalServerError('Entry QR creation failed');
        }
    }
};
