module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/visitors/create',
      handler: 'visitor.createByGuard',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/schedule',
      handler: 'visitor.scheduleVisitor',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/status/:id',
      handler: 'visitor.getStatus',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/guard/mine',
      handler: 'visitor.guardMine',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/guard/inside',
      handler: 'visitor.guardInside',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/guard/scheduled',
      handler: 'visitor.guardScheduled',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/check-in',
      handler: 'visitor.guardCheckIn',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/visitors/:id/mark-exit',
      handler: 'visitor.guardMarkExit',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/staff',
      handler: 'visitor.getStaff',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/pending',
      handler: 'visitor.pendingForTeacher',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/visitors/history',
      handler: 'visitor.historyForStaff',
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
