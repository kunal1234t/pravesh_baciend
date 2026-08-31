'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/hardware/dashboard',
      handler: 'hardware.dashboard',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/hardware/students/:identifier/mark-inside',
      handler: 'hardware.markInside',
      config: { auth: false },
    },
  ],
};
