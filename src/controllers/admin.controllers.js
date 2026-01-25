import { Admin } from "../models/admin.models.js";
import { User } from "../models/user.models.js";
import Business from "../models/business.models.js";
import Report from "../models/report.models.js";
import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import Comment from "../models/comment.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import mongoose from "mongoose";

// ===============================
// ADMIN AUTHENTICATION
// ===============================

// POST /api/v1/admin/login
export const adminLogin = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new ApiError(400, "Email and password are required");
    }

    const admin = await Admin.findOne({ email }).select("+refreshToken");
    if (!admin) {
        throw new ApiError(401, "Invalid admin credentials");
    }

    if (!admin.isActive) {
        throw new ApiError(403, "Admin account is deactivated");
    }

    const isPasswordValid = await admin.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid admin credentials");
    }

    const accessToken = admin.generateAccessToken();
    const refreshToken = admin.generateRefreshToken();

    admin.refreshToken = refreshToken;
    admin.lastLogin = new Date();
    await admin.save({ validateBeforeSave: false });

    const loggedInAdmin = await Admin.findById(admin._id).select("-password -refreshToken");

    const options = {
        httpOnly: true,
        secure: true
    };

    return res
        .status(200)
        .cookie("adminAccessToken", accessToken, options)
        .cookie("adminRefreshToken", refreshToken, options)
        .json(
            new ApiResponse(
                200,
                {
                    admin: loggedInAdmin,
                    accessToken,
                    refreshToken
                },
                "Admin logged in successfully"
            )
        );
});

// POST /api/v1/admin/logout
export const adminLogout = asyncHandler(async (req, res) => {
    await Admin.findByIdAndUpdate(
        req.admin._id,
        {
            $unset: {
                refreshToken: 1
            }
        },
        {
            new: true
        }
    );

    const options = {
        httpOnly: true,
        secure: true
    };

    return res
        .status(200)
        .clearCookie("adminAccessToken", options)
        .clearCookie("adminRefreshToken", options)
        .json(new ApiResponse(200, {}, "Admin logged out"));
});

// ===============================
// AADHAAR VERIFICATION
// ===============================

// GET /api/v1/admin/aadhaar-verification/pending
export const getPendingAadhaarVerifications = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search } = req.query;

    // Find businesses that have Aadhaar documents (either in documents array OR aadhaarNumber field)
    let filter = {
        $or: [
            { 'documents': { $elemMatch: { documentType: 'aadhaar', verified: false } } },
            { aadhaarNumber: { $exists: true, $ne: null, $ne: "" }, isVerified: false }
        ]
    };

    if (search) {
        filter.$and = [
            filter,
            {
                $or: [
                    { businessName: { $regex: search, $options: 'i' } },
                    { aadhaarNumber: { $regex: search, $options: 'i' } }
                ]
            }
        ];
    }

    const businesses = await Business.find(filter)
        .populate('userId', 'username fullName email phoneNumber')
        .populate('documents.verifiedBy', 'username fullName')
        .select('businessName aadhaarNumber gstNumber contact location documents createdAt')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    // Filter to only show Aadhaar-type documents for each business
    const businessesWithAadhaarDocs = businesses.map(business => {
        const businessObj = business.toObject();
        if (businessObj.documents) {
            // Only show unverified Aadhaar documents
            businessObj.documents = businessObj.documents.filter(
                doc => doc.documentType === 'aadhaar' && !doc.verified
            );
        }
        return businessObj;
    });

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            businesses: businessesWithAadhaarDocs,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Pending Aadhaar verifications fetched successfully")
    );
});

// POST /api/v1/admin/aadhaar-verification/verify/:businessId
export const verifyAadhaarCard = asyncHandler(async (req, res) => {
    const { businessId } = req.params;
    const { status, remarks } = req.body; // status: 'approved' | 'rejected'

    if (!['approved', 'rejected'].includes(status)) {
        throw new ApiError(400, "Status must be either 'approved' or 'rejected'");
    }

    const business = await Business.findById(businessId).populate('userId');
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    if (!business.aadhaarNumber) {
        throw new ApiError(400, "No Aadhaar number found for this business");
    }

    if (status === 'approved') {
        business.isVerified = true;
        business.verificationStatus = 'approved';
        business.verificationRemarks = remarks || 'Aadhaar verification approved';
        business.verifiedAt = new Date();
        business.verifiedBy = req.admin._id;
    } else {
        business.isVerified = false;
        business.verificationStatus = 'rejected';
        business.verificationRemarks = remarks || 'Aadhaar verification rejected';
        business.rejectedAt = new Date();
        business.rejectedBy = req.admin._id;
    }

    await business.save();

    // Log admin activity
    await req.admin.logActivity(
        `aadhaar_verification_${status}`,
        'business',
        businessId,
        `Aadhaar verification ${status} for business: ${business.businessName}`
    );

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                _id: business._id,
                businessName: business.businessName,
                isVerified: business.isVerified,
                verificationStatus: business.verificationStatus,
                verificationRemarks: business.verificationRemarks
            }
        }, `Aadhaar verification ${status} successfully`)
    );
});

// GET /api/v1/admin/aadhaar-verification/history
export const getAadhaarVerificationHistory = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;

    let filter = {
        aadhaarNumber: { $exists: true, $ne: null, $ne: "" },
        verificationStatus: { $exists: true }
    };

    if (status && ['approved', 'rejected'].includes(status)) {
        filter.verificationStatus = status;
    }

    const businesses = await Business.aggregate([
        { $match: filter },
        {
            $addFields: {
                lastVerificationDate: {
                    $max: ['$verifiedAt', '$rejectedAt']
                }
            }
        },
        { $sort: { lastVerificationDate: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit * 1 },
        {
            $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                as: 'userId',
                pipeline: [{ $project: { username: 1, fullName: 1, email: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'verifiedBy',
                foreignField: '_id',
                as: 'verifiedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'rejectedBy',
                foreignField: '_id',
                as: 'rejectedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $project: {
                businessName: 1,
                aadhaarNumber: 1,
                verificationStatus: 1,
                verificationRemarks: 1,
                verifiedAt: 1,
                rejectedAt: 1,
                userId: { $arrayElemAt: ['$userId', 0] },
                verifiedBy: { $arrayElemAt: ['$verifiedBy', 0] },
                rejectedBy: { $arrayElemAt: ['$rejectedBy', 0] }
            }
        }
    ]);

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            businesses,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Aadhaar verification history fetched successfully")
    );
});

// ===============================
// REPORT MANAGEMENT
// ===============================

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

    // Get report statistics
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

    // Handle specific actions
    if (action && status === 'resolved') {
        if (action === 'delete_content') {
            // Delete the reported content
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
        } else if (action === 'suspend_user' && report.reportedUserId) {
            await User.findByIdAndUpdate(report.reportedUserId._id, {
                accountStatus: 'deactivated'
            });
        }
    }

    await report.save();

    // Log admin activity
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

    // Log admin activity
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

// ===============================
// USER MANAGEMENT
// ===============================

// GET /api/v1/admin/users
export const getAllUsers = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { page = 1, limit = 20, search, accountStatus } = req.query;

    let filter = {};

    if (search) {
        filter.$or = [
            { username: { $regex: search, $options: 'i' } },
            { fullName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    if (accountStatus && ['active', 'deactivated', 'banned'].includes(accountStatus)) {
        filter.accountStatus = accountStatus;
    }

    const users = await User.find(filter)
        .select('-password -refreshToken')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalUsers = await User.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            users,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalUsers / limit),
                totalUsers,
                hasNext: page < Math.ceil(totalUsers / limit),
                hasPrev: page > 1
            }
        }, "Users fetched successfully")
    );
});

// PUT /api/v1/admin/users/:userId/status
export const updateUserStatus = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { userId } = req.params;
    const { accountStatus, reason } = req.body;

    if (!['active', 'deactivated', 'banned'].includes(accountStatus)) {
        throw new ApiError(400, "Invalid account status");
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { accountStatus },
        { new: true }
    ).select('-password -refreshToken');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    // Log admin activity
    await req.admin.logActivity(
        `user_status_changed`,
        'user',
        userId,
        `User status changed to ${accountStatus}. Reason: ${reason || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, user, `User status updated to ${accountStatus}`)
    );
});

// PUT /api/v1/admin/users/:userId/blue-tick
export const verifyBlueTick = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { userId } = req.params;
    const { isBlueTickVerified, reason } = req.body;

    if (typeof isBlueTickVerified !== 'boolean') {
        throw new ApiError(400, "isBlueTickVerified must be a boolean value");
    }

    const user = await User.findById(userId).select('-password -refreshToken');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    // Check if user has a business profile
    if (!user.isBusinessProfile) {
        throw new ApiError(400, "User must have a business profile to get blue tick verification");
    }

    user.isBlueTickVerified = isBlueTickVerified;
    await user.save();

    // Log admin activity
    await req.admin.logActivity(
        `blue_tick_${isBlueTickVerified ? 'verified' : 'unverified'}`,
        'user',
        userId,
        `Blue tick verification ${isBlueTickVerified ? 'granted' : 'revoked'} for user: ${user.username}. Reason: ${reason || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, {
            userId: user._id,
            username: user.username,
            fullName: user.fullName,
            isBusinessProfile: user.isBusinessProfile,
            isBlueTickVerified: user.isBlueTickVerified
        }, `Blue tick verification ${isBlueTickVerified ? 'granted' : 'revoked'} successfully`)
    );
});

// ===============================
// BUSINESS MANAGEMENT
// ===============================

// GET /api/v1/admin/businesses
export const getAllBusinesses = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { page = 1, limit = 20, search, isVerified, subscriptionStatus } = req.query;

    let filter = {};

    if (search) {
        filter.$or = [
            { businessName: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } }
        ];
    }

    if (typeof isVerified === 'string') {
        filter.isVerified = isVerified === 'true';
    }

    if (subscriptionStatus && ['active', 'inactive', 'pending'].includes(subscriptionStatus)) {
        filter.subscriptionStatus = subscriptionStatus;
    }

    const businesses = await Business.find(filter)
        .populate('userId', 'username fullName email')
        .select('-aadhaarNumber -gstNumber')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            businesses,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Businesses fetched successfully")
    );
});

// GET /api/v1/admin/businesses/pending-verification
export const getPendingBusinessVerifications = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { page = 1, limit = 20, search } = req.query;

    let filter = {
        $or: [
            { verificationStatus: 'pending' },
            { 'documents': { $elemMatch: { verified: false } } }
        ]
    };

    if (search) {
        filter.$and = [
            filter,
            {
                $or: [
                    { businessName: { $regex: search, $options: 'i' } },
                    { category: { $regex: search, $options: 'i' } },
                    { aadhaarNumber: { $regex: search, $options: 'i' } },
                    { gstNumber: { $regex: search, $options: 'i' } }
                ]
            }
        ];
    }

    const businesses = await Business.find(filter)
        .populate('userId', 'username fullName email phoneNumber')
        .populate('documents.verifiedBy', 'username fullName')
        .select('businessName businessType description category subcategory contact location aadhaarNumber gstNumber website plan subscriptionStatus createdAt verificationStatus documents')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    // Filter to show only unverified documents (excluding Aadhaar) for each business
    const businessesWithUnverifiedDocs = businesses.map(business => {
        const businessObj = business.toObject();
        if (businessObj.documents) {
            // Only show unverified documents that are NOT Aadhaar type
            businessObj.documents = businessObj.documents.filter(
                doc => !doc.verified && doc.documentType !== 'aadhaar'
            );
        }
        return businessObj;
    }).filter(business => {
        // Only include businesses that have non-Aadhaar documents or pending verification status
        return (business.documents && business.documents.length > 0) ||
               business.verificationStatus === 'pending';
    });

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            businesses: businessesWithUnverifiedDocs,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Pending business verifications fetched successfully")
    );
});

// POST /api/v1/admin/businesses/:businessId/verify
export const verifyBusinessAccount = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { businessId } = req.params;
    const { status, remarks, approveGst = false, approveAadhaar = false } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        throw new ApiError(400, "Status must be either 'approved' or 'rejected'");
    }

    const business = await Business.findById(businessId).populate('userId', 'username fullName email');
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    if (business.verificationStatus !== 'pending') {
        throw new ApiError(400, `Business verification is already ${business.verificationStatus}`);
    }

    if (status === 'approved') {
        // Approve the business
        business.isVerified = true;
        business.verificationStatus = 'approved';
        business.verificationRemarks = remarks || 'Business account and details verified and approved';
        business.verifiedAt = new Date();
        business.verifiedBy = req.admin._id;

        // Set subscription to active if approved
        business.subscriptionStatus = 'active';

        // Add approval details for specific documents
        if (business.gstNumber && approveGst) {
            business.gstVerified = true;
            business.gstVerifiedAt = new Date();
            business.gstVerifiedBy = req.admin._id;
        }

        if (business.aadhaarNumber && approveAadhaar) {
            business.aadhaarVerified = true;
            business.aadhaarVerifiedAt = new Date();
            business.aadhaarVerifiedBy = req.admin._id;
        }

    } else {
        // Reject the business
        business.isVerified = false;
        business.verificationStatus = 'rejected';
        business.verificationRemarks = remarks || 'Business account verification rejected';
        business.rejectedAt = new Date();
        business.rejectedBy = req.admin._id;

        // Keep subscription as pending if rejected
        business.subscriptionStatus = 'pending';
    }

    await business.save();

    // Log admin activity
    await req.admin.logActivity(
        `business_verification_${status}`,
        'business',
        businessId,
        `Business verification ${status} for: ${business.businessName} (${business.userId.username}). GST: ${approveGst ? 'Approved' : 'N/A'}, Aadhaar: ${approveAadhaar ? 'Approved' : 'N/A'}`
    );

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                _id: business._id,
                businessName: business.businessName,
                isVerified: business.isVerified,
                verificationStatus: business.verificationStatus,
                verificationRemarks: business.verificationRemarks,
                subscriptionStatus: business.subscriptionStatus,
                gstVerified: business.gstVerified || false,
                aadhaarVerified: business.aadhaarVerified || false
            },
            owner: {
                username: business.userId.username,
                fullName: business.userId.fullName,
                email: business.userId.email
            }
        }, `Business verification ${status} successfully`)
    );
});

// GET /api/v1/admin/businesses/:businessId/details
export const getBusinessVerificationDetails = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { businessId } = req.params;

    const business = await Business.findById(businessId)
        .populate('userId', 'username fullName email phoneNumber profileImageUrl')
        .populate('verifiedBy', 'username fullName')
        .populate('rejectedBy', 'username fullName')
        .populate('documents.verifiedBy', 'username fullName');

    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            business,
            verificationHistory: {
                verifiedAt: business.verifiedAt,
                verifiedBy: business.verifiedBy,
                rejectedAt: business.rejectedAt,
                rejectedBy: business.rejectedBy,
                gstVerifiedAt: business.gstVerifiedAt,
                gstVerifiedBy: business.gstVerifiedBy,
                aadhaarVerifiedAt: business.aadhaarVerifiedAt,
                aadhaarVerifiedBy: business.aadhaarVerifiedBy
            },
            documents: business.documents || []
        }, "Business verification details fetched successfully")
    );
});

// POST /api/v1/admin/businesses/:businessId/documents/:documentId/verify
export const verifyBusinessDocument = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { businessId, documentId } = req.params;
    const { status, remarks } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        throw new ApiError(400, "Status must be either 'approved' or 'rejected'");
    }

    const business = await Business.findById(businessId);
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    const document = business.documents.id(documentId);
    if (!document) {
        throw new ApiError(404, "Document not found");
    }

    if (status === 'approved') {
        document.verified = true;
        document.verifiedAt = new Date();
        document.verifiedBy = req.admin._id;
        document.remarks = remarks || 'Document verified and approved';
    } else {
        document.verified = false;
        document.verifiedAt = new Date();
        document.verifiedBy = req.admin._id;
        document.remarks = remarks || 'Document rejected';
    }

    await business.save();

    // Populate verifiedBy for response
    await business.populate('documents.verifiedBy', 'username fullName');

    // Log admin activity
    await req.admin.logActivity(
        `document_verification_${status}`,
        'business',
        businessId,
        `Document (${document.documentType}) ${status} for business: ${business.businessName}`
    );

    return res.status(200).json(
        new ApiResponse(200, {
            document: business.documents.id(documentId),
            businessName: business.businessName
        }, `Document ${status} successfully`)
    );
});

// GET /api/v1/admin/businesses/verification-history
export const getBusinessVerificationHistory = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageBusiness) {
        throw new ApiError(403, "Insufficient permissions to manage businesses");
    }

    const { page = 1, limit = 20, status } = req.query;

    let filter = {
        verificationStatus: { $exists: true, $ne: 'pending' }
    };

    if (status && ['approved', 'rejected'].includes(status)) {
        filter.verificationStatus = status;
    }

    const businesses = await Business.aggregate([
        { $match: filter },
        {
            $addFields: {
                lastVerificationDate: {
                    $max: ['$verifiedAt', '$rejectedAt']
                }
            }
        },
        { $sort: { lastVerificationDate: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit * 1 },
        {
            $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                as: 'userId',
                pipeline: [{ $project: { username: 1, fullName: 1, email: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'verifiedBy',
                foreignField: '_id',
                as: 'verifiedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'rejectedBy',
                foreignField: '_id',
                as: 'rejectedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $project: {
                businessName: 1,
                businessType: 1,
                category: 1,
                verificationStatus: 1,
                verificationRemarks: 1,
                isVerified: 1,
                subscriptionStatus: 1,
                gstVerified: 1,
                aadhaarVerified: 1,
                verifiedAt: 1,
                rejectedAt: 1,
                createdAt: 1,
                userId: { $arrayElemAt: ['$userId', 0] },
                verifiedBy: { $arrayElemAt: ['$verifiedBy', 0] },
                rejectedBy: { $arrayElemAt: ['$rejectedBy', 0] }
            }
        }
    ]);

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            businesses,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Business verification history fetched successfully")
    );
});

// ===============================
// ANALYTICS & DASHBOARD
// ===============================

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
            aadhaarNumber: { $exists: true, $ne: null, $ne: "" },
            isVerified: false
        }),
        Business.countDocuments({
            verificationStatus: 'pending',
            $or: [
                { businessName: { $exists: true, $ne: null, $ne: "" } },
                { aadhaarNumber: { $exists: true, $ne: null, $ne: "" } },
                { gstNumber: { $exists: true, $ne: null, $ne: "" } }
            ]
        }),
        User.countDocuments({ accountStatus: 'active' }),
        Business.countDocuments({ isVerified: true })
    ]);

    // Get recent activity (last 30 days)
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

// ===============================
// SUPER ADMIN FUNCTIONS
// ===============================

// POST /api/v1/admin/create-admin
export const createAdmin = asyncHandler(async (req, res) => {
    // Any admin can create new admin accounts since admin IS the super admin

    const { username, email, password, fullName, permissions } = req.body;

    if (!username || !email || !password || !fullName) {
        throw new ApiError(400, "All fields are required");
    }

    const existingAdmin = await Admin.findOne({
        $or: [{ username }, { email }]
    });

    if (existingAdmin) {
        throw new ApiError(409, "Admin with this username or email already exists");
    }

    const admin = await Admin.create({
        uid: `admin_${Date.now()}`,
        username,
        email,
        password,
        fullName,
        role: 'admin',
        permissions: permissions || {}, // Default permissions are already set in schema
        createdBy: req.admin._id
    });

    const createdAdmin = await Admin.findById(admin._id).select("-password -refreshToken");

    // Log activity
    await req.admin.logActivity(
        'admin_created',
        'admin',
        admin._id,
        `Created new admin: ${fullName} (${username})`
    );

    return res.status(201).json(
        new ApiResponse(201, createdAdmin, "Admin created successfully")
    );
});

// GET /api/v1/admin/all-admins
export const getAllAdmins = asyncHandler(async (req, res) => {
    // Any admin can view all admin accounts

    const admins = await Admin.find()
        .select('-password -refreshToken')
        .populate('createdBy', 'fullName username')
        .sort({ createdAt: -1 });

    return res.status(200).json(
        new ApiResponse(200, admins, "All admins fetched successfully")
    );
});

// PUT /api/v1/admin/:adminId/permissions
export const updateAdminPermissions = asyncHandler(async (req, res) => {
    // Any admin can update permissions since they are the super admin

    const { adminId } = req.params;
    const { permissions } = req.body;

    const admin = await Admin.findByIdAndUpdate(
        adminId,
        { permissions },
        { new: true }
    ).select('-password -refreshToken');

    if (!admin) {
        throw new ApiError(404, "Admin not found");
    }

    // Log activity
    await req.admin.logActivity(
        'admin_permissions_updated',
        'admin',
        adminId,
        `Updated permissions for admin: ${admin.fullName}`
    );

    return res.status(200).json(
        new ApiResponse(200, admin, "Admin permissions updated successfully")
    );
});
