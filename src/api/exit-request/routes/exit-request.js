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
  ],
};
