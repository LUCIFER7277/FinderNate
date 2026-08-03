import { Admin } from "../../models/admin.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { redisClient } from "../../config/redis.config.js";

/**
 * Per-ACCOUNT failed-sign-in throttle for the admin panel.
 *
 * adminLoginRateLimit (middlewares/rateLimiter.middleware.js) caps an IP, and
 * `x-forwarded-for` is caller-supplied, so an IP bucket on its own is bypassed
 * by rotating one header. This is the half that follows the account instead —
 * the same shape as assertLoginAttemptsAvailable in controllers/user/_helpers.js,
 * with its own key namespace and a much smaller budget, because a real admin
 * mistyping their password five times in fifteen minutes is already unusual.
 *
 * Fails OPEN if Redis is unavailable: the IP limiter is the one that fails
 * closed, so between the two something always holds.
 */
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const adminFailKey = (adminId) => `admin:login:fail:${adminId}`;

const assertAdminLoginAttemptsAvailable = async (adminId) => {
    if (!adminId) return;
    try {
        const count = Number(await redisClient.get(adminFailKey(adminId))) || 0;
        if (count >= ADMIN_LOGIN_MAX_FAILURES) {
            throw new ApiError(429,
                "Too many failed sign-in attempts. Please try again in a few minutes.");
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        console.error('[ADMIN LOGIN] failure throttle check skipped:', err.message);
    }
};

const registerFailedAdminLogin = async (adminId) => {
    if (!adminId) return;
    try {
        const key = adminFailKey(adminId);
        const count = await redisClient.incr(key);
        if (count === 1) {
            await redisClient.expire(key, Math.floor(ADMIN_LOGIN_FAIL_WINDOW_MS / 1000));
        }
    } catch (err) {
        console.error('[ADMIN LOGIN] failure counter skipped:', err.message);
    }
};

const clearFailedAdminLogins = async (adminId) => {
    if (!adminId) return;
    try {
        await redisClient.del(adminFailKey(adminId));
    } catch (err) {
        console.error('[ADMIN LOGIN] failure counter reset skipped:', err.message);
    }
};

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

    await assertAdminLoginAttemptsAvailable(admin._id);

    const isPasswordValid = await admin.isPasswordCorrect(password);
    if (!isPasswordValid) {
        await registerFailedAdminLogin(admin._id);
        throw new ApiError(401, "Invalid admin credentials");
    }

    await clearFailedAdminLogins(admin._id);

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
