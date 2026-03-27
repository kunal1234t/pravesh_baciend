'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/visitors/warden/pending',
      handler: 'api::visitor.visitor.pendingForWarden',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/warden-approve',
      handler: 'api::visitor.visitor.wardenApprove',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/warden-reject',
      handler: 'api::visitor.visitor.wardenReject',
      config: { auth: false },
    },
  ],
};
