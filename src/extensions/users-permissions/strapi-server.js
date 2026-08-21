'use strict';

module.exports = (plugin) => {
  console.log('🔥 USERS-PERMISSIONS OVERRIDE LOADED (Strapi v5)');

  // Temporary operational switch. Device binding is disabled unless this is
  // explicitly set to "true" in the backend environment.
  const deviceBindingEnabled = process.env.DEVICE_BINDING_ENABLED === 'true';

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

    const fullUser = await strapi.entityService.findOne('plugin::users-permissions.user', user.id);
    if (!fullUser) return;

    if (!deviceBindingEnabled) {
      console.log('⚠️ Device binding is temporarily disabled.');
    }
    // 1. Enforce deviceID check even if missing from request (if bound in DB)
    else if (fullUser.deviceID) {
      if (!deviceID || fullUser.deviceID !== deviceID) {
        console.log('❌ Login blocked: different device');
        ctx.status = 403;
        ctx.body = { error: { message: 'User already logged in on another device' } };
        return;
      }
    }
    // 2. Auto-bind deviceID if not bound yet
    else if (deviceID) {
      // Check if this device is ALREADY bound to ANY other account
      console.log("Incoming deviceID:", deviceID);

const existingDeviceUser = await strapi.db
  .query("plugin::users-permissions.user")
  .findOne({
    where: { deviceID },
  });

console.log("existingDeviceUser =", existingDeviceUser);
console.log("Current user =", fullUser.id);

      if (existingDeviceUser && existingDeviceUser.id !== fullUser.id) {
        console.log('❌ Login blocked: device already bound to another user:', deviceID);
        ctx.status = 403;
        ctx.body = { error: { message: 'This device is already bound to another account.' } };
        return;
      }

      await strapi.entityService.update(
        'plugin::users-permissions.user',
        fullUser.id,
        {
          data: { deviceID },
        }
      );
      console.log('✅ Device auto-bound:', deviceID);
    } else {
      console.log('⚠️ LOGIN SUCCESSFUL (no deviceID provided - web mode or desktop)');
    }

    // Update response to include deviceID for frontend state
    ctx.response.body.user.deviceID = deviceID || fullUser.deviceID;
    if (deviceID) console.log('✅ LOGIN SUCCESSFUL for device:', deviceID);
  };

  return plugin;
};
