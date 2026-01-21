import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Monitoring and Logging Utilities
 *
 * Features:
 * - Payment transaction logging
 * - Subscription event logging
 * - Performance monitoring
 * - Error tracking
 * - Metrics collection
 */

// Log directories
const LOG_DIR = path.join(process.cwd(), 'logs');
const PAYMENT_LOG_FILE = path.join(LOG_DIR, 'payments.log');
const SUBSCRIPTION_LOG_FILE = path.join(LOG_DIR, 'subscriptions.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'errors.log');
const METRICS_LOG_FILE = path.join(LOG_DIR, 'metrics.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log('✅ Log directory created:', LOG_DIR);
}

/**
 * Format log entry with timestamp
 */
const formatLogEntry = (level, message, data = {}) => {
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
        environment: process.env.NODE_ENV || 'development'
    }) + '\n';
};

/**
 * Write log to file
 */
const writeLog = (filePath, entry) => {
    try {
        fs.appendFileSync(filePath, entry);
    } catch (error) {
        console.error('Failed to write log:', error);
    }
};

/**
 * Payment Logger
 * Logs all payment-related events for auditing and debugging
 */
export class PaymentLogger {
    /**
     * Log payment initiated
     */
    static logPaymentInitiated(userId, orderId, plan, amount) {
        const entry = formatLogEntry('INFO', 'Payment Initiated', {
            userId,
            orderId,
            plan,
            amount,
            status: 'initiated'
        });

        writeLog(PAYMENT_LOG_FILE, entry);
        console.log('💳 Payment initiated:', { userId, orderId, plan, amount });
    }

    /**
     * Log payment success
     */
    static logPaymentSuccess(userId, paymentId, orderId, plan, amount) {
        const entry = formatLogEntry('SUCCESS', 'Payment Successful', {
            userId,
            paymentId,
            orderId,
            plan,
            amount,
            status: 'success'
        });

        writeLog(PAYMENT_LOG_FILE, entry);
        console.log('✅ Payment successful:', { userId, paymentId, orderId });
    }

    /**
     * Log payment failure
     */
    static logPaymentFailure(userId, orderId, errorCode, errorMessage) {
        const entry = formatLogEntry('ERROR', 'Payment Failed', {
            userId,
            orderId,
            errorCode,
            errorMessage,
            status: 'failed'
        });

        writeLog(PAYMENT_LOG_FILE, entry);
        console.error('❌ Payment failed:', { userId, orderId, errorCode });
    }

    /**
     * Log payment verification
     */
    static logPaymentVerification(userId, paymentId, orderId, isValid) {
        const entry = formatLogEntry('INFO', 'Payment Verification', {
            userId,
            paymentId,
            orderId,
            isValid,
            status: isValid ? 'verified' : 'verification_failed'
        });

        writeLog(PAYMENT_LOG_FILE, entry);
        console.log(`🔍 Payment verification: ${isValid ? 'valid' : 'invalid'}`, { userId, paymentId });
    }

    /**
     * Log webhook event
     */
    static logWebhookEvent(eventType, paymentId, userId, data) {
        const entry = formatLogEntry('INFO', 'Webhook Event Received', {
            eventType,
            paymentId,
            userId,
            data,
            status: 'webhook_received'
        });

        writeLog(PAYMENT_LOG_FILE, entry);
        console.log('📥 Webhook event:', { eventType, paymentId, userId });
    }
}

/**
 * Subscription Logger
 * Logs all subscription-related events
 */
export class SubscriptionLogger {
    /**
     * Log subscription created
     */
    static logSubscriptionCreated(userId, plan, startDate, endDate) {
        const entry = formatLogEntry('INFO', 'Subscription Created', {
            userId,
            plan,
            startDate,
            endDate,
            action: 'created'
        });

        writeLog(SUBSCRIPTION_LOG_FILE, entry);
        console.log('🎉 Subscription created:', { userId, plan });
    }

    /**
     * Log subscription upgraded
     */
    static logSubscriptionUpgraded(userId, oldPlan, newPlan) {
        const entry = formatLogEntry('INFO', 'Subscription Upgraded', {
            userId,
            oldPlan,
            newPlan,
            action: 'upgraded'
        });

        writeLog(SUBSCRIPTION_LOG_FILE, entry);
        console.log('⬆️ Subscription upgraded:', { userId, oldPlan, newPlan });
    }

    /**
     * Log subscription expired
     */
    static logSubscriptionExpired(userId, plan, endDate) {
        const entry = formatLogEntry('WARN', 'Subscription Expired', {
            userId,
            plan,
            endDate,
            action: 'expired'
        });

        writeLog(SUBSCRIPTION_LOG_FILE, entry);
        console.log('⚠️ Subscription expired:', { userId, plan, endDate });
    }

    /**
     * Log subscription cancelled
     */
    static logSubscriptionCancelled(userId, plan, reason) {
        const entry = formatLogEntry('INFO', 'Subscription Cancelled', {
            userId,
            plan,
            reason,
            action: 'cancelled'
        });

        writeLog(SUBSCRIPTION_LOG_FILE, entry);
        console.log('🚫 Subscription cancelled:', { userId, plan, reason });
    }
}

/**
 * Error Logger
 * Logs all errors for debugging and monitoring
 */
export class ErrorLogger {
    /**
     * Log error
     */
    static logError(errorType, errorMessage, context = {}) {
        const entry = formatLogEntry('ERROR', errorType, {
            errorMessage,
            context,
            stack: context.stack || null
        });

        writeLog(ERROR_LOG_FILE, entry);
        console.error('❌ Error logged:', { errorType, errorMessage });
    }

    /**
     * Log Razorpay error
     */
    static logRazorpayError(userId, orderId, error) {
        const entry = formatLogEntry('ERROR', 'Razorpay Error', {
            userId,
            orderId,
            errorCode: error.error?.code,
            errorDescription: error.error?.description,
            errorMessage: error.message
        });

        writeLog(ERROR_LOG_FILE, entry);
        console.error('❌ Razorpay error:', { userId, orderId, error: error.message });
    }

    /**
     * Log cache error
     */
    static logCacheError(operation, userId, error) {
        const entry = formatLogEntry('ERROR', 'Cache Error', {
            operation,
            userId,
            errorMessage: error.message
        });

        writeLog(ERROR_LOG_FILE, entry);
        console.error('❌ Cache error:', { operation, userId, error: error.message });
    }
}

/**
 * Metrics Collector
 * Collects performance and business metrics
 */
export class MetricsCollector {
    static metrics = {
        totalPayments: 0,
        successfulPayments: 0,
        failedPayments: 0,
        totalRevenue: 0,
        subscriptionsByPlan: {
            free: 0,
            small_business: 0,
            corporate: 0
        }
    };

    /**
     * Record payment attempt
     */
    static recordPaymentAttempt() {
        this.metrics.totalPayments++;
    }

    /**
     * Record successful payment
     */
    static recordPaymentSuccess(amount, plan) {
        this.metrics.successfulPayments++;
        this.metrics.totalRevenue += amount;
        this.metrics.subscriptionsByPlan[plan] = (this.metrics.subscriptionsByPlan[plan] || 0) + 1;

        this.saveMetrics();
    }

    /**
     * Record payment failure
     */
    static recordPaymentFailure() {
        this.metrics.failedPayments++;
        this.saveMetrics();
    }

    /**
     * Get current metrics
     */
    static getMetrics() {
        return {
            ...this.metrics,
            successRate: this.metrics.totalPayments > 0
                ? ((this.metrics.successfulPayments / this.metrics.totalPayments) * 100).toFixed(2) + '%'
                : '0%'
        };
    }

    /**
     * Save metrics to file
     */
    static saveMetrics() {
        const entry = formatLogEntry('METRICS', 'Current Metrics', this.getMetrics());
        writeLog(METRICS_LOG_FILE, entry);
    }

    /**
     * Reset metrics (useful for testing)
     */
    static resetMetrics() {
        this.metrics = {
            totalPayments: 0,
            successfulPayments: 0,
            failedPayments: 0,
            totalRevenue: 0,
            subscriptionsByPlan: {
                free: 0,
                small_business: 0,
                corporate: 0
            }
        };
    }
}

/**
 * Performance Monitor
 * Monitors API performance
 */
export class PerformanceMonitor {
    /**
     * Measure execution time
     */
    static async measure(operationName, asyncFunction) {
        const startTime = Date.now();

        try {
            const result = await asyncFunction();
            const duration = Date.now() - startTime;

            console.log(`⏱️ ${operationName} completed in ${duration}ms`);

            const entry = formatLogEntry('PERFORMANCE', operationName, {
                duration,
                status: 'success'
            });
            writeLog(METRICS_LOG_FILE, entry);

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            console.error(`⏱️ ${operationName} failed after ${duration}ms`);

            const entry = formatLogEntry('PERFORMANCE', operationName, {
                duration,
                status: 'error',
                error: error.message
            });
            writeLog(METRICS_LOG_FILE, entry);

            throw error;
        }
    }
}

/**
 * Log Reader Utility
 * Read and parse log files
 */
export class LogReader {
    /**
     * Read recent logs from a file
     */
    static readRecentLogs(logFile, lines = 100) {
        try {
            if (!fs.existsSync(logFile)) {
                return [];
            }

            const content = fs.readFileSync(logFile, 'utf8');
            const allLines = content.split('\n').filter(line => line.trim());
            const recentLines = allLines.slice(-lines);

            return recentLines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return { raw: line };
                }
            });
        } catch (error) {
            console.error('Error reading logs:', error);
            return [];
        }
    }

    /**
     * Get payment logs
     */
    static getPaymentLogs(lines = 100) {
        return this.readRecentLogs(PAYMENT_LOG_FILE, lines);
    }

    /**
     * Get subscription logs
     */
    static getSubscriptionLogs(lines = 100) {
        return this.readRecentLogs(SUBSCRIPTION_LOG_FILE, lines);
    }

    /**
     * Get error logs
     */
    static getErrorLogs(lines = 100) {
        return this.readRecentLogs(ERROR_LOG_FILE, lines);
    }

    /**
     * Get metrics logs
     */
    static getMetricsLogs(lines = 100) {
        return this.readRecentLogs(METRICS_LOG_FILE, lines);
    }
}

// Export log file paths for external access
export const LOG_FILES = {
    PAYMENT_LOG_FILE,
    SUBSCRIPTION_LOG_FILE,
    ERROR_LOG_FILE,
    METRICS_LOG_FILE
};
