'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/exit-requests/create',
      handler: 'exit-request.create',
      config: {
        auth: {
          strategies: ['users-permissions'],
        },
      },
    },
    {
      method: 'POST',
      path: '/exit-requests/entry', // ✅ New route for entry QR
      handler: 'exit-request.createEntry',
      config: {
        auth: {
          strategies: ['users-permissions'],
        },
      },
    },
  ],
};
