import os from 'os';

// Performance monitoring middleware
export const performanceMiddleware = (req, res, next) => {
    const startTime = Date.now();
    const startUsage = process.cpuUsage();
    const startMemory = process.memoryUsage();

    // Override res.json to capture response size
    const originalJson = res.json;
    let responseSize = 0;

    res.json = function(data) {
        const jsonString = JSON.stringify(data);
        responseSize = Buffer.byteLength(jsonString, 'utf8');
        return originalJson.call(this, data);
    };

    res.on('finish', () => {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        const endUsage = process.cpuUsage(startUsage);
        const endMemory = process.memoryUsage();

        // Calculate memory difference
        const memoryDiff = {
            heapUsed: endMemory.heapUsed - startMemory.heapUsed,
            heapTotal: endMemory.heapTotal - startMemory.heapTotal,
            external: endMemory.external - startMemory.external
        };

        // Performance metrics
        const metrics = {
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`,
            responseSize: `${(responseSize / 1024).toFixed(2)}KB`,
            memoryUsage: {
                heap: `${(endMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
                heapDelta: `${(memoryDiff.heapUsed / 1024 / 1024).toFixed(2)}MB`,
                external: `${(endMemory.external / 1024 / 1024).toFixed(2)}MB`
            },
            cpuUsage: {
                user: `${(endUsage.user / 1000).toFixed(2)}ms`,
                system: `${(endUsage.system / 1000).toFixed(2)}ms`
            },
            timestamp: new Date().toISOString()
        };

        // Log slow requests (>1000ms)
        if (responseTime > 1000) {
            console.log('🐌 SLOW REQUEST:', JSON.stringify(metrics, null, 2));
        }

        // Log error responses
        if (res.statusCode >= 400) {
            console.log('❌ ERROR RESPONSE:', JSON.stringify(metrics, null, 2));
        }

        // Add performance headers
        res.set({
            'X-Response-Time': `${responseTime}ms`,
            'X-Memory-Usage': `${(endMemory.heapUsed / 1024 / 1024).toFixed(2)}MB`,
            'X-Process-Time': new Date().toISOString()
        });
    });

    next();
};

// System performance stats
export const getSystemStats = () => {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
        process: {
            pid: process.pid,
            uptime: `${(process.uptime() / 60).toFixed(2)} minutes`,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            memory: {
                heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
                heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
                external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)}MB`,
                rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB`,
                arrayBuffers: `${(memoryUsage.arrayBuffers / 1024 / 1024).toFixed(2)}MB`
            },
            cpu: {
                user: `${(cpuUsage.user / 1000).toFixed(2)}ms`,
                system: `${(cpuUsage.system / 1000).toFixed(2)}ms`
            }
        },
        system: {
            totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)}GB`,
            freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)}GB`,
            cpuCores: os.cpus().length,
            loadAverage: os.loadavg(),
            hostname: os.hostname(),
            type: os.type(),
            release: os.release()
        }
    };
};

// Request metrics storage (in-memory for simplicity)
const requestMetrics = [];
const MAX_METRICS = 100;

export const storeMetrics = (metrics) => {
    requestMetrics.unshift(metrics);
    if (requestMetrics.length > MAX_METRICS) {
        requestMetrics.pop();
    }
};

export const getMetrics = () => {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const fiveMinutesAgo = now - 300000;

    const recentMetrics = requestMetrics.filter(m => 
        new Date(m.timestamp).getTime() > fiveMinutesAgo
    );

    const oneMinuteMetrics = recentMetrics.filter(m => 
        new Date(m.timestamp).getTime() > oneMinuteAgo
    );

    return {
        summary: {
            totalRequests: requestMetrics.length,
            recentRequests: recentMetrics.length,
            lastMinuteRequests: oneMinuteMetrics.length,
            averageResponseTime: recentMetrics.length > 0 
                ? `${(recentMetrics.reduce((sum, m) => sum + parseInt(m.responseTime), 0) / recentMetrics.length).toFixed(2)}ms`
                : '0ms',
            slowRequests: recentMetrics.filter(m => parseInt(m.responseTime) > 1000).length,
            errorRequests: recentMetrics.filter(m => m.statusCode >= 400).length
        },
        recent: recentMetrics.slice(0, 10) // Last 10 requests
    };
};