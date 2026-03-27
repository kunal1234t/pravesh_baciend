'use strict';

const { sanitize } = require('@strapi/utils');

module.exports = {
    async callback(ctx) {
        if (ctx.request.path !== '/api/auth/local/register') {
            return await strapi
                .plugin('users-permissions')
                .controllers.auth.callback(ctx);
        }

        console.log('🔥🔥🔥 CUSTOM REGISTER CONTROLLER HIT');
        console.log('📥 RAW BODY:', ctx.request.body);

        const { username, email, password, role, phone_number, deviceID } = ctx.request.body;

        if (!username || !email || !password) {
            return ctx.badRequest('username, email and password are required');
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
                        deviceID,
                    },
                }
            );

            console.log('✅ USER CREATED:', user);

            const sanitizedUser = await sanitize.contentAPI.output(
                user,
                strapi.getModel('plugin::users-permissions.user')
            );

            return ctx.send({
                user: sanitizedUser,
                message: 'User registered successfully',
            });

        } catch (err) {
            console.error('❌ REGISTER ERROR:', err);
            return ctx.internalServerError(err.message);
        }
    },
};
