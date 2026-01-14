'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::visitor.visitor', ({ strapi }) => ({
  async createWithAudit(data, userId) {
    const existingVisitor = await strapi.entityService.findMany('api::visitor.visitor', {
      filters: {
        phone: data.phone,
        status: {
          $in: ['PENDING', 'APPROVED', 'ENTERED']
        }
      }
    });
    
    if (existingVisitor.length > 0) {
      throw new Error('Visitor with this phone already has active or pending request');
    }
    
    return await strapi.entityService.create('api::visitor.visitor', {
      data: {
        ...data,
        status: 'PENDING',
        assignedTo: userId
      }
    });
  },
  
  async processApproval(visitorId, decision, remarks, userId) {
    const visitor = await strapi.entityService.findOne('api::visitor.visitor', visitorId, {
      populate: ['assignedTo', 'approval']
    });
    
    // Idempotency check
    if (visitor.status !== 'PENDING') {
      return {
        visitor,
        message: `Visitor is already ${visitor.status.toLowerCase()}`,
        isNew: false
      };
    }
    
    // Check authorization
    if (visitor.assignedTo.id !== userId) {
      throw new Error('Not authorized to approve this visitor');
    }
    
    // Create approval record
    const approval = await strapi.entityService.create('api::visitor-approval.visitor-approval', {
      data: {
        decision,
        remarks,
        decidedAt: new Date(),
        decidedBy: userId,
        visitor: visitorId
      }
    });
    
    // Update visitor
    const updatedVisitor = await strapi.entityService.update('api::visitor.visitor', visitorId, {
      data: {
        status: decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        approval: approval.id
      }
    });
    
    return {
      visitor: updatedVisitor,
      approval,
      isNew: true
    };
  },
  
  async processEntry(visitorId, scannerId, guardId) {
    const visitor = await strapi.entityService.findOne('api::visitor.visitor', visitorId, {
      populate: ['approval']
    });
    
    // Idempotency check
    if (visitor.status === 'ENTERED') {
      throw new Error('Visitor already entered');
    }
    
    if (visitor.status !== 'APPROVED') {
      throw new Error(`Visitor is ${visitor.status.toLowerCase()}, cannot enter`);
    }
    
    // Create scan log
    const scanLog = await strapi.entityService.create('api::gate-scan-log.gate-scan-log', {
      data: {
        action: 'ENTRY',
        scannerId,
        visitor: visitorId,
        timestamp: new Date(),
        metadata: {
          guardId,
          previousStatus: visitor.status
        }
      }
    });
    
    // Update visitor
    const updatedVisitor = await strapi.entityService.update('api::visitor.visitor', visitorId, {
      data: {
        status: 'ENTERED'
      }
    });
    
    return {
      visitor: updatedVisitor,
      scanLog
    };
  }
}));