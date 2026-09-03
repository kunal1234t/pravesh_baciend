'use strict';

const admin = require('firebase-admin');
const { metrics } = require('./metrics');

function classifyFcmFailure(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();

  if (code.includes('registration-token') || code.includes('messaging/invalid') || message.includes('registration token')) {
    return 'invalid_token';
  }
  if (code.includes('credential') || message.includes('oauth') || message.includes('access token') || message.includes('invalid_grant')) {
    return 'oauth';
  }
  if (code.includes('econn') || code.includes('enotfound') || code.includes('timeout') || message.includes('network')) {
    return 'network';
  }
  return 'other';
}

/**
 * Notification Service - Handles Firebase Cloud Messaging (FCM) push notifications
 * and notification history tracking
 */

class NotificationService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize Firebase Admin SDK
   * Called on app bootstrap
   */
  async init() {
    try {
      // Check if already initialized
      if (admin.apps.length > 0) {
        this.initialized = true;
        console.log('✅ Firebase Admin SDK already initialized');
        return;
      }

      // Initialize with environment variables
      const serviceAccount = {
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      };

      // Only initialize if credentials are provided
      if (serviceAccount.project_id) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        this.initialized = true;
        console.log('✅ Firebase Admin SDK initialized successfully');
      } else {
        console.warn('⚠️ Firebase credentials not provided - FCM disabled (Socket.IO only)');
      }
    } catch (err) {
      console.error('❌ Firebase initialization failed:', err.message);
      this.initialized = false;
    }
  }

  /**
   * Send push notification via FCM
   * @param {string} fcmToken - Device FCM token
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data to send
   * @returns {Promise<string>} Message ID if successful
   */
  async sendPushNotification(fcmToken, title, body, data = {}) {
    if (!this.initialized || !admin.apps.length) {
      metrics.fcmNotificationsTotal.inc({ result: 'skipped' });
      metrics.fcmFailuresTotal.inc({ reason: 'not_initialized' });
      console.warn('⚠️ Firebase not initialized - FCM skipped');
      return null;
    }

    if (!fcmToken) {
      throw new Error('FCM token is required');
    }

    try {
      // Stringify all data values (FCM requires string values only)
      const stringifiedData = {};
      for (const [key, value] of Object.entries(data)) {
        stringifiedData[key] = String(value);
      }

      const message = {
        notification: {
          title: title,
          body: body,
        },
        data: {
          ...stringifiedData,
          timestamp: new Date().toISOString(),
        },
        android: {
          notification: {
            channelId: 'pravesh_alerts',
            icon: 'ic_stat_pravesh_logo',
            color: '#177A4C',
            priority: 'high',
          },
        },
        token: fcmToken,
      };

      const messageId = await admin.messaging().send(message);
      metrics.fcmNotificationsTotal.inc({ result: 'success' });
      console.log(`✅ Push notification sent. Message ID: ${messageId}`);
      return messageId;
    } catch (err) {
      metrics.fcmNotificationsTotal.inc({ result: 'error' });
      metrics.fcmFailuresTotal.inc({ reason: classifyFcmFailure(err) });
      console.error(`❌ Failed to send push notification: ${err.message}`);
      throw err;
    }
  }

  /**
   * Send push notification to multiple users with retry logic
   * @param {array} userIds - Array of user IDs
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data
   * @param {number} maxRetries - Max retry attempts
   */
  async sendBatchNotifications(userIds, title, body, data = {}, maxRetries = 3) {
    const results = {
      sent: [],
      failed: [],
      skipped: [],
    };

    for (const userId of userIds) {
      try {
        // Get user with FCM token (use raw SQL for manually-added fcm_token column)
        const userRows = await strapi.db.connection.raw(
          'SELECT id, username, fcm_token FROM up_users WHERE id = ?',
          [userId]
        );
        
        const user = userRows[0][0]; // Raw query returns array of results
        
        if (!user) {
          results.skipped.push({ userId, reason: 'User not found' });
          continue;
        }

        if (!user.fcm_token) {
          console.log(`⚠️ No FCM token for user ${userId}, using Socket.IO only`);
          results.skipped.push({ userId, reason: 'No FCM token' });
          continue;
        }

        // Try sending with retry logic
        await this.sendWithRetry(user.fcm_token, title, body, data, maxRetries, userId);
        results.sent.push(userId);
      } catch (err) {
        console.error(`❌ Failed to send to user ${userId}: ${err.message}`);
        results.failed.push({ userId, error: err.message });
      }
    }

    return results;
  }

  /**
   * Send notification with exponential backoff retry
   * @private
   */
  async sendWithRetry(fcmToken, title, body, data, maxRetries, userId) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendPushNotification(fcmToken, title, body, data);
        return; // Success
      } catch (err) {
        lastError = err;
        console.warn(`Attempt ${attempt}/${maxRetries} for user ${userId}: ${err.message}`);

        if (attempt < maxRetries) {
          // Exponential backoff: 500ms, 1s, 2s
          const delay = Math.pow(2, attempt - 1) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Log notification in history using direct database query
   * @param {object} notificationData - Notification details
   */
  async logNotification(notificationData) {
    try {
      const {
        recipientId,
        type,
        title,
        body,
        relatedId,
        deliveryStatus = 'pending',
        deliveryMethod = 'socket',
        failureReason = null,
        retryCount = 0,
      } = notificationData;

      // Validate recipientId
      if (!recipientId || recipientId === 'undefined' || recipientId === null) {
        console.warn(`⚠️ Skipping notification log: invalid recipientId`);
        return;
      }

      try {
        // Use raw database query to bypass schema issues
        const connection = strapi.db.connection;
        
        if (connection) {
          await connection('notification_histories').insert({
            recipient: recipientId,
            type,
            title,
            body,
            related_id: String(relatedId || ''),
            delivery_status: deliveryStatus,
            delivery_method: deliveryMethod,
            failure_reason: failureReason,
            retry_count: retryCount,
            created_at: new Date(),
            updated_at: new Date(),
          });
          
          console.log(`✅ Notification logged for user ${recipientId}`);
          return;
        }
      } catch (dbErr) {
        console.warn(`⚠️ Database logging failed: ${dbErr.message}`);
      }

      // Fallback: Try Strapi entityService if available
      try {
        await strapi.entityService.create('api::notification-history.notification-history', {
          data: {
            recipient: recipientId,
            type,
            title,
            body,
            relatedId: String(relatedId),
            deliveryStatus,
            deliveryMethod,
            failureReason,
            retryCount,
          },
        });
        console.log(`✅ Notification logged for user ${recipientId} (via entityService)`);
      } catch (entityErr) {
        // Collection not available, audit log only
        console.warn(`⚠️ Notification logging unavailable, audit log: User=${recipientId}, Type=${type}, Status=${deliveryStatus}, Related=${relatedId}`);
      }
    } catch (err) {
      console.error(`❌ Error in logNotification: ${err.message}`);
    }
  }

  /**
   * Validate recipient can receive notifications
   */
  async validateRecipient(userId) {
    try {
      const user = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        userId,
        { populate: ['role'] }
      );

      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      const allowedRoles = ['Professor', 'professor', 'Teacher', 'teacher', 'Warden', 'warden', 'Admin', 'admin'];
      if (user.role && !allowedRoles.includes(user.role.name)) {
        throw new Error(
          `User role "${user.role.name}" cannot receive visitor notifications`
        );
      }

      // Also get FCM token from database directly
      const userWithToken = await strapi.db.connection.raw(
        'SELECT fcm_token FROM up_users WHERE id = ?',
        [userId]
      );
      
      if (userWithToken[0].length > 0) {
        user.fcmToken = userWithToken[0][0].fcm_token;
      }

      return user;
    } catch (err) {
      console.error(`❌ Recipient validation failed: ${err.message}`);
      throw err;
    }
  }
}

// Export singleton instance
module.exports = new NotificationService();
