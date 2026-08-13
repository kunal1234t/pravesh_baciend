'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/qr-token/validate',
      handler: 'qr-token.validate',
      config: {
        auth: false, // hardware does not use JWT
      },
    },
    {
      method: 'POST',
      path: '/qr-token/force-status',
      handler: 'qr-token.forceStatus',
      config: {
        auth: false, // hardware does not use JWT
      },
    },
  ],
};
