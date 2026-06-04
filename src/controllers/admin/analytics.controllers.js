import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import Report from "../../models/report.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// GET /api/v1/admin/dashboard/stats
export const getDashboardStats = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.viewAnalytics) {
        throw new ApiError(403, "Insufficient permissions to view analytics");
    }

    const [
        totalUsers,
        totalBusinesses,
        totalReports,
        pendingReports,
        pendingAadhaarVerifications,
        pendingBusinessVerifications,
        activeUsers,
        verifiedBusinesses
    ] = await Promise.all([
        User.countDocuments(),
        Business.countDocuments(),
        Report.countDocuments(),
        Report.countDocuments({ status: 'pending' }),
        Business.countDocuments({
            $or: [
                { 'documents': { $elemMatch: { documentType: 'aadhaar', verified: false } } },
                { aadhaarNumber: { $exists: true, $ne: null, $ne: "" }, isVerified: false }
            ]
        }),
        Business.countDocuments({
            $or: [
                { verificationStatus: 'pending' },
                { 'documents': { $elemMatch: { verified: false, documentType: { $ne: 'aadhaar' } } } }
            ]
        }),
        User.countDocuments({ accountStatus: 'active' }),
        Business.countDocuments({ isVerified: true })
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [newUsers, newBusinesses, newReports] = await Promise.all([
        User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
        Business.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
        Report.countDocuments({ createdAt: { $gte: thirtyDaysAgo } })
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            overview: {
                totalUsers,
                totalBusinesses,
                totalReports,
                activeUsers,
                verifiedBusinesses
            },
            pending: {
                reports: pendingReports,
                aadhaarVerifications: pendingAadhaarVerifications,
                businessVerifications: pendingBusinessVerifications
            },
            recent: {
                newUsers,
                newBusinesses,
                newReports
            }
        }, "Dashboard stats fetched successfully")
    );
});

// GET /api/v1/admin/activity-log
export const getAdminActivityLog = asyncHandler(async (req, res) => {
    const { page = 1, limit = 50 } = req.query;

    const activities = req.admin.activityLog
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice((page - 1) * limit, page * limit);

    return res.status(200).json(
        new ApiResponse(200, {
            activities,
            pagination: {
                currentPage: parseInt(page),
                totalActivities: req.admin.activityLog.length,
                hasNext: page * limit < req.admin.activityLog.length,
                hasPrev: page > 1
            }
        }, "Activity log fetched successfully")
    );
});
