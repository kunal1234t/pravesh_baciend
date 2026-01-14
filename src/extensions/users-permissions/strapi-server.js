'use strict';

module.exports = (plugin) => {
  console.log('🔥 USERS-PERMISSIONS OVERRIDE LOADED');

  plugin.controllers.user.me = async (ctx) => {
    console.log('🔥 CUSTOM /users/me HIT');

    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized();
    }

    const fullUser = await strapi.entityService.findOne(
      'plugin::users-permissions.user',
      user.id,
      {
        populate: { role: true },
      }
    );

    console.log('🔥 USER WITH ROLE:', fullUser);

    return fullUser;
  };

  return plugin;
};
