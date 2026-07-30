'use strict';

const { Server } = require('socket.io');
const cron = require('node-cron');
const nightCompliance = require('./api/night-compliance');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   */
  register(/*{ strapi }*/) {
    // ── Windows EPERM fix: patch fs.unlink so Strapi's upload plugin never
    // sees the "operation not permitted" error when cleaning up temp files.
    const fs = require('fs');

    // Patch callback-style fs.unlink
    const _unlink = fs.unlink.bind(fs);
    fs.unlink = (path, cb) => {
      _unlink(path, (err) => {
        if (err?.code === 'EPERM' && err?.syscall === 'unlink') {
          console.warn('⚠️  Temp file unlink skipped (Windows lock):', path);
          cb(null);
        } else {
          cb(err);
        }
      });
    };

    // Patch promise-style fs.promises.unlink
    const _unlinkAsync = fs.promises.unlink.bind(fs.promises);
    fs.promises.unlink = async (path) => {
      try {
        await _unlinkAsync(path);
      } catch (err) {
        if (err?.code === 'EPERM' && err?.syscall === 'unlink') {
          console.warn('⚠️  Temp file unlink skipped (Windows lock, async):', path);
        } else {
          throw err;
        }
      }
    };

    // Patch callback-style fs.rmdir
    const _rmdir = fs.rmdir.bind(fs);
    fs.rmdir = (path, optsOrCb, maybeCb) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      const opts = typeof optsOrCb === 'object' ? optsOrCb : undefined;
      const done = (err) => {
        if (err?.code === 'ENOTEMPTY' && err?.syscall === 'rmdir') {
          console.warn('⚠️  Temp dir rmdir skipped (not empty, Windows lock):', path);
          cb(null);
        } else {
          cb(err);
        }
      };
      opts ? _rmdir(path, opts, done) : _rmdir(path, done);
    };

    // Patch promise-style fs.promises.rmdir
    const _rmdirAsync = fs.promises.rmdir.bind(fs.promises);
    fs.promises.rmdir = async (path, opts) => {
      try {
        await _rmdirAsync(path, opts);
      } catch (err) {
        if (err?.code === 'ENOTEMPTY' && err?.syscall === 'rmdir') {
          console.warn('⚠️  Temp dir rmdir skipped (not empty, Windows lock, async):', path);
        } else {
          throw err;
        }
      }
    };
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   */
  async bootstrap({ strapi }) {
    // ── Socket.IO setup with JWT authentication ──
    const io = new Server(strapi.server.httpServer, {
      cors: {
        // Restrict to your app's origins only
        // Mobile apps use capacitor/localhost origins; add your server domain if you have a web panel
        origin: [
          'http://localhost',
          'http://localhost:3000',
          'http://localhost:1337',
          process.env.FRONTEND_URL || 'http://192.168.77.40:6969',
        ],
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    // ── SECURITY FIX: JWT Authentication Middleware ──
    // Every Socket.IO connection MUST include a valid JWT token.
    // This prevents socket hijacking where a malicious client joins
    // another user's room to intercept QR validation events.
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;

        if (!token) {
          console.warn('🚨 SECURITY: Socket connection rejected — no JWT token');
          return next(new Error('Authentication required'));
        }

        // Verify JWT using Strapi's users-permissions plugin
        const jwtService = strapi.plugin('users-permissions').service('jwt');
        let payload;
        try {
          payload = await jwtService.verify(token);
        } catch (e) {
          console.warn('🚨 SECURITY: Socket connection rejected — invalid JWT');
          return next(new Error('Invalid or expired token'));
        }

        // Attach verified user ID to socket for room join validation
        socket.data.userId = String(payload.id);
        console.log(`🔐 Socket authenticated for user: ${payload.id}`);
        next();
      } catch (err) {
        console.error('❌ Socket auth middleware error:', err.message);
        next(new Error('Authentication failed'));
      }
    });

    io.on('connection', (socket) => {
      console.log('socket connected', socket.id, '(user:', socket.data.userId, ')');

      // The authenticated user ID from JWT middleware
      const authenticatedUserId = socket.data.userId;

      // Client joins their personal room after login
      socket.on('join', (userId) => {
        const requestedId = String(userId);

        // ── SECURITY: Only allow joining your OWN room ──
        if (requestedId !== authenticatedUserId) {
          console.error(`🚨 SECURITY: User ${authenticatedUserId} tried to join room for user ${requestedId} — BLOCKED`);
          socket.emit('error', { message: 'Cannot join another user\'s room' });
          return;
        }

        const room = `user:${requestedId}`;
        socket.join(room);
        console.log(`🔔 Socket ${socket.id} joined room user:${requestedId}`);
      });

      // Store FCM token for push notifications
      socket.on('update-fcm-token', async (data) => {
        try {
          const { userId, fcmToken } = data;

          // SECURITY: Verify userId matches authenticated user
          if (String(userId) !== authenticatedUserId) {
            console.error(`🚨 SECURITY: Unauthorized FCM token update. Socket user: ${authenticatedUserId}, Requested: ${userId}`);
            return;
          }

          if (!userId || !fcmToken) {
            console.warn('⚠️ Invalid FCM token update - missing userId or fcmToken');
            return;
          }

          // Update user's FCM token in database using raw SQL
          await strapi.db.connection.raw(
            'UPDATE up_users SET fcm_token = ?, fcm_token_updated_at = NOW() WHERE id = ?',
            [fcmToken, userId]
          );

          console.log(`✅ FCM token stored for user ${userId}`);
          socket.emit('fcm-token-updated', { success: true });
        } catch (err) {
          console.error('❌ Failed to store FCM token:', err.message);
          socket.emit('fcm-token-updated', { success: false, error: err.message });
        }
      });
    });

    strapi.io = io;

    // ── Initialize Firebase Admin SDK for Push Notifications ──
    try {
      const notificationService = require('./api/notification-service');
      await notificationService.init();
      strapi.notificationService = notificationService;
      console.log('✅ Firebase Admin SDK initialized for FCM');
    } catch (err) {
      console.warn('⚠️ Firebase initialization skipped (FCM disabled):', err.message);
    }

    // ── Redis subscriber for TTL expiration events ──
    try {
      const Redis = require('ioredis');

      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const redisSubscriber = new Redis(redisUrl, {
        retryStrategy: (times) => Math.min(times * 50, 2000),
        enableReadyCheck: false,
        enableOfflineQueue: false,
      });

      redisSubscriber.on('error', () => {
        // Silently ignore connection errors
      });

      await redisSubscriber.ping();
      console.log('✅ Redis TTL Listener Connected');

      const expiredChannel = '__keyevent@0__:expired';
      await redisSubscriber.subscribe(expiredChannel);
      console.log(`🔔 Subscribed to Redis expiration events: ${expiredChannel}`);

      redisSubscriber.on('message', async (channel, message) => {
        if (channel === expiredChannel && message.startsWith('exit_expiry:')) {
          const requestId = message.split(':')[1];

          console.log(`⏱️  Redis TTL: Key expired for exit request ${requestId}. Marking as REJECTED.`);

          try {
            const updated = await strapi.db.query('api::exit-request.exit-request').update({
              where: { id: requestId, statuse: 'PENDING' }, // Fix #2: was lowercase 'pending', DB stores 'PENDING'
              data: { statuse: 'REJECTED' },
            });

            if (updated.count > 0) {
              console.log(`✅ Exit request ${requestId} auto-rejected via Redis TTL`);

              if (strapi.io) {
                strapi.io.to(`exit:${requestId}`).emit('exit-rejected', {
                  requestId,
                  reason: 'TTL_EXPIRED',
                  timestamp: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            console.error(`❌ Redis Cleanup Error for ${requestId}:`, err.message);
          }
        }
      });

      redisSubscriber.on('disconnect', () => {
        // Silently handle disconnection
      });

      strapi.redis = { subscriber: redisSubscriber };

    } catch (err) {
      console.warn('⚠️  Redis TTL Listener not available: Falling back to Cron Job cleanup only');
    }

    // ── Fix #3: Nightly DB Cleanup Cron Job (3:00 AM IST) ──
    // Runs every night to permanently DELETE stale rows and keep tables lean.
    // SAFE: Only touches EXPIRED, CONSUMED, or COMPLETED records — never active ones.
    cron.schedule('0 3 * * *', async () => {
      console.log('🧹 [CRON] Starting nightly database cleanup...');
      const db = strapi.db;
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      try {
        // 1. Fallback for Redis TTL misses: reject expired pending exit requests.
        const rejectedExpiredExitRequests = await db.connection('exit_requests')
          .where('statuse', 'PENDING')
          .andWhere('expires_at', '<', now)
          .update({ statuse: 'REJECTED', updated_at: now });
        console.log(`🧹 [CRON] Rejected ${rejectedExpiredExitRequests} expired pending exit requests`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to reject expired pending exit requests:', e.message);
      }

      try {
        // 2. Auto-reject stale pending late-entry requests (>24h).
        const rejectedPendingLateRequests = await db.connection('late_entry_requests')
          .where('stat', 'pending')
          .andWhere('created_at', '<', oneDayAgo)
          .update({ stat: 'rejected', updated_at: now });
        console.log(`🧹 [CRON] Rejected ${rejectedPendingLateRequests} stale pending late-entry requests`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to reject stale pending late-entry requests:', e.message);
      }

      try {
        // 3. Auto-reject stale approved late-entry requests (>12h after approval).
        const rejectedApprovedLateRequests = await db.connection('late_entry_requests')
          .where('stat', 'approved')
          .andWhere((builder) => {
            builder
              .where('approved_at', '<', twelveHoursAgo)
              .orWhere((sub) => {
                sub.whereNull('approved_at').andWhere('created_at', '<', twelveHoursAgo);
              });
          })
          .update({ stat: 'rejected', updated_at: now });
        console.log(`🧹 [CRON] Rejected ${rejectedApprovedLateRequests} stale approved late-entry requests`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to reject stale approved late-entry requests:', e.message);
      }

      try {
        // 4. Delete expired, unconsumed QR tokens.
        const expiredQrRows = await db.connection('qr_tokens')
          .where('expires_at', '<', now)
          .andWhere('consumed', false)
          .del();
        console.log(`🧹 [CRON] Deleted ${expiredQrRows} expired unconsumed QR tokens`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to clean expired QR tokens:', e.message);
      }

      try {
        // 5. Delete consumed QR tokens older than 24 hours (audit log kept for 1 day).
        const consumedQrRows = await db.connection('qr_tokens')
          .where('consumed', true)
          .andWhere('consumed_at', '<', oneDayAgo)
          .del();
        console.log(`🧹 [CRON] Deleted ${consumedQrRows} old consumed QR tokens`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to clean consumed QR tokens:', e.message);
      }

      try {
        // 6. Delete exit requests older than 90 days that are fully completed.
        const oldExitRows = await db.connection('exit_requests')
          .whereIn('statuse', ['ENTERED', 'REJECTED'])
          .andWhere('created_at', '<', ninetyDaysAgo)
          .del();
        console.log(`🧹 [CRON] Deleted ${oldExitRows} old completed exit requests (90d+)`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to clean old exit requests:', e.message);
      }

      try {
        // 7. Delete late-entry requests older than 90 days that are fully completed.
        const oldLateRows = await db.connection('late_entry_requests')
          .whereIn('stat', ['entered', 'rejected'])
          .andWhere('created_at', '<', ninetyDaysAgo)
          .del();
        console.log(`🧹 [CRON] Deleted ${oldLateRows} old completed late-entry requests (90d+)`);
      } catch (e) {
        console.error('🧹 [CRON] Failed to clean old late-entry requests:', e.message);
      }

      console.log('🧹 [CRON] Nightly cleanup complete.');
    }, {
      timezone: 'Asia/Kolkata',
    });

    // ── Night Alert Idempotency Table ──
    try {
      await strapi.db.connection.raw(`
        CREATE TABLE IF NOT EXISTS night_alert_runs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          alert_date DATE NOT NULL UNIQUE,
          status VARCHAR(32) NOT NULL,
          total_outside INT NOT NULL DEFAULT 0,
          with_approval_count INT NOT NULL DEFAULT 0,
          without_approval_count INT NOT NULL DEFAULT 0,
          recipient_count INT NOT NULL DEFAULT 0,
          payload_json LONGTEXT NULL,
          error_message TEXT NULL,
          started_at DATETIME NOT NULL,
          finished_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ night_alert_runs table ready');
    } catch (err) {
      console.error('⚠️ Failed to initialize night_alert_runs table:', err.message);
    }

    // ── 10 PM Night Compliance Alert Job (Asia/Kolkata) ──
    cron.schedule('0 22 * * *', async () => {
      const alertDate = nightCompliance.getIstDateString(new Date());
      const startedAt = new Date();

      try {
        const existingRun = await strapi.db.connection.raw(
          'SELECT id FROM night_alert_runs WHERE alert_date = ? LIMIT 1',
          [alertDate]
        );
        if (existingRun?.[0]?.length) {
          console.log(`🔁 [10PM ALERT] Run already exists for ${alertDate}, skipping`);
          return;
        }

        await strapi.db.connection.raw(
          'INSERT INTO night_alert_runs (alert_date, status, started_at) VALUES (?, ?, ?)',
          [alertDate, 'running', startedAt]
        );

        const classified = await nightCompliance.fetchOutsideStudentsWithClassification();
        const studentIds = classified.students
          .map((student) => student?.student?.id)
          .filter(Boolean)
          .map((id) => String(id));
        const emitResult = await nightCompliance.emitNightAlertSummary(
          classified.summary,
          studentIds
        );

        await strapi.db.connection.raw(
          `UPDATE night_alert_runs
           SET status = ?, total_outside = ?, with_approval_count = ?, without_approval_count = ?,
               recipient_count = ?, payload_json = ?, finished_at = ?
           WHERE alert_date = ?`,
          [
            'completed',
            classified.summary.totalOutside,
            classified.summary.withApprovalCount,
            classified.summary.withoutApprovalCount,
            emitResult.recipientIds.length,
            JSON.stringify({
              summary: classified.summary,
              studentIds,
              pushResult: emitResult.pushResult,
            }),
            new Date(),
            alertDate,
          ]
        );

        console.log(
          `✅ [10PM ALERT] Completed for ${alertDate}: outside=${classified.summary.totalOutside}, withoutApproval=${classified.summary.withoutApprovalCount}`
        );
      } catch (err) {
        console.error(`❌ [10PM ALERT] Failed for ${alertDate}:`, err.message);
        try {
          await strapi.db.connection.raw(
            `UPDATE night_alert_runs
             SET status = ?, error_message = ?, finished_at = ?
             WHERE alert_date = ?`,
            ['failed', err.message, new Date(), alertDate]
          );
        } catch (updateErr) {
          console.error('❌ [10PM ALERT] Failed to update run status:', updateErr.message);
        }
      }
    }, {
      timezone: 'Asia/Kolkata',
    });

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

      console.log(`🔐 Found ${roles.length} authenticated roles: ${roles.map(r => r.name).join(', ')}`);

      for (const role of roles) {
        for (const action of actionsToGrant) {
          const existing = await strapi.db.query('plugin::users-permissions.permission').findOne({
            where: { role: role.id, action },
          });

          if (!existing) {
            await strapi.db.query('plugin::users-permissions.permission').create({
              data: { action, role: role.id, enabled: true },
            });
            console.log(`  ✅ Granted [${action}] to ${role.name}`);
          } else if (!existing.enabled) {
            await strapi.db.query('plugin::users-permissions.permission').update({
              where: { id: existing.id },
              data: { enabled: true },
            });
            console.log(`  ✅ Re-enabled [${action}] for ${role.name}`);
          }
        }
      }
      console.log('✅ All permissions processed');
    } catch (err) {
      console.error('⚠️ Could not auto-grant permissions:', err.message);
    }

    // ── Create Database Indexes for Performance ──
    try {
      const db = strapi.db;

      const addIndexIfNotExists = async (tableName, indexName, columns) => {
        try {
          const result = await db.connection.raw(
            `SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_NAME = ? AND INDEX_NAME = ?`,
            [tableName, indexName]
          );

          if (result[0].length === 0) {
            await db.connection.raw(
              `ALTER TABLE ${tableName} ADD INDEX ${indexName} (${columns})`
            );
            console.log(`✅ Created index: ${indexName}`);
          }
        } catch (err) {
          // Suppress - indexes aren't critical
        }
      };

      await addIndexIfNotExists('exit_requests', 'student_statuse_idx', 'student_id, statuse');
      await addIndexIfNotExists('exit_requests', 'student_statuse_expires_idx', 'student_id, statuse, expires_at');
      await addIndexIfNotExists('exit_requests', 'statuse_expires_idx', 'statuse, expires_at');
      // qr_tokens: fast lookup by expiry for nightly cron cleanup
      await addIndexIfNotExists('qr_tokens', 'qr_expires_consumed_idx', 'expires_at, consumed');
      await addIndexIfNotExists('qr_tokens', 'qr_token_idx', 'token(255)');

      console.log('✅ Phase 1 Indexes: Ready for optimized queries');
    } catch (err) {
      // Silently fail
    }
  },
};
