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
  ],
};
