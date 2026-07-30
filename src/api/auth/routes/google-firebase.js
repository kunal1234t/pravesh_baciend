module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/auth/firebase-login',
      handler: 'google-firebase.login',
      config: {
        auth: false, // Public endpoint
      },
    },
  ],
};
