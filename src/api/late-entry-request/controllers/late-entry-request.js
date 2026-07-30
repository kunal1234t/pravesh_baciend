'use strict';
const notificationService = require('../../notification-service');
const nightCompliance = require('../../night-compliance');

const verifyJwt = async (ctx) => {
  const authHeader = ctx.request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.replace('Bearer ', '');
  const jwtService = strapi.plugin('users-permissions').service('jwt');
  try {
    const payload = await jwtService.verify(token);
    return await strapi.entityService.findOne(
      'plugin::users-permissions.user',
      payload.id,
      { populate: ['role'] }
    );
  } catch {
    return null;
  }
};

const isRole = (user, roleName) =>
  user?.role?.name?.toLowerCase() === roleName.toLowerCase();

const getIstNow = () =>
  new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  );

const parseExpectedReturnTime = (raw) => {
  if (!raw) return null;
  const timeOnly = /^\d{1,2}:\d{2}$/.test(raw);
  if (timeOnly) {
    const [hourStr, minuteStr] = raw.split(':');
    const nowIst = getIstNow();
    const candidate = new Date(nowIst);
    candidate.setHours(parseInt(hourStr, 10), parseInt(minuteStr, 10), 0, 0);
    return candidate;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(parsed.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
};

const normalizeExpectedReturn = (raw) => {
  const nowIst = getIstNow();
  let expected = parseExpectedReturnTime(raw);
  if (!expected) {
    return { error: 'expectedreturntime is invalid' };
  }

  if (expected <= nowIst) {
    expected = new Date(expected.getTime() + 24 * 60 * 60 * 1000);
  }

  const maxAllowed = new Date(nowIst.getTime() + 24 * 60 * 60 * 1000);
  if (expected > maxAllowed) {
    return { error: 'expectedreturntime must be within the next 24 hours' };
  }

  const validUntil = new Date(expected.getTime() + 60 * 60 * 1000);
  return { expected, validUntil };
};

const sendLateEntryRequestToWarden = async (wardenId, payload) => {
  strapi.io?.to(`user:${wardenId}`).emit('new-late-entry-request', {
    ...payload,
    userId: wardenId,
  });

  try {
    const wardenRows = await strapi.db.connection.raw(
      'SELECT fcm_token FROM up_users WHERE id = ?',
      [wardenId]
    );
    const fcmToken = wardenRows?.[0]?.[0]?.fcm_token;
    if (fcmToken) {
      await notificationService.sendPushNotification(
        fcmToken,
        'New Late Entry Request',
        `${payload.studentName} — ${payload.reason}`,
        {
          type: 'late_entry_request',
          requestId: String(payload.id),
          screen: 'late_entry_requests',
        }
      );
    }
  } catch (err) {
    console.warn(`⚠️ Late-entry warden push failed for user ${wardenId}: ${err.message}`);
  }
};

const sendLateEntryDecisionToStudent = async ({
  studentId,
  requestId,
  eventName,
  title,
  body,
  extraData = {},
}) => {
  strapi.io?.to(`user:${studentId}`).emit(eventName, {
    requestId,
    userId: studentId,
    ...extraData,
  });

  try {
    const studentRows = await strapi.db.connection.raw(
      'SELECT fcm_token FROM up_users WHERE id = ?',
      [studentId]
    );
    const fcmToken = studentRows?.[0]?.[0]?.fcm_token;
    if (fcmToken) {
      await notificationService.sendPushNotification(
        fcmToken,
        title,
        body,
        {
          type: eventName,
          requestId: String(requestId),
          screen: 'late_entry_status',
        }
      );
    }
  } catch (err) {
    console.warn(`⚠️ Late-entry student push failed for user ${studentId}: ${err.message}`);
  }
};

module.exports = {
  async submit(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Student')) return ctx.forbidden('Only students can submit leave requests');

      const { reason, destination, emergencyContact, expectedreturntime } = ctx.request.body;
      if (!reason || !expectedreturntime) {
        return ctx.badRequest('reason and expectedreturntime are required');
      }

      const normalized = normalizeExpectedReturn(expectedreturntime);
      if (normalized.error) {
        return ctx.badRequest(normalized.error);
      }

      const entry = await strapi.entityService.create('api::late-entry-request.late-entry-request', {
        data: {
          reason,
          destination: destination || '',
          emergencyContact: emergencyContact || '',
          expectedreturntime: normalized.expected.toISOString(),
          validUntil: normalized.validUntil.toISOString(),
          stat: 'pending',
          users_permissions_user: user.id,
        },
        populate: ['users_permissions_user'],
      });

      // Notify all wardens via Socket.IO with complete data for UI
      try {
        const wardenRoles = await strapi.db.query('plugin::users-permissions.role').findMany({
          where: { name: { $in: ['Warden', 'warden'] } },
        });
        for (const role of wardenRoles) {
          const wardens = await strapi.db.query('plugin::users-permissions.user').findMany({
            where: { role: role.id },
          });
          wardens.forEach((w) => {
            const eventData = {
              id: entry.id,
              studentName: user.username,
              reason,
              destination: destination || '',
              expectedreturntime: normalized.expected.toISOString(),
              validUntil: normalized.validUntil.toISOString(),
              createdAt: entry.createdAt,
              users_permissions_user: {
                id: user.id,
                username: user.username,
              },
            };

            console.log(`📱 Emitting new-late-entry-request to warden:${w.id}`, eventData);
            sendLateEntryRequestToWarden(w.id, eventData);
          });
        }
      } catch (e) {
        console.error('❌ Socket emit error (late-entry submit):', e);
      }

      return ctx.send(entry);
    } catch (err) {
      console.error('❌ submit ERROR:', err);
      return ctx.internalServerError('Failed to submit leave request');
    }
  },

  async history(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Student')) return ctx.forbidden('Only students can view history');

      const entries = await strapi.entityService.findMany('api::late-entry-request.late-entry-request', {
        filters: {
          users_permissions_user: user.id,
          stat: { $in: ['approved', 'entered', 'rejected'] },
        },
        sort: { createdAt: 'desc' },
      });

      const now = new Date();
      const history = entries.map((entry) => {
        const validUntil = entry.validUntil
          ? new Date(entry.validUntil)
          : entry.expectedreturntime
            ? new Date(new Date(entry.expectedreturntime).getTime() + 60 * 60 * 1000)
            : null;
        const enteredAt = entry.enteredAt ? new Date(entry.enteredAt) : null;

        let status = 'approved';
        if (entry.stat === 'entered') {
          if (validUntil && enteredAt && enteredAt > validUntil) {
            status = 'late';
          } else {
            status = 'approved';
          }
        } else if (entry.stat === 'approved') {
          if (validUntil && now > validUntil) {
            status = 'expired';
          } else {
            status = 'approved';
          }
        } else {
          status = 'expired';
        }

        return {
          id: entry.id,
          reason: entry.reason,
          expectedreturntime: entry.expectedreturntime,
          validUntil: validUntil ? validUntil.toISOString() : null,
          enteredAt: enteredAt ? enteredAt.toISOString() : null,
          createdAt: entry.createdAt,
          status,
        };
      });

      return ctx.send({ data: history });
    } catch (err) {
      console.error('❌ history ERROR:', err);
      return ctx.internalServerError('Failed to fetch history');
    }
  },

  async myStatus(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');

      const entries = await strapi.entityService.findMany('api::late-entry-request.late-entry-request', {
        filters: {
          users_permissions_user: user.id,
          stat: { $in: ['pending', 'approved'] },
        },
        sort: { createdAt: 'desc' },
        limit: 1,
      });

      if (!entries.length) return ctx.send(null);
      const entry = entries[0];

      // ── Auto-Expire Stale Records ── //
      const now = new Date();
      let derivedValidUntil = entry.validUntil
        ? new Date(entry.validUntil)
        : entry.expectedreturntime
          ? new Date(new Date(entry.expectedreturntime).getTime() + 60 * 60 * 1000)
          : null;

      if (!entry.validUntil && derivedValidUntil) {
        await strapi.entityService.update('api::late-entry-request.late-entry-request', entry.id, {
          data: { validUntil: derivedValidUntil.toISOString() },
        });
        entry.validUntil = derivedValidUntil.toISOString();
      }

      if (entry.stat === 'approved') {
        const validUntil = derivedValidUntil;
        const adminOverride = entry.adminOverride === true;
        if (validUntil && now > validUntil && !adminOverride) {
          console.log(`🧹 Auto-expiring late-entry request ${entry.id} (validUntil passed)`);
          await strapi.entityService.update('api::late-entry-request.late-entry-request', entry.id, {
            data: { stat: 'rejected' },
          });
          return ctx.send(null);
        }
      } else if (entry.stat === 'pending') {
        // Expire if pending for more than 24 hours
        const createdAt = new Date(entry.createdAt);
        const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
        
        if (now > expiresAt) {
          console.log(`🧹 Auto-expiring stale PENDING late-entry request ${entry.id}`);
          await strapi.entityService.update('api::late-entry-request.late-entry-request', entry.id, {
            data: { stat: 'rejected' },
          });
          return ctx.send(null);
        }
      }

      return ctx.send(entry);
    } catch (err) {
      console.error('❌ myStatus ERROR:', err);
      return ctx.internalServerError('Failed to fetch leave status');
    }
  },

  async wardenPending(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can view this list');

      const entries = await strapi.entityService.findMany('api::late-entry-request.late-entry-request', {
        filters: { stat: 'pending' },
        populate: ['users_permissions_user'],
        sort: { createdAt: 'desc' },
      });

      return ctx.send(entries);
    } catch (err) {
      console.error('❌ wardenPending ERROR:', err);
      return ctx.internalServerError('Failed to fetch pending requests');
    }
  },

  async approve(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can approve');

      const { id } = ctx.params;
      const entry = await strapi.entityService.findOne('api::late-entry-request.late-entry-request', id, {
        populate: ['users_permissions_user'],
      });
      if (!entry) return ctx.notFound('Request not found');

      const approvedAt = new Date();
      const validUntil = entry.validUntil
        ? new Date(entry.validUntil)
        : entry.expectedreturntime
          ? new Date(new Date(entry.expectedreturntime).getTime() + 60 * 60 * 1000)
          : null;

      const updated = await strapi.entityService.update('api::late-entry-request.late-entry-request', id, {
        data: {
          stat: 'approved',
          approvedAt,
          approvedBy: user.id,
          qrToken: null,
          ...(validUntil ? { validUntil: validUntil.toISOString() } : {}),
        },
      });

      // Notify student
      const studentId = entry.users_permissions_user?.id;
      if (studentId) {
        await sendLateEntryDecisionToStudent({
          studentId,
          requestId: id,
          eventName: 'late-entry-approved',
          title: 'Late Entry Approved',
          body: 'Your late entry request has been approved.',
          extraData: {
            approvedAt: approvedAt.toISOString(),
            studentId,
            studentName: entry.users_permissions_user?.username,
            validUntil: validUntil ? validUntil.toISOString() : null,
          },
        });
        await nightCompliance.emitOutsideStudentStatusUpdated(studentId);
      }

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ approve ERROR:', err);
      return ctx.internalServerError('Failed to approve request');
    }
  },

  async reject(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');
      if (!isRole(user, 'Warden')) return ctx.forbidden('Only wardens can reject');

      const { id } = ctx.params;
      const entry = await strapi.entityService.findOne('api::late-entry-request.late-entry-request', id, {
        populate: ['users_permissions_user'],
      });
      if (!entry) return ctx.notFound('Request not found');

      const updated = await strapi.entityService.update('api::late-entry-request.late-entry-request', id, {
        data: { stat: 'rejected' },
      });

      const studentId = entry.users_permissions_user?.id;
      if (studentId) {
        await sendLateEntryDecisionToStudent({
          studentId,
          requestId: id,
          eventName: 'late-entry-rejected',
          title: 'Late Entry Rejected',
          body: 'Your late entry request was rejected by the warden.',
        });
      }

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ reject ERROR:', err);
      return ctx.internalServerError('Failed to reject request');
    }
  },

  async markEntered(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');

      const { id } = ctx.params;
      const entry = await strapi.entityService.findOne('api::late-entry-request.late-entry-request', id, {
        populate: ['users_permissions_user'],
      });
      if (!entry) return ctx.notFound('Request not found');
      if (entry.stat !== 'approved') return ctx.badRequest('Request is not in approved state');

      const updated = await strapi.entityService.update('api::late-entry-request.late-entry-request', id, {
        data: { stat: 'entered', enteredAt: new Date() },
      });

      const studentId = entry.users_permissions_user?.id;
      if (studentId) {
        strapi.io?.to(`user:${studentId}`).emit('qr-validated', {
          allowed: true,
          action: 'enter campus',
        });
      }

      return ctx.send(updated);
    } catch (err) {
      console.error('❌ markEntered ERROR:', err);
      return ctx.internalServerError('Failed to mark entry');
    }
  },
};
