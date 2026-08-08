'use strict';

const axios = require('axios');

/**
 * Printer Service - Handles visitor pass printing via network printer
 * Communicates with Flask printer service at configured IP:port
 */
class PrinterService {
  constructor() {
    this.printerUrl = process.env.PRINTER_URL || 'http://192.168.32.115:5001';
    this.timeout = parseInt(process.env.PRINTER_TIMEOUT || 5000);
    this.retryAttempts = parseInt(process.env.PRINTER_RETRY || 2);
    this.retryDelay = parseInt(process.env.PRINTER_RETRY_DELAY || 1000);
  }

  /**
   * Print visitor pass
   * @param {object} visitorData - Visitor information
   * @returns {Promise<object>} - Printer response
   */
  async printVisitorPass(visitorData) {
    try {
      if (!visitorData || !visitorData.name) {
        throw new Error('Missing required visitor data (name)');
      }

      const payload = this._buildPayload(visitorData);
      console.log(`📠 Sending print request to ${this.printerUrl}`, JSON.stringify(payload));

      // Retry logic for reliability
      let lastError;
      for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
        try {
          const response = await axios.post(`${this.printerUrl}/print`, payload, {
            timeout: this.timeout,
            headers: {
              'Content-Type': 'application/json',
            },
          });

          console.log(`✅ Printer response (Attempt ${attempt}): ${response.data.status}`);
          return {
            success: true,
            status: response.data.status || 'Printed Successfully',
            attempt,
          };
        } catch (err) {
          lastError = err;
          if (attempt < this.retryAttempts) {
            console.warn(`⚠️ Printer attempt ${attempt} failed, retrying in ${this.retryDelay}ms...`);
            await this._delay(this.retryDelay);
          }
        }
      }

      // All retries failed
      throw lastError;
    } catch (err) {
      console.error(`❌ Printer Service Error:`, {
        message: err.message,
        code: err.code,
        url: this.printerUrl,
        visitorName: visitorData?.name,
      });

      // Log to database for audit trail
      this._logPrinterError(visitorData, err).catch((logErr) =>
        console.error('Failed to log printer error:', logErr.message)
      );

      // Return graceful error (don't fail visitor approval)
      return {
        success: false,
        status: 'Printer offline or unreachable',
        error: err.message,
        code: err.code,
      };
    }
  }

  /**
   * Build printer payload from visitor data
   * @private
   */
  _buildPayload(visitorData) {
    const now = new Date();
    const entryTime = visitorData.entryTime
      ? new Date(visitorData.entryTime).toLocaleString('en-IN')
      : now.toLocaleString('en-IN');

    return {
      name: String(visitorData.name || '-').substring(0, 50),
      mobile: String(visitorData.phone || '-').substring(0, 15),
      guest_of: String(visitorData.assignedTo || visitorData.teacherName || '-').substring(0, 50),
      reason: String(visitorData.purpose || '-').substring(0, 50),
      generated_by: String(visitorData.guardName || 'Guard').substring(0, 30),
      timestamp: entryTime + 5300, // Convert to IST
      exit_after: String(visitorData.exitAfterHours || 8),
      visitor_id: visitorData.visitorId || '', // For reference on receipt
    };
  }

  /**
   * Delay utility for retry logic
   * @private
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Log printer errors to database for audit trail
   * @private
   */
  async _logPrinterError(visitorData, error) {
    try {
      // Log to console for now, can be extended to database
      console.log('[PRINTER_ERROR_LOG]', {
        timestamp: new Date().toISOString(),
        visitorName: visitorData?.name,
        visitorId: visitorData?.visitorId,
        error: error.message,
        printerUrl: this.printerUrl,
      });
    } catch (err) {
      console.error('Failed to log printer error:', err.message);
    }
  }

  /**
   * Health check - verify printer is reachable
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.printerUrl}/health`, {
        timeout: 2000,
      });
      return response.status === 200;
    } catch (err) {
      console.warn(`⚠️ Printer health check failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = new PrinterService();
