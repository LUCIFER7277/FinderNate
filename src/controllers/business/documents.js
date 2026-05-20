import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const VALID_DOCUMENT_TYPES = ['gst', 'aadhaar', 'pan', 'license', 'registration', 'other'];

// POST /api/v1/business/upload-document
export const uploadVerificationDocument = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found. Please create a business profile first.");
    }

    if (!req.file) {
        throw new ApiError(400, "Document file is required");
    }

    const { documentType, documentName } = req.body;

    if (!documentType) {
        throw new ApiError(400, "documentType is required");
    }

    if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
        throw new ApiError(400, `Invalid document type. Must be one of: ${VALID_DOCUMENT_TYPES.join(', ')}`);
    }

    const { uploadBufferToBunny } = await import('../../utils/bunny.js');

    const folder = 'documents';
    const fileExtension = req.file.originalname.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExtension}`;

    const uploadResult = await uploadBufferToBunny(req.file.buffer, folder, fileName);

    if (!uploadResult || !uploadResult.url) {
        throw new ApiError(500, "Failed to upload document to storage");
    }

    business.documents.push({
        documentType,
        documentName: documentName || req.file.originalname,
        documentUrl: uploadResult.url,
        uploadedAt: new Date(),
        verified: false
    });

    await business.save();

    return res.status(201).json(
        new ApiResponse(201, {
            document: business.documents[business.documents.length - 1],
            uploadedFile: {
                url: uploadResult.url,
                size: req.file.size,
                mimetype: req.file.mimetype,
                originalName: req.file.originalname
            },
            totalDocuments: business.documents.length
        }, "Document uploaded and submitted for verification successfully")
    );
});
