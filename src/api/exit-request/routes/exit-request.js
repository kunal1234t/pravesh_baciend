'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/exit-request/create',
      handler: 'exit-request.create',
      config: {
        auth: false,
      },
    },
  ],
};
