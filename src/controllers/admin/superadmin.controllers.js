import { Admin } from "../../models/admin.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// POST /api/v1/admin/create-admin
export const createAdmin = asyncHandler(async (req, res) => {
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
        permissions: permissions || {},
        createdBy: req.admin._id
    });

    const createdAdmin = await Admin.findById(admin._id).select("-password -refreshToken");

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
