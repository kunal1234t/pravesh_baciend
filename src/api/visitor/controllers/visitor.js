'use strict';

const notificationService = require('../../notification-service');
const printerService = require('../../printer-service');

const verifyJwt = async (ctx) => {
  const authHeader = ctx.request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
  const jwtService = strapi.plugin('users-permissions').service('jwt');
  try {
    const payload = await jwtService.verify(token);
    const user = await strapi.entityService.findOne(
      'plugin::users-permissions.user',
      payload.id,
      { populate: ['role'] }
    );
    return user;
  } catch {
    return null;
  }
};

// Case-insensitive role name check
const isRole = (user, roleName) =>
  user?.role?.name?.toLowerCase() === roleName.toLowerCase();

module.exports = {
  async getStaff(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can fetch staff');

      const roles = await strapi.entityService.findMany('plugin::users-permissions.role', {
        filters: { name: { $in: ['Teacher', 'Warden', 'teacher', 'warden'] } },
      });
      const roleIds = roles.map((r) => r.id);

      const staff = await strapi.entityService.findMany('plugin::users-permissions.user', {
        filters: { role: { id: { $in: roleIds } } },
        populate: ['role'],
        sort: { username: 'asc' },
      });

      return ctx.send({
        data: staff.map((s) => ({
          id: s.id,
          username: s.username,
          email: s.email,
          role: s.role?.name ?? '',
        })),
      });
    } catch (err) {
      console.error('❌ getStaff ERROR:', err);
      return ctx.internalServerError('Failed to fetch staff');
    }
  },

  async createByGuard(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can create visitors');

      const { name, phone, purpose, assignedToId, photoId, entryType = 'visitor' } = ctx.request.body;
      if (!name || !phone || !purpose || !assignedToId) {
        return ctx.badRequest('name, phone, purpose and assignedToId are required');
      }
      if (!['visitor', 'delivery'].includes(entryType)) {
        return ctx.badRequest('entryType must be visitor or delivery');
      }
      const isDelivery = entryType === 'delivery';

      const visitor = await strapi.entityService.create('api::visitor.visitor', {
        data: {
          name,
          phone: String(phone),
          purpose,
          entryType,
          stat: isDelivery ? 'checked_in' : 'pending',
          isInside: isDelivery,
          ...(isDelivery ? { checkedInAt: new Date() } : {}),
          guard: user.id,
          users_permissions_user: assignedToId,
          ...(photoId ? { photo: [photoId] } : {}),
        },
        populate: ['photo'],
      });

      // Deliveries skip the approval queue and related notifications.
      if (!isDelivery) try {
        await notifyVisitorRequest(assignedToId, {
          visitorId: visitor.id,
          visitorName: name,
          visitorPurpose: purpose,
          guardName: user.username,
          createdAt: visitor.createdAt,
          photoUrl: visitor.photo?.[0]?.url,
        });
      } catch (err) {
        console.error('❌ Notification error (non-critical):', err.message);
        // Don't break visitor creation if notification fails
      }

      return ctx.send(visitor);
    } catch (err) {
      console.error('❌ createByGuard ERROR:', err);
      return ctx.internalServerError('Failed to create visitor');
    }
  },

  async scheduleVisitor(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      const role = user?.role?.name?.toLowerCase();
      if (role !== 'teacher' && role !== 'warden') {
        return ctx.forbidden('Only teachers or wardens can schedule visitors');
      }

      const { name, phone, expectedAt, purpose } = ctx.request.body;
      if (!name || !phone || !expectedAt) {
        return ctx.badRequest('name, phone and expectedAt are required');
      }

      const expectedDate = new Date(expectedAt);
      if (Number.isNaN(expectedDate.getTime())) {
        return ctx.badRequest('expectedAt is invalid');
      }

      const visitor = await strapi.entityService.create('api::visitor.visitor', {
        data: {
          name,
          phone: String(phone),
          purpose: purpose || 'Scheduled visit',
          stat: 'pre_approved',
          expectedAt: expectedDate.toISOString(),
          isInside: false,
          scheduledBy: user.id,
          users_permissions_user: user.id,
        },
      });

      return ctx.send(visitor);
    } catch (err) {
      console.error('❌ scheduleVisitor ERROR:', err);
      return ctx.internalServerError('Failed to schedule visitor');
    }
  },

  async guardMine(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      
      // SECURITY FIX: Verify user is a guard
      const userWithRole = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: user.id },
        populate: ['role']
      });
      const userRole = userWithRole?.role?.name?.toLowerCase();
      if (userRole !== 'guard') {
        console.error(`🚨 SECURITY: User ${user.id} with role '${userRole}' attempted to access guard-only endpoint`);
        return ctx.forbidden('Only guards can access this endpoint');
      }

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: { guard: user.id },
        populate: ['users_permissions_user', 'photo'],
        sort: { createdAt: 'desc' },
        limit: 20,
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ guardMine ERROR:', err);
      return ctx.internalServerError('Failed to fetch visitors');
    }
  },

  async guardInside(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can access this endpoint');

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: { isInside: true },
        populate: ['users_permissions_user', 'photo', 'guard', 'scheduledBy'],
        sort: { checkedInAt: 'desc' },
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ guardInside ERROR:', err);
      return ctx.internalServerError('Failed to fetch inside visitors');
    }
  },

  async guardScheduled(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can access this endpoint');

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: { stat: 'pre_approved', isInside: false },
        populate: ['users_permissions_user', 'photo', 'scheduledBy'],
        sort: { expectedAt: 'asc' },
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ guardScheduled ERROR:', err);
      return ctx.internalServerError('Failed to fetch scheduled visitors');
    }
  },

  async guardCheckIn(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can check in visitors');

      const { id } = ctx.params;
      const { photoId } = ctx.request.body || {};
      const parsedPhotoId = Number(photoId);
      const photoData =
        Number.isInteger(parsedPhotoId) && parsedPhotoId > 0
          ? { photo: [parsedPhotoId] }
          : {};
      let visitor = null;
      const numericId = Number(id);
      if (Number.isInteger(numericId) && numericId > 0) {
        visitor = await strapi.entityService.findOne('api::visitor.visitor', numericId, {
          populate: ['guard'],
        });
      }
      if (!visitor) {
        const matches = await strapi.entityService.findMany('api::visitor.visitor', {
          filters: { documentId: id },
          populate: ['guard'],
          limit: 1,
        });
        visitor = matches?.[0] ?? null;
      }
      if (!visitor) return ctx.notFound('Visitor not found');
      if (visitor.isInside === true) return ctx.badRequest('Visitor already inside');
      if (!['pre_approved', 'approved'].includes(visitor.stat)) {
        return ctx.badRequest(`Visitor is ${visitor.stat}, cannot check in`);
      }

      const updated = await strapi.entityService.update('api::visitor.visitor', visitor.id, {
        data: {
          stat: 'checked_in',
          isInside: true,
          checkedInAt: new Date(),
          guard: visitor.guard?.id ?? user.id,
          ...photoData,
        },
      });

      if (visitor.entryType !== 'delivery') {
        await triggerVisitorPassPrint({
          visitor: { ...visitor, guard: { username: user.username } },
          approverName: user.username,
          requestId: visitor.documentId ?? visitor.id,
        });
      }

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ guardCheckIn ERROR:', err);
      return ctx.internalServerError('Failed to check in visitor');
    }
  },

  async guardMarkExit(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Guard')) return ctx.forbidden('Only guards can mark exit');

      const { id } = ctx.params;
      const visitor = await strapi.entityService.findOne('api::visitor.visitor', id);
      if (!visitor) return ctx.notFound('Visitor not found');
      if (visitor.isInside !== true) return ctx.badRequest('Visitor is not inside');

      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: {
          stat: 'exited',
          isInside: false,
          checkedOutAt: new Date(),
        },
      });

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ guardMarkExit ERROR:', err);
      return ctx.internalServerError('Failed to mark visitor exit');
    }
  },

  async getStatus(ctx) {
    try {
      const { id } = ctx.params;
      const visitor = await strapi.entityService.findOne('api::visitor.visitor', id, {
        populate: ['users_permissions_user', 'photo', 'guard'],
      });
      if (!visitor) return ctx.notFound('Visitor not found');
      return ctx.send(visitor);
    } catch (err) {
      console.error('❌ getStatus ERROR:', err);
      return ctx.internalServerError('Failed to fetch visitor status');
    }
  },

  async pendingForTeacher(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Teacher')) return ctx.forbidden('Only teachers allowed');

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: {
          users_permissions_user: user.id,
          stat: 'pending',
        },
        populate: ['guard', 'photo'],
        sort: { createdAt: 'desc' },
      });

      return ctx.send(visitors);
    } catch (err) {
      console.error('❌ pendingForTeacher ERROR:', err);
      return ctx.internalServerError('Failed to fetch visitors');
    }
  },

  async historyForStaff(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      const role = user?.role?.name?.toLowerCase();
      if (role !== 'teacher' && role !== 'warden') {
        return ctx.forbidden('Only teachers or wardens can view history');
      }

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: {
          users_permissions_user: user.id,
          stat: { $in: ['approved', 'rejected', 'checked_in', 'exited'] },
        },
        populate: ['guard', 'photo', 'scheduledBy'],
        sort: { updatedAt: 'desc' },
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ historyForStaff ERROR:', err);
      return ctx.internalServerError('Failed to fetch visitor history');
    }
  },

  async pendingForWarden(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can view this list');

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: {
          users_permissions_user: user.id,
          stat: 'pending',
        },
        populate: ['guard', 'photo'],
        sort: { createdAt: 'desc' },
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ pendingForWarden ERROR:', err);
      return ctx.internalServerError('Failed to fetch pending visitors');
    }
  },

  async wardenApprove(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can approve');

      const { id } = ctx.params;
      const visitor = await strapi.entityService.findOne('api::visitor.visitor', id, {
        populate: ['users_permissions_user', 'guard', 'photo'],
      });
      if (!visitor) return ctx.notFound('Visitor not found');
      if (visitor.entryType === 'delivery') {
        return ctx.badRequest('Deliveries are admitted directly and cannot be approved');
      }

      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: {
          stat: 'approved',
          approvedAt: new Date(),
          isInside: true,
          checkedInAt: new Date(),
        },
      });

      await triggerVisitorPassPrint({
        visitor,
        approverName: user.username,
        requestId: id,
      });
      return ctx.send(updated);
    } catch (err) {
      console.error('❌ wardenApprove ERROR:', err);
      return ctx.internalServerError('Failed to approve visitor');
    }
  },

  async wardenReject(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can reject');

      const { id } = ctx.params;
      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: { stat: 'rejected' },
      });
      return ctx.send(updated);
    } catch (err) {
      console.error('❌ wardenReject ERROR:', err);
      return ctx.internalServerError('Failed to reject visitor');
    }
  },

  async approve(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Teacher')) return ctx.forbidden('Only teachers can approve');

      const { id } = ctx.params;
      const visitor = await strapi.entityService.findOne('api::visitor.visitor', id, {
        populate: ['users_permissions_user', 'guard', 'photo'],
      });
      if (!visitor) return ctx.notFound('Visitor not found');
      if (visitor.entryType === 'delivery') {
        return ctx.badRequest('Deliveries are admitted directly and cannot be approved');
      }
      if (visitor.users_permissions_user?.id !== user.id) return ctx.forbidden('Not assigned to you');

      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: {
          stat: 'approved',
          approvedAt: new Date(),
          isInside: true,
          checkedInAt: new Date(),
        },
      });

      await triggerVisitorPassPrint({
        visitor,
        approverName: user.username,
        requestId: id,
      });

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ approve ERROR:', err);
      return ctx.internalServerError('Failed to approve visitor');
    }
  },

  async reject(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Teacher')) return ctx.forbidden('Only teachers can reject');

      const { id } = ctx.params;
      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: { stat: 'rejected' },
      });
      return ctx.send(updated);
    } catch (err) {
      console.error('❌ reject ERROR:', err);
      return ctx.internalServerError('Failed to reject visitor');
    }
  },
};

async function triggerVisitorPassPrint({ visitor, approverName, requestId }) {
  try {
    const printerPayload = {
      visitorId: visitor.id,
      name: visitor.name,
      phone: visitor.phone,
      purpose: visitor.purpose,
      assignedTo: approverName,
      teacherName: approverName,
      guardName: visitor.guard?.username || 'Guard',
      entryTime: new Date(),
      exitAfterHours: parseInt(process.env.VISITOR_PASS_VALID_HOURS || 8),
    };

    console.log(`📠 Sending printer job for visitor ${requestId}...`);
    const result = await printerService.printVisitorPass(printerPayload);
    if (result.success) {
      console.log(`✅ Visitor pass printed successfully for visitor ${requestId}`);
    } else {
      console.warn(`⚠️ Printer failed for visitor ${requestId}: ${result.status}`);
    }
  } catch (printerErr) {
    console.error(`❌ Printer service error for visitor ${requestId}: ${printerErr.message}`);
  }
}

/**
 * Helper function: Send visitor request notifications
 * Uses Socket.IO for real-time + FCM for push notifications
 */
async function notifyVisitorRequest(recipientId, visitorData) {
  try {
    // 1. Validate recipient
    const recipient = await notificationService.validateRecipient(recipientId);
    console.log(`✅ Recipient ${recipientId} validated`);

    // 2. Prepare notification data
    const title = `New Visitor: ${visitorData.visitorName}`;
    const body = `Purpose: ${visitorData.visitorPurpose}`;
    const notificationData = {
      visitorId: String(visitorData.visitorId),
      type: 'visitor_request',
      visitorName: visitorData.visitorName,
      purpose: visitorData.visitorPurpose,
      screen: 'pending_visitors',
    };

    // 3. Send Socket.IO event (real-time if online)
    const eventData = {
      id: visitorData.visitorId,
      name: visitorData.visitorName,
      purpose: visitorData.visitorPurpose,
      stat: 'pending',
      createdAt: visitorData.createdAt,
      photoUrl: visitorData.photoUrl,
      guardName: visitorData.guardName,
    };

    console.log(`📱 Emitting new-visitor-request to user:${recipientId}`);
    strapi.io?.to(`user:${recipientId}`).emit('new-visitor-request', eventData);

    // 4. Send FCM push notification if token exists
    let deliveryMethod = 'socket';
    let deliveryStatus = 'socket_only';

    if (recipient.fcmToken) {
      try {
        await notificationService.sendPushNotification(
          recipient.fcmToken,
          title,
          body,
          notificationData
        );
        deliveryMethod = 'both';
        deliveryStatus = 'sent';
        console.log(`✅ Push notification sent via FCM for visitor ${visitorData.visitorId}`);
      } catch (fcmErr) {
        console.warn(`⚠️ FCM failed (will use Socket.IO): ${fcmErr.message}`);
        deliveryStatus = 'socket_only';
      }
    } else {
      console.log(`⚠️ No FCM token for user ${recipientId}, Socket.IO only`);
    }

    // 5. Log notification in history
    await notificationService.logNotification({
      recipientId,
      type: 'visitor_request',
      title,
      body,
      relatedId: visitorData.visitorId,
      deliveryStatus,
      deliveryMethod,
    });

    console.log(`✅ Visitor request notification sent to ${recipientId}`);
  } catch (err) {
    console.error(`❌ Notification error for user ${recipientId}: ${err.message}`);
    throw err;
  }
}
