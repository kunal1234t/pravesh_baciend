'use strict';

const { Server } = require('socket.io');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) { },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    // ── Windows temp-file EPERM crash guard ──
    // On Windows, Strapi's upload plugin can't always unlink temp files immediately
    // due to file locking. The upload itself succeeds — we just swallow the cleanup error.
    process.on('uncaughtException', (err) => {
      if (err.code === 'EPERM' && err.syscall === 'unlink') {
        console.warn('⚠️  Temp file cleanup skipped (Windows lock):', err.path);
        return;
      }
      // Re-throw anything else so real crashes still surface
      throw err;
    });

    // ── Socket.IO setup ──
    const io = new Server(strapi.server.httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    io.on('connection', (socket) => {
      console.log('socket connected', socket.id);

      // Client joins their personal room after login
      socket.on('join', (userId) => {
        const room = `user:${userId}`;
        socket.join(room);
        console.log(`🔔 Socket ${socket.id} joined room ${room}`);
      });
    });

    strapi.io = io;

    // ── Auto-grant permissions to all authenticated roles ──
    const actionsToGrant = [
      'plugin::users-permissions.user.me',
      'plugin::upload.content-api.upload',
      'plugin::upload.content-api.find',
      'plugin::upload.content-api.findOne',
    ];

    try {
      const roles = await strapi.db.query('plugin::users-permissions.role').findMany({
        where: { type: { $ne: 'public' } },
      });

      for (const role of roles) {
        for (const action of actionsToGrant) {
          const existing = await strapi.db.query('plugin::users-permissions.permission').findOne({
            where: { role: role.id, action },
          });

          if (!existing) {
            await strapi.db.query('plugin::users-permissions.permission').create({
              data: { action, role: role.id, enabled: true },
            });
            console.log(`✅ Granted [${action}] to role: ${role.name}`);
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Could not auto-grant permissions:', err.message);
    }
  },
};
