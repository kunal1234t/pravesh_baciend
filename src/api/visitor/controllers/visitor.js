'use strict';

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

      const { name, phone, purpose, assignedToId, photoId } = ctx.request.body;
      if (!name || !phone || !purpose || !assignedToId) {
        return ctx.badRequest('name, phone, purpose and assignedToId are required');
      }

      const visitor = await strapi.entityService.create('api::visitor.visitor', {
        data: {
          name,
          phone: String(phone),
          purpose,
          stat: 'pending',
          guard: user.id,
          users_permissions_user: assignedToId,
          ...(photoId ? { photo: [photoId] } : {}),
        },
      });

      // Notify the assigned teacher/warden via Socket.IO
      try {
        strapi.io?.to(`user:${assignedToId}`).emit('new-visitor-request', {
          visitorId: visitor.id,
          name,
          purpose,
          guardName: user.username,
        });
      } catch (e) {
        console.error('❌ Socket emit error (visitor create):', e);
      }

      return ctx.send(visitor);
    } catch (err) {
      console.error('❌ createByGuard ERROR:', err);
      return ctx.internalServerError('Failed to create visitor');
    }
  },

  async guardMine(ctx) {
    try {
      const user = await verifyJwt(ctx);
      if (!user) return ctx.unauthorized('Invalid token');

      const visitors = await strapi.entityService.findMany('api::visitor.visitor', {
        filters: { guard: user.id },
        populate: ['users_permissions_user'],
        sort: { createdAt: 'desc' },
        limit: 20,
      });

      return ctx.send({ data: visitors });
    } catch (err) {
      console.error('❌ guardMine ERROR:', err);
      return ctx.internalServerError('Failed to fetch visitors');
    }
  },

  async getStatus(ctx) {
    try {
      const { id } = ctx.params;
      const visitor = await strapi.entityService.findOne('api::visitor.visitor', id, {
        populate: ['users_permissions_user'],
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
      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: { stat: 'approved', approvedAt: new Date() },
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
        populate: ['users_permissions_user'],
      });
      if (!visitor) return ctx.notFound('Visitor not found');
      if (visitor.users_permissions_user?.id !== user.id) return ctx.forbidden('Not assigned to you');

      const updated = await strapi.entityService.update('api::visitor.visitor', id, {
        data: { stat: 'approved', approvedAt: new Date() },
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
