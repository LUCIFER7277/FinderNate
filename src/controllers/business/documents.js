import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const VALID_DOCUMENT_TYPES = ['gst', 'aadhaar', 'pan', 'license', 'registration', 'other'];

// An admin has to be able to open the file to verify it, and it lands on a
// public pull zone. The QR upload in ./banking.js already checks its mimetype;
// this route did not, so any file at all could be pushed into paid storage under
// the "verification" name.
const ALLOWED_DOCUMENT_MIME_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf'
];

// Verification needs a handful of documents (GST, Aadhaar, PAN, licence,
// registration). Without a cap the array — and the storage behind it — grew
// without limit, one Bunny object per request.
const MAX_DOCUMENTS = 10;

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

    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(req.file.mimetype)) {
        throw new ApiError(400, "Document must be an image (JPEG, PNG, WebP) or a PDF");
    }

    if ((business.documents?.length || 0) >= MAX_DOCUMENTS) {
        throw new ApiError(400, `You can upload at most ${MAX_DOCUMENTS} verification documents. Please contact support to replace an existing one.`);
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
