import { ApiError } from "../utlis/ApiError.js";
import { asyncHandler } from "../utlis/asyncHandler.js";
import jwt from "jsonwebtoken";
import { Admin } from "../models/admin.models.js";

export const verifyAdminJWT = asyncHandler(async (req, res, next) => {
    try {
        const token = req.cookies?.adminAccessToken || req.header("Authorization")?.replace("Bearer ", "");

        if (!token) {
            throw new ApiError(401, "Unauthorized admin request");
        }

        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

        const admin = await Admin.findById(decodedToken?._id).select("-password -refreshToken");

        if (!admin) {
            throw new ApiError(401, "Invalid admin access token");
        }

        if (!admin.isActive) {
            throw new ApiError(403, "Admin account is deactivated");
        }

        req.admin = admin;
        next();
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid admin access token");
    }
});

// Since admin IS the super admin, this just ensures they're an admin
export const requireAdmin = asyncHandler(async (req, res, next) => {
    if (!req.admin) {
        throw new ApiError(403, "Admin access required");
    }
    next();
});

export const requirePermission = (permission) => {
    return asyncHandler(async (req, res, next) => {
        if (!req.admin.permissions[permission]) {
            throw new ApiError(403, `Insufficient permissions: ${permission} required`);
        }
        next();
    });
};
