'use strict';

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

      const entry = await strapi.entityService.create('api::late-entry-request.late-entry-request', {
        data: {
          reason,
          destination: destination || '',
          emergencyContact: emergencyContact || '',
          expectedreturntime,
          stat: 'pending',
          users_permissions_user: user.id,
        },
      });

      // Notify all wardens via Socket.IO
      try {
        const wardenRoles = await strapi.db.query('plugin::users-permissions.role').findMany({
          where: { name: { $in: ['Warden', 'warden'] } },
        });
        for (const role of wardenRoles) {
          const wardens = await strapi.db.query('plugin::users-permissions.user').findMany({
            where: { role: role.id },
          });
          wardens.forEach((w) => {
            strapi.io?.to(`user:${w.id}`).emit('new-late-entry-request', {
              requestId: entry.id,
              studentName: user.username,
              reason,
              destination: destination || '',
            });
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
      return ctx.send(entries[0]);
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

      const updated = await strapi.entityService.update('api::late-entry-request.late-entry-request', id, {
        data: { stat: 'approved', approvedAt: new Date(), approvedBy: user.id },
      });

      // Notify student
      const studentId = entry.users_permissions_user?.id;
      if (studentId) {
        strapi.io?.to(`user:${studentId}`).emit('late-entry-approved', {
          requestId: id,
          studentId,
          studentName: entry.users_permissions_user?.username,
        });
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
        strapi.io?.to(`user:${studentId}`).emit('late-entry-rejected', { requestId: id });
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
