import Business from "../../models/business.models.js";
import { createBusinessVerificationNotification } from "../notification.controllers.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

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

    const businessesWithUnverifiedDocs = businesses.map(business => {
        const businessObj = business.toObject();
        if (businessObj.documents) {
            businessObj.documents = businessObj.documents.filter(
                doc => !doc.verified && doc.documentType !== 'aadhaar'
            );
        }
        return businessObj;
    }).filter(business => {
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
        business.isVerified = true;
        business.verificationStatus = 'approved';
        business.verificationRemarks = remarks || 'Business account and details verified and approved';
        business.verifiedAt = new Date();
        business.verifiedBy = req.admin._id;
        business.subscriptionStatus = 'active';

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
        business.isVerified = false;
        business.verificationStatus = 'rejected';
        business.verificationRemarks = remarks || 'Business account verification rejected';
        business.rejectedAt = new Date();
        business.rejectedBy = req.admin._id;
        business.subscriptionStatus = 'pending';
    }

    await business.save();

    await req.admin.logActivity(
        `business_verification_${status}`,
        'business',
        businessId,
        `Business verification ${status} for: ${business.businessName} (${business.userId.username}). GST: ${approveGst ? 'Approved' : 'N/A'}, Aadhaar: ${approveAadhaar ? 'Approved' : 'N/A'}`
    );

    // The second of the two approval paths — both were silent, and fixing only
    // one would have made the notification depend on which screen the admin
    // happened to use.
    createBusinessVerificationNotification({
        recipientId: business.userId?._id || business.userId,
        approved: status === 'approved',
        businessName: business.businessName,
        remarks: business.verificationRemarks,
    }).catch((e) => console.warn(`[notify] verification notice failed: ${e?.message}`));

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
    await business.populate('documents.verifiedBy', 'username fullName');

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
