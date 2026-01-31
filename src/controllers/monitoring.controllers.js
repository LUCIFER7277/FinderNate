import { asyncHandler } from '../utlis/asyncHandler.js';
import { ApiResponse } from '../utlis/ApiResponse.js';
import { ApiError } from '../utlis/ApiError.js';
import {
    LogReader,
    MetricsCollector
} from '../utlis/monitoring.utils.js';
import { runExpiryCheckNow } from '../jobs/subscriptionExpiry.job.js';

/**
 * Monitoring and Admin Controllers
 * For viewing logs, metrics, and testing subscription expiry
 */

/**
 * Get payment logs
 * GET /api/v1/admin/monitoring/payment-logs
 */
export const getPaymentLogs = asyncHandler(async (req, res) => {
    const { lines = 50 } = req.query;

    const logs = LogReader.getPaymentLogs(parseInt(lines));

    res.status(200).json(
        new ApiResponse(200, {
            logs,
            count: logs.length,
            linesRequested: parseInt(lines)
        }, 'Payment logs fetched successfully')
    );
});

/**
 * Get subscription logs
 * GET /api/v1/admin/monitoring/subscription-logs
 */
export const getSubscriptionLogs = asyncHandler(async (req, res) => {
    const { lines = 50 } = req.query;

    const logs = LogReader.getSubscriptionLogs(parseInt(lines));

    res.status(200).json(
        new ApiResponse(200, {
            logs,
            count: logs.length,
            linesRequested: parseInt(lines)
        }, 'Subscription logs fetched successfully')
    );
});

/**
 * Get error logs
 * GET /api/v1/admin/monitoring/error-logs
 */
export const getErrorLogs = asyncHandler(async (req, res) => {
    const { lines = 50 } = req.query;

    const logs = LogReader.getErrorLogs(parseInt(lines));

    res.status(200).json(
        new ApiResponse(200, {
            logs,
            count: logs.length,
            linesRequested: parseInt(lines)
        }, 'Error logs fetched successfully')
    );
});

/**
 * Get metrics
 * GET /api/v1/admin/monitoring/metrics
 */
export const getMetrics = asyncHandler(async (req, res) => {
    const metrics = MetricsCollector.getMetrics();

    res.status(200).json(
        new ApiResponse(200, metrics, 'Metrics fetched successfully')
    );
});

/**
 * Test subscription expiry job manually
 * POST /api/v1/admin/monitoring/test-expiry-job
 */
export const testExpiryJob = asyncHandler(async (req, res) => {
    console.log('🧪 Manual subscription expiry check triggered by admin');

    const result = await runExpiryCheckNow();

    res.status(200).json(
        new ApiResponse(200, result, 'Expiry check completed')
    );
});

/**
 * Get monitoring dashboard summary
 * GET /api/v1/admin/monitoring/dashboard
 */
export const getDashboard = asyncHandler(async (req, res) => {
    const metrics = MetricsCollector.getMetrics();
    const recentPaymentLogs = LogReader.getPaymentLogs(10);
    const recentErrors = LogReader.getErrorLogs(10);

    res.status(200).json(
        new ApiResponse(200, {
            metrics,
            recentPayments: recentPaymentLogs,
            recentErrors,
            timestamp: new Date().toISOString()
        }, 'Dashboard data fetched successfully')
    );
});
