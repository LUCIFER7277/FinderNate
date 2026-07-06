import Report from "../../models/report.models.js";
import Post from "../../models/userPost.models.js";
import Story from "../../models/story.models.js";
import Comment from "../../models/comment.models.js";
import { User } from "../../models/user.models.js";
import { invalidateAuthCache } from "../../middlewares/auth.middleware.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { notifyStatusChange } from "./helpers.js";

// GET /api/v1/admin/reports
export const getAllReports = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status, reason, type } = req.query;

    let filter = {};

    if (status && ['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
        filter.status = status;
    }

    if (reason && ['spam', 'harassment', 'nudity', 'violence', 'hateSpeech', 'scam', 'other'].includes(reason)) {
        filter.reason = reason;
    }

    if (type) {
        if (type === 'post') filter.reportedPostId = { $exists: true, $ne: null };
        else if (type === 'user') filter.reportedUserId = { $exists: true, $ne: null };
        else if (type === 'comment') filter.reportedCommentId = { $exists: true, $ne: null };
        else if (type === 'story') filter.reportedStoryId = { $exists: true, $ne: null };
    }

    const reports = await Report.find(filter)
        .populate('reporterId', 'username fullName profileImageUrl')
        .populate('reportedUserId', 'username fullName profileImageUrl accountStatus')
        .populate('reportedPostId', 'caption media userId contentType')
        .populate('reportedCommentId', 'content userId')
        .populate('reportedStoryId', 'media userId')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalReports = await Report.countDocuments(filter);

    const stats = await Report.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);

    const reportStats = {
        pending: 0,
        reviewed: 0,
        resolved: 0,
        dismissed: 0
    };

    stats.forEach(stat => {
        reportStats[stat._id] = stat.count;
    });

    return res.status(200).json(
        new ApiResponse(200, {
            reports,
            stats: reportStats,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalReports / limit),
                totalReports,
                hasNext: page < Math.ceil(totalReports / limit),
                hasPrev: page > 1
            }
        }, "Reports fetched successfully")
    );
});

// PUT /api/v1/admin/reports/:reportId/status
export const updateReportStatus = asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const { status, action, remarks } = req.body;

    if (!['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
        throw new ApiError(400, "Invalid status");
    }

    const report = await Report.findById(reportId)
        .populate('reportedPostId')
        .populate('reportedUserId')
        .populate('reportedCommentId')
        .populate('reportedStoryId');

    if (!report) {
        throw new ApiError(404, "Report not found");
    }

    report.status = status;
    report.adminRemarks = remarks;
    report.reviewedBy = req.admin._id;
    report.reviewedAt = new Date();

    if (action && status === 'resolved') {
        if (action === 'delete_content') {
            if (report.reportedPostId) {
                await Post.findByIdAndDelete(report.reportedPostId._id);
            } else if (report.reportedCommentId) {
                await Comment.findByIdAndDelete(report.reportedCommentId._id);
            } else if (report.reportedStoryId) {
                await Story.findByIdAndDelete(report.reportedStoryId._id);
            }
        } else if (action === 'ban_user' && report.reportedUserId) {
            await User.findByIdAndUpdate(report.reportedUserId._id, {
                accountStatus: 'banned'
            });
            await invalidateAuthCache(report.reportedUserId._id);
            await notifyStatusChange(report.reportedUserId._id.toString(), 'banned');
        } else if (action === 'suspend_user' && report.reportedUserId) {
            await User.findByIdAndUpdate(report.reportedUserId._id, {
                accountStatus: 'deactivated'
            });
            await invalidateAuthCache(report.reportedUserId._id);
            await notifyStatusChange(report.reportedUserId._id.toString(), 'deactivated');
        }
    }

    await report.save();

    await req.admin.logActivity(
        `report_${status}`,
        'report',
        reportId,
        `Report ${status} with action: ${action || 'none'}. Remarks: ${remarks || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, report, "Report status updated successfully")
    );
});

// DELETE /api/v1/admin/reports/:reportId
export const deleteReport = asyncHandler(async (req, res) => {
    const { reportId } = req.params;

    const report = await Report.findByIdAndDelete(reportId);
    if (!report) {
        throw new ApiError(404, "Report not found");
    }

    await req.admin.logActivity(
        'report_deleted',
        'report',
        reportId,
        'Report permanently deleted'
    );

    return res.status(200).json(
        new ApiResponse(200, {}, "Report deleted successfully")
    );
});
