'use strict';

const nightCompliance = require('../../night-compliance');

const hasValidGateKey = (ctx) => {
  const expectedKey = process.env.GATE_API_KEY;
  const suppliedKey = ctx.request.headers['x-gate-api-key'];
  return Boolean(expectedKey) && suppliedKey === expectedKey;
};

const findStudent = async (identifier) => {
  const value = identifier.trim();
  const email = value.includes('@') ? value.toLowerCase() : `${value.toLowerCase()}@iiitn.ac.in`;

  return strapi.db.query('plugin::users-permissions.user').findOne({
    where: {
      $or: [
        { email },
        { username: value },
      ],
    },
  });
};

const dayKey = (value) => new Date(value).toISOString().slice(0, 10);
const hourKey = (value) => new Date(value).toISOString().slice(0, 13) + ':00';

const incrementBucket = (buckets, key, field) => {
  if (!buckets.has(key)) buckets.set(key, { entries: 0, exits: 0 });
  buckets.get(key)[field] += 1;
};

module.exports = {
  async dashboard(ctx) {
    if (!hasValidGateKey(ctx)) {
      return ctx.unauthorized('Invalid gate credentials');
    }

    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.start_date || '')
      ? ctx.query.start_date
      : dayKey(new Date());
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.end_date || '')
      ? ctx.query.end_date
      : startDate;
    const btidFilter = (ctx.query.btid || '').trim().toLowerCase();
    const nameFilter = (ctx.query.name || '').trim().toLowerCase();

    try {
      const requests = await strapi.entityService.findMany('api::exit-request.exit-request', {
        filters: { statuse: { $in: ['EXITED', 'ENTERED'] } },
        populate: ['student'],
        sort: { createdAt: 'desc' },
        limit: 1000,
      });
      const normalized = requests.map((request) => {
        const student = request.student || {};
        const btid = (student.email || student.username || '').split('@')[0];
        return {
          id: request.id,
          btid,
          name: student.username || 'Unknown',
          contact: student.phone_number || null,
          exit_time: request.consumedAt || request.createdAt,
          entry_time: request.entryTime || null,
          exit_reason: request.reasonDetails || request.reasonType || null,
          status: request.statuse,
          allowed: request.statuse !== 'REJECTED',
        };
      });
      const matches = (row) =>
        (!btidFilter || row.btid.toLowerCase().includes(btidFilter)) &&
        (!nameFilter || row.name.toLowerCase().includes(nameFilter));
      const inRange = (value) => value && dayKey(value) >= startDate && dayKey(value) <= endDate;
      const filtered = normalized.filter((row) => matches(row));
      const rows = filtered
        .filter((row) => inRange(row.exit_time))
        .map((row) => ({ ...row, type: row.entry_time ? 'pair' : 'single' }));
      const currentlyOutside = normalized
        .filter((row) => row.status === 'EXITED')
        .map((row) => ({ ...row, last_time: row.exit_time }));

      const hourlyBuckets = new Map();
      const dailyBuckets = new Map();
      const monthlyBuckets = new Map();
      for (const row of filtered) {
        if (inRange(row.exit_time)) {
          incrementBucket(hourlyBuckets, hourKey(row.exit_time), 'exits');
        }
        if (row.entry_time && inRange(row.entry_time)) {
          incrementBucket(hourlyBuckets, hourKey(row.entry_time), 'entries');
        }
        if (row.exit_time) incrementBucket(dailyBuckets, dayKey(row.exit_time), 'exits');
        if (row.entry_time) incrementBucket(dailyBuckets, dayKey(row.entry_time), 'entries');
        if (row.exit_time) incrementBucket(monthlyBuckets, dayKey(row.exit_time).slice(0, 7), 'exits');
        if (row.entry_time) incrementBucket(monthlyBuckets, dayKey(row.entry_time).slice(0, 7), 'entries');
      }

      return ctx.send({
        start_date: startDate,
        end_date: endDate,
        total_scans_range: rows.length + rows.filter((row) => row.entry_time && inRange(row.entry_time)).length,
        unique_exits_range: rows.length,
        unique_entries_range: rows.filter((row) => row.entry_time && inRange(row.entry_time)).length,
        completed_range: rows.filter((row) => row.entry_time).length,
        currently_outside_count: currentlyOutside.length,
        currently_outside: currentlyOutside,
        outside_set: currentlyOutside.map((row) => row.btid),
        rows,
        hourly: [...hourlyBuckets.entries()].sort().map(([hour, data]) => ({ hour, ...data })),
        daily: [...dailyBuckets.entries()].sort().map(([day, data]) => ({ day, ...data })),
        monthly: [...monthlyBuckets.entries()].sort().map(([month, data]) => ({ month, ...data })),
      });
    } catch (error) {
      strapi.log.error('Hardware dashboard fetch failed', error);
      return ctx.internalServerError('Could not load dashboard data');
    }
  },

  async markInside(ctx) {
    if (!hasValidGateKey(ctx)) {
      return ctx.unauthorized('Invalid gate credentials');
    }

    const identifier = ctx.params.identifier;
    if (!identifier || identifier.length > 150) {
      return ctx.badRequest('A valid student identifier is required');
    }

    try {
      const student = await findStudent(identifier);
      if (!student) return ctx.notFound('Student not found');

      const activeExit = await strapi.db.query('api::exit-request.exit-request').findOne({
        where: { student: student.id, statuse: 'EXITED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!activeExit) return ctx.badRequest('Student is not currently marked outside');

      const enteredAt = new Date();
      await strapi.db.transaction(async () => {
        await strapi.entityService.update('api::exit-request.exit-request', activeExit.id, {
          data: {
            statuse: 'ENTERED',
            entryTime: enteredAt,
            scannerId: 'HARDWARE_DASHBOARD',
          },
        });
        await strapi.entityService.create('api::scan-log.scan-log', {
          data: {
            exit_request: activeExit.id,
            result: 'verified',
            scannedAt: enteredAt,
            reason: 'Manual entry recorded from hardware dashboard',
          },
        });
      });

      await nightCompliance.emitOutsideStudentStatusUpdated(student.id);
      return ctx.send({
        message: 'Student marked inside',
        student: { id: student.id, username: student.username, email: student.email },
        exitRequestId: activeExit.id,
        enteredAt: enteredAt.toISOString(),
      });
    } catch (error) {
      strapi.log.error('Hardware dashboard markInside failed', error);
      return ctx.internalServerError('Could not mark the student inside');
    }
  },
};
