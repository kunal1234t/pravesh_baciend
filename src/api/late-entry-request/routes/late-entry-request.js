'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/late-entry/submit',
      handler: 'late-entry-request.submit',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/late-entry/my-status',
      handler: 'late-entry-request.myStatus',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/late-entry/history',
      handler: 'late-entry-request.history',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/late-entry/warden/pending',
      handler: 'late-entry-request.wardenPending',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/late-entry/:id/approve',
      handler: 'late-entry-request.approve',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/late-entry/:id/reject',
      handler: 'late-entry-request.reject',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/late-entry/:id/mark-entered',
      handler: 'late-entry-request.markEntered',
      config: { auth: false },
    },
  ],
};
