'use strict';

const STAFF_ROLE_NAMES = ['warden', 'guard'];

const getIstHour = (date = new Date()) => {
  const hour = date.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(hour, 10);
};

const isNightWindow = (date = new Date()) => {
  const hour = getIstHour(date);
  return hour >= 22 || hour < 5;
};

const getIstDateString = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
  }).format(date);

const isStaffRole = (roleName) =>
  STAFF_ROLE_NAMES.includes((roleName || '').toLowerCase());

const verifyUserFromAuthHeader = async (authHeader) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  const jwtService = strapi.plugin('users-permissions').service('jwt');

  let payload;
  try {
    payload = await jwtService.verify(token);
  } catch (_) {
    return null;
  }

  return strapi.entityService.findOne('plugin::users-permissions.user', payload.id, {
    populate: ['role'],
  });
};

const getStaffUserIds = async () => {
  const rows = await strapi.db.connection.raw(
    `SELECT DISTINCT u.id
     FROM up_users u
     INNER JOIN up_users_role_lnk lnk ON lnk.user_id = u.id
     INNER JOIN up_roles r ON r.id = lnk.role_id
     WHERE LOWER(r.name) IN (?, ?)`,
    STAFF_ROLE_NAMES
  );
  const users = rows?.[0] || [];
  return [...new Set(users.map((user) => String(user.id)))];
};

const fetchOutsideStudentsWithClassification = async () => {
  const exitedRequests = await strapi.entityService.findMany('api::exit-request.exit-request', {
    filters: { statuse: 'EXITED' },
    populate: ['student'],
    sort: { createdAt: 'desc' },
  });

  const approvedLateEntries = await strapi.entityService.findMany(
    'api::late-entry-request.late-entry-request',
    {
      filters: { stat: 'approved' },
      populate: ['users_permissions_user'],
      fields: ['id', 'validUntil', 'adminOverride'],
    }
  );

  const now = new Date();
  const approvedStudentIds = new Set(
    approvedLateEntries
      .filter((entry) => {
        if (entry?.adminOverride === true) return true;
        const validUntil = entry?.validUntil
          ? new Date(entry.validUntil)
          : entry?.expectedreturntime
            ? new Date(new Date(entry.expectedreturntime).getTime() + 60 * 60 * 1000)
            : null;
        return validUntil ? validUntil >= now : false;
      })
      .map((entry) => entry?.users_permissions_user?.id)
      .filter(Boolean)
      .map((id) => String(id))
  );

  const needsApproval = isNightWindow();

  const students = exitedRequests.map((request) => {
    const studentId = request?.student?.id ? String(request.student.id) : null;
    const hasApproval = studentId ? approvedStudentIds.has(studentId) : false;
    const nightApprovalStatus =
      !needsApproval || hasApproval ? 'approved' : 'not_approved';

    return {
      ...request,
      nightApprovalStatus,
      nightApprovalRequired: needsApproval,
    };
  });

  const withApprovalCount = students.filter(
    (student) => student.nightApprovalStatus === 'approved'
  ).length;
  const withoutApprovalCount = students.length - withApprovalCount;

  return {
    students,
    summary: {
      totalOutside: students.length,
      withApprovalCount,
      withoutApprovalCount,
      nightApprovalRequired: needsApproval,
      generatedAt: new Date().toISOString(),
    },
  };
};

const emitNightAlertSummary = async (summary, studentIds = []) => {
  const staffUserIds = await getStaffUserIds();
  if (!staffUserIds.length) {
    return { recipientIds: [], pushResult: null };
  }

  const payload = {
    ...summary,
    studentIds,
    timestamp: new Date().toISOString(),
    screen: 'students_outside',
  };

  for (const userId of staffUserIds) {
    strapi.io?.to(`user:${userId}`).emit('night-alert-summary', payload);
  }

  let pushResult = null;
  if (strapi.notificationService) {
    const title = '10 PM Alert';
    const body = `${summary.totalOutside} students outside, ${summary.withoutApprovalCount} without approval`;
    pushResult = await strapi.notificationService.sendBatchNotifications(
      staffUserIds,
      title,
      body,
      {
        type: 'night_alert_summary',
        screen: 'students_outside',
        totalOutside: summary.totalOutside,
        withoutApprovalCount: summary.withoutApprovalCount,
        withApprovalCount: summary.withApprovalCount,
      }
    );
  }

  return { recipientIds: staffUserIds, pushResult };
};

const emitOutsideStudentStatusUpdated = async (studentId) => {
  if (!studentId) return;

  const normalizedStudentId = String(studentId);
  const latestExit = await strapi.db.query('api::exit-request.exit-request').findOne({
    where: { student: normalizedStudentId },
    orderBy: { createdAt: 'desc' },
  });

  const isOutside = latestExit?.statuse === 'EXITED';
  const needsApproval = isNightWindow();

  let nightApprovalStatus = 'not_approved';
  if (isOutside) {
    const approved = await strapi.db.query('api::late-entry-request.late-entry-request').findOne({
      where: {
        users_permissions_user: normalizedStudentId,
        stat: 'approved',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!needsApproval) {
      nightApprovalStatus = 'approved';
    } else if (approved) {
      const validUntil = approved.validUntil
        ? new Date(approved.validUntil)
        : approved.expectedreturntime
          ? new Date(new Date(approved.expectedreturntime).getTime() + 60 * 60 * 1000)
          : null;
      const adminOverride = approved.adminOverride === true;
      nightApprovalStatus =
        adminOverride || (validUntil && validUntil >= new Date())
          ? 'approved'
          : 'not_approved';
    } else {
      nightApprovalStatus = 'not_approved';
    }
  }

  const payload = {
    studentId: normalizedStudentId,
    isOutside,
    nightApprovalStatus,
    nightApprovalRequired: needsApproval,
    timestamp: new Date().toISOString(),
  };

  const staffUserIds = await getStaffUserIds();
  for (const userId of staffUserIds) {
    strapi.io?.to(`user:${userId}`).emit('outside-student-status-updated', payload);
  }
};

module.exports = {
  getIstDateString,
  isNightWindow,
  isStaffRole,
  verifyUserFromAuthHeader,
  fetchOutsideStudentsWithClassification,
  emitNightAlertSummary,
  emitOutsideStudentStatusUpdated,
};
