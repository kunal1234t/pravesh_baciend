'use strict';

module.exports = {
    async register(ctx) {
        console.log('🔥 CUSTOM REGISTER API HIT');

        const { username, email, password, phone_number, deviceID } = ctx.request.body;

        if (!username || !email || !password || !deviceID) {
            return ctx.badRequest('username, email, password and deviceID are required');
        }

        // ── SECURITY: Email domain validation ──
        // Only allow institutional email addresses
        if (!email.toLowerCase().endsWith('@iiitn.ac.in')) {
            console.warn(`🚨 SECURITY: Registration attempt with non-institutional email: ${email}`);
            return ctx.badRequest('Only @iiitn.ac.in email addresses are allowed');
        }

        // ── SECURITY: Role is ALWAYS Student (2) ──
        // Teachers/Wardens/Guards are pre-created via admin scripts.
        // Self-registration can ONLY create Student accounts.
        const STUDENT_ROLE_ID = 2;

        // ── SECURITY: Input length validation ──
        if (username.length > 100 || email.length > 150 || password.length > 128) {
            return ctx.badRequest('Input fields exceed maximum allowed length');
        }

        if (phone_number && (typeof phone_number !== 'string' || phone_number.length > 15)) {
            return ctx.badRequest('Invalid phone number format');
        }

        try {
            const existingUser = await strapi.db
                .query('plugin::users-permissions.user')
                .findOne({ where: { email } });

            if (existingUser) {
                return ctx.badRequest('User already exists');
            }

            // --- Enforce Device Uniqueness ---
            const existingDeviceUser = await strapi.db
                .query('plugin::users-permissions.user')
                .findOne({ where: { deviceID } });

            if (existingDeviceUser) {
                console.log('❌ Registration blocked: device already bound to another user:', deviceID);
                return ctx.forbidden('This device is already bound to another account.');
            }

            const user = await strapi.entityService.create(
                'plugin::users-permissions.user',
                {
                    data: {
                        username,
                        email,
                        password,
                        provider: 'local',
                        confirmed: true,
                        role: STUDENT_ROLE_ID, // HARDCODED: Self-registration = Student only
                        phone_number,
                        deviceID,
                    },
                }
            );

            console.log('✅ USER CREATED:', user.id);

            // 🔐 Generate JWT (auto login)
            const jwt = strapi
                .plugin('users-permissions')
                .service('jwt')
                .issue({ id: user.id });

            // ── SECURITY: Never return sensitive fields ──
            delete user.password;
            delete user.resetPasswordToken;
            delete user.confirmationToken;

            return ctx.send({
                jwt,
                user,
                message: 'Registered & logged in successfully',
            });

        } catch (err) {
            console.error('❌ REGISTER ERROR:', err.message);
            return ctx.internalServerError('Registration failed');
        }
    },
};
