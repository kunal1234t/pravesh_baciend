'use strict';

module.exports = {
  async createByGuard(ctx) {
    const user = ctx.state.user;

    if (user.role.name !== 'Guard') {
      return ctx.forbidden('Only guards can create visitors');
    }

    const { name, phone, purpose, teacherId } = ctx.request.body;

    const visitor = await strapi.entityService.create(
      'api::visitor.visitor',
      {
        data: {
          name,
          phone,
          purpose,
          status: 'pending',
          teacher: teacherId,
          guard: user.id,
        },
      }
    );

    return ctx.send(visitor);
  },

  async pendingForTeacher(ctx) {
    const user = ctx.state.user;

    if (user.role.name !== 'Teacher') {
      return ctx.forbidden('Only teachers allowed');
    }

    const visitors = await strapi.entityService.findMany(
      'api::visitor.visitor',
      {
        filters: {
          teacher: user.id,
          status: 'pending',
        },
        populate: ['guard'],
      }
    );

    return ctx.send(visitors);
  },

  async approve(ctx) {
    const user = ctx.state.user;
    const { id } = ctx.params;

    if (user.role.name !== 'Teacher') {
      return ctx.forbidden('Only teachers can approve');
    }

    const visitor = await strapi.entityService.findOne(
      'api::visitor.visitor',
      id,
      { populate: ['teacher'] }
    );

    if (!visitor || visitor.teacher.id !== user.id) {
      return ctx.forbidden('Not your visitor');
    }

    const updated = await strapi.entityService.update(
      'api::visitor.visitor',
      id,
      {
        data: {
          status: 'approved',
          approvedAt: new Date(),
        },
      }
    );

    return ctx.send(updated);
  },

  async reject(ctx) {
    const user = ctx.state.user;
    const { id } = ctx.params;

    if (user.role.name !== 'Teacher') {
      return ctx.forbidden('Only teachers can reject');
    }

    const updated = await strapi.entityService.update(
      'api::visitor.visitor',
      id,
      {
        data: { status: 'rejected' },
      }
    );

    return ctx.send(updated);
  },
};
