import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// POST /api/v1/business/bank-details
export const addOrUpdateBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const {
        accountHolderName,
        bankName,
        accountNumber,
        ifscCode,
        accountType,
        upiId,
        branchName
    } = req.body;

    if (!accountHolderName || !bankName || !accountNumber || !ifscCode || !accountType) {
        throw new ApiError(400, "Account holder name, bank name, account number, IFSC code, and account type are required");
    }

    if (!['savings', 'current'].includes(accountType.toLowerCase())) {
        throw new ApiError(400, "Account type must be either 'savings' or 'current'");
    }

    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (!ifscRegex.test(ifscCode.toUpperCase())) {
        throw new ApiError(400, "Invalid IFSC code format");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile. Please create a business profile first.");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    let paymentQRCodeUrl = business.bankDetails?.paymentQRCode;
    if (req.file) {
        const { uploadBufferToBunny } = await import('../../utils/bunny.js');

        const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedImageTypes.includes(req.file.mimetype)) {
            throw new ApiError(400, "Payment QR code must be an image (JPEG, PNG, or WebP)");
        }

        const folder = 'payment-qr-codes';
        const fileExtension = req.file.originalname.split('.').pop();
        const fileName = `qr-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExtension}`;

        const uploadResult = await uploadBufferToBunny(req.file.buffer, folder, fileName);

        if (!uploadResult || !uploadResult.url) {
            throw new ApiError(500, "Failed to upload payment QR code to storage");
        }

        paymentQRCodeUrl = uploadResult.url;
    }

    business.bankDetails = {
        accountHolderName: accountHolderName.trim(),
        bankName: bankName.trim(),
        accountNumber,
        ifscCode: ifscCode.toUpperCase(),
        accountType: accountType.toLowerCase(),
        upiId: upiId ? upiId.toLowerCase() : business.bankDetails?.upiId,
        branchName: branchName ? branchName.trim() : business.bankDetails?.branchName,
        paymentQRCode: paymentQRCodeUrl,
        isVerified: false,
        verifiedAt: null,
        verifiedBy: null,
        updatedAt: new Date()
    };

    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            bankDetails: {
                accountHolderName: business.bankDetails.accountHolderName || '',
                bankName: business.bankDetails.bankName || '',
                accountNumber: '****' + business.bankDetails.accountNumber.slice(-4),
                ifscCode: business.bankDetails.ifscCode || '',
                accountType: business.bankDetails.accountType || '',
                upiId: business.bankDetails.upiId || '',
                branchName: business.bankDetails.branchName || '',
                paymentQRCode: business.bankDetails.paymentQRCode || null,
                isVerified: business.bankDetails.isVerified || false,
                updatedAt: business.bankDetails.updatedAt || null
            }
        }, "Bank details updated successfully")
    );
});

// GET /api/v1/business/bank-details
export const getBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    if (!business.bankDetails || !business.bankDetails.accountNumber) {
        return res.status(200).json(
            new ApiResponse(200, {
                bankDetails: null,
                hasBankDetails: false
            }, "No bank details found")
        );
    }

    const accountNumber = business.bankDetails.accountNumber || '';
    const maskedAccountNumber = accountNumber.length >= 4
        ? '****' + accountNumber.slice(-4)
        : accountNumber;

    return res.status(200).json(
        new ApiResponse(200, {
            bankDetails: {
                accountHolderName: business.bankDetails.accountHolderName || '',
                bankName: business.bankDetails.bankName || '',
                accountNumber: maskedAccountNumber,
                ifscCode: business.bankDetails.ifscCode || '',
                accountType: business.bankDetails.accountType || '',
                upiId: business.bankDetails.upiId || '',
                branchName: business.bankDetails.branchName || '',
                paymentQRCode: business.bankDetails.paymentQRCode || null,
                isVerified: business.bankDetails.isVerified || false,
                verifiedAt: business.bankDetails.verifiedAt || null,
                updatedAt: business.bankDetails.updatedAt || null
            },
            hasBankDetails: true
        }, "Bank details retrieved successfully")
    );
});

// DELETE /api/v1/business/bank-details
export const deleteBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    if (!business.bankDetails || !business.bankDetails.accountNumber) {
        throw new ApiError(400, "No bank details to delete");
    }

    // Payout is manual, and these are the instructions the admin reads at payout
    // time: adminEscrow.controllers.js looks up Business.bankDetails when the
    // release is actually performed, not when the order is placed. Removing them
    // while money is still held leaves the admin with nowhere to send it, and
    // the release still goes through and debits the escrow ledger.
    const { default: Order } = await import("../../models/order.models.js");
    const heldOrders = await Order.countDocuments({
        sellerId: userId,
        paymentStatus: { $in: ['held', 'paid'] }
    });
    if (heldOrders > 0) {
        throw new ApiError(
            409,
            `You have ${heldOrders} order(s) with payment still in escrow. Your bank details are needed to pay you out and cannot be removed until those payouts are settled.`
        );
    }

    business.bankDetails = undefined;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {}, "Bank details deleted successfully")
    );
});
