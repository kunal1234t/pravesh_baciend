'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/exit-request/verify',
      handler: 'verify.verify',
      config: {
        auth: false // Arduino / scanner access
      },
    },
  ],
};
