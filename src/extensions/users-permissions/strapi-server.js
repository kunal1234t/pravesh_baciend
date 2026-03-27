'use strict';

module.exports = (plugin) => {
  console.log('🔥 USERS-PERMISSIONS OVERRIDE LOADED (Strapi v5)');

  const originalCallback = plugin.controllers.auth.callback;

  plugin.controllers.auth.callback = async (ctx) => {
    console.log('🔥 CUSTOM LOGIN HIT');
    console.log('📥 BODY:', ctx.request.body);

    const { deviceID } = ctx.request.body;

    // call original login
    await originalCallback(ctx);

    // If the original callback already sent an error, stop here
    if (ctx.response.status !== 200 || !ctx.response.body) {
      return;
    }

    const user = ctx.response.body.user;
    if (!user) {
      return;
    }

    // Only enforce device check if deviceID was provided
    if (deviceID) {
      if (user.deviceID && user.deviceID !== deviceID) {
        console.log('❌ Login blocked: different device');
        ctx.status = 403;
        ctx.body = { error: { message: 'User already logged in on another device' } };
        return;
      }

      // save deviceID if first login
      if (!user.deviceID) {
        await strapi.entityService.update(
          'plugin::users-permissions.user',
          user.id,
          {
            data: { deviceID },
          }
        );
      }

      console.log('✅ LOGIN SUCCESSFUL for device:', deviceID);
    } else {
      console.log('✅ LOGIN SUCCESSFUL (no deviceID check - web mode)');
    }
  };

  return plugin;
};
