'use strict';

module.exports = {
    async register(ctx) {
        console.log('🔥 CUSTOM REGISTER API HIT');
        console.log('📥 BODY:', ctx.request.body);

        const { username, email, password, role, phone_number, deviceID } = ctx.request.body;

        if (!username || !email || !password || !deviceID) {
            return ctx.badRequest('username, email, password and deviceID are required');
        }

        try {
            const existingUser = await strapi.db
                .query('plugin::users-permissions.user')
                .findOne({ where: { email } });

            if (existingUser) {
                return ctx.badRequest('User already exists');
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
                        role,
                        phone_number,
                        deviceID, // store device
                    },
                }
            );

            console.log('✅ USER CREATED:', user);

            // 🔐 Generate JWT (auto login)
            const jwt = strapi
                .plugin('users-permissions')
                .service('jwt')
                .issue({ id: user.id });

            delete user.password;
            delete user.resetPasswordToken;
            delete user.confirmationToken;

            return ctx.send({
                jwt,
                user,
                message: 'Registered & logged in successfully',
            });

        } catch (err) {
            console.error('❌ REGISTER ERROR:', err);
            return ctx.internalServerError(err.message);
        }
    },
};
