'use strict';

const admin = require('firebase-admin');
const redisClient = require('../../redis-client');

// Temporary operational switch. Device binding is disabled unless this is
// explicitly set to "true" in the backend environment.
const deviceBindingEnabled = process.env.DEVICE_BINDING_ENABLED === 'true';

module.exports = {
  async login(ctx) {
    try {
      const { idToken, deviceID } = ctx.request.body;

      if (!idToken) {
        return ctx.badRequest('Missing idToken');
      }

      // Verify the ID token using Firebase Admin
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        return ctx.unauthorized('Invalid or expired Firebase token');
      }

      const email = decodedToken.email;
      if (!email) {
        return ctx.badRequest('No email found in token');
      }

      // ── Rate Limit: 10 login attempts per email per minute ──
      const rlAllowed = await redisClient.checkRateLimit(`rl:login:${email}`, 10, 60);
      if (!rlAllowed) {
        return ctx.tooManyRequests('Too many login attempts. Please wait a moment.');
      }

      // Validate Domain
      if (!email.toLowerCase().endsWith('@iiitn.ac.in')) {
        return ctx.forbidden('Unauthorized Domain. Please use your @iiitn.ac.in email.');
      }

      // Look for the user using Strapi Document Service / Entity Service
      let user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email },
        populate: ['role'],
      });

      let isNewUser = false;

      if (!user) {
        // Find the 'Student' role. Fallback to ID 2 as per prompt.
        let studentRole = await strapi.db.query('plugin::users-permissions.role').findOne({
          where: { name: 'Student' }
        });

        const roleId = studentRole ? studentRole.id : 2;

        // --- 0. Prevent registering a new user with an already-bound device ---
        if (deviceBindingEnabled && deviceID) {
          const existingDeviceUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { deviceID },
          });
          if (existingDeviceUser) {
            console.log('❌ Registration blocked: device already bound to another user:', deviceID);
            return ctx.forbidden('This device is already bound to another account.');
          }
        }

        // Create the user
        const randomPassword = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-10);
        
        user = await strapi.entityService.create('plugin::users-permissions.user', {
          data: {
            username: decodedToken.name || email.split('@')[0],
            email: email,
            password: randomPassword,
            provider: 'local', // We can still call it local or google
            confirmed: true,
            blocked: false,
            role: roleId,
            deviceID: deviceBindingEnabled ? (deviceID || null) : null,
          },
          populate: ['role'],
        });

        isNewUser = true;
        console.log('✅ New user created via Firebase with email:', email);
      } else {
        // --- 1. Enforce deviceID check even if missing from request ---
        if (deviceBindingEnabled && user.deviceID) {
          if (!deviceID || user.deviceID !== deviceID) {
            console.log('❌ Login blocked: different device for user:', email);
            return ctx.forbidden('User already logged in on another device');
          }
        } 
        
        // --- 2. Auto-bind logic (+ Prevent multiple accounts on 1 device) ---
        else if (deviceBindingEnabled && deviceID) {
          // Check if this device is ALREADY bound to ANY other account
          const existingDeviceUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { deviceID },
          });

          if (existingDeviceUser && existingDeviceUser.id !== user.id) {
            console.log('❌ Login blocked: device already bound to another user:', deviceID);
            return ctx.forbidden('This device is already bound to another account.');
          }

          // Auto-bind device if no conflict
          await strapi.entityService.update(
            'plugin::users-permissions.user',
            user.id,
            {
              data: { deviceID },
            }
          );
          user.deviceID = deviceID; // Update local user object for the response
          console.log('✅ Device bound for existing user:', email, 'Device ID:', deviceID);
        }
      }

      // Issue JWT
      const jwt = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });

      // Return unified response
      ctx.send({
        jwt,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone || null,
          provider: user.provider,
          role: user.role,
          deviceID: user.deviceID || null,
        },
      });
    } catch (error) {
      console.error('Firebase Login Error:', error);
      return ctx.internalServerError('Internal Server Error');
    }
  },
};
