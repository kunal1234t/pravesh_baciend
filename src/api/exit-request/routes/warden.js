'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/exit-requests/warden/exited',
      handler: 'api::exit-request.exit-request.listExited',
      config: {
        auth: false, // JWT verified manually in controller
      },
    },
  ],
};
