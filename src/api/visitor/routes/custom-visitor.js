module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/visitors/create',
      handler: 'visitor.createByGuard',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/pending',
      handler: 'visitor.pendingForTeacher',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/approve',
      handler: 'visitor.approve',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/reject',
      handler: 'visitor.reject',
      config: { auth: false },
    },
  ],
};
