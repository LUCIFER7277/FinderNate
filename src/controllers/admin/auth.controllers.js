import { Admin } from "../../models/admin.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

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
