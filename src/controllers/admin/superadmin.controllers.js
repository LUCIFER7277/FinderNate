import { Admin } from "../../models/admin.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

/**
 * Who counts as a super admin.
 *
 * Minting admins and rewriting permissions were behind the blanket
 * verifyAdminJWT and nothing else, so any staff account — including a
 * "reports only" moderator — could PUT its own id with every flag true, or
 * create a fresh full-power account. A super admin is the root account
 * (createdBy null, the one scripts/create-admin.mjs makes on a fresh database)
 * or an account explicitly given role 'super_admin'; every admin created
 * through the API records its creator, so it can never be one.
 */
const isSuperAdmin = (admin) =>
    admin?.role === 'super_admin' || (!!admin && admin.createdBy == null);

export const requireSuperAdmin = asyncHandler(async (req, _res, next) => {
    if (!isSuperAdmin(req.admin)) {
        throw new ApiError(403, "Super admin access required");
    }
    next();
});

// Every permission the Admin schema knows about. The schema defaults each one
// to `true`, so `permissions: permissions || {}` handed a brand-new account the
// full set whenever a key was omitted — creating a moderator with
// {manageReports:true} actually produced an admin who could ban users, delete
// any content and change system settings. Unlisted means OFF.
const PERMISSION_KEYS = [
    'verifyAadhaar',
    'manageReports',
    'manageUsers',
    'manageBusiness',
    'systemSettings',
    'viewAnalytics',
    'deleteContent',
    'banUsers'
];

const buildPermissions = (requested) => {
    const source = requested && typeof requested === 'object' ? requested : {};
    return PERMISSION_KEYS.reduce((acc, key) => {
        acc[key] = source[key] === true;
        return acc;
    }, {});
};

// POST /api/v1/admin/create-admin
export const createAdmin = asyncHandler(async (req, res) => {
    if (!isSuperAdmin(req.admin)) {
        throw new ApiError(403, "Only a super admin can create admin accounts");
    }

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
        permissions: buildPermissions(permissions),
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
    if (!isSuperAdmin(req.admin)) {
        throw new ApiError(403, "Only a super admin can change admin permissions");
    }

    const { adminId } = req.params;
    const { permissions } = req.body;

    // No self-service escalation, even for the super admin: a compromised
    // session must not be able to widen the account it is already inside.
    if (adminId === req.admin._id.toString()) {
        throw new ApiError(403, "You cannot change your own permissions");
    }

    const target = await Admin.findById(adminId).select('_id createdBy role');
    if (!target) {
        throw new ApiError(404, "Admin not found");
    }

    if (isSuperAdmin(target)) {
        throw new ApiError(403, "A super admin's permissions cannot be changed");
    }

    const admin = await Admin.findByIdAndUpdate(
        adminId,
        { permissions: buildPermissions(permissions) },
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

// PUT /api/v1/admin/:adminId/status
/**
 * Deactivate or reactivate a staff admin.
 *
 * There was no way to switch an admin off through the API at all: no delete
 * route, no isActive route, and updateAdminPermissions refuses to touch a super
 * admin — so offboarding anyone, compromised or merely departed, meant a DBA
 * editing the admins collection in production. `isActive: false` is already
 * enforced on both paths that matter (verifyAdminJWT rejects the account on
 * every request, adminLogin refuses a fresh sign-in), so flipping it here is a
 * complete revocation, including for a token that has not expired yet — which
 * is currently the ONLY way to invalidate one.
 *
 * A super admin cannot be deactivated, for the same reason its permissions
 * cannot be rewritten: whoever is inside one super-admin session must not be
 * able to lock the other holders out of the platform. Revoking the root account
 * itself stays a deliberate, out-of-band operation.
 */
export const setAdminActiveStatus = asyncHandler(async (req, res) => {
    if (!isSuperAdmin(req.admin)) {
        throw new ApiError(403, "Only a super admin can activate or deactivate an admin");
    }

    const { adminId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
        throw new ApiError(400, "isActive must be true or false");
    }

    // No self-service lockout, and no way to strand the account you are in.
    if (adminId === req.admin._id.toString()) {
        throw new ApiError(403, "You cannot change your own account status");
    }

    const target = await Admin.findById(adminId).select('_id createdBy role fullName');
    if (!target) {
        throw new ApiError(404, "Admin not found");
    }

    if (isSuperAdmin(target)) {
        throw new ApiError(403, "A super admin's account status cannot be changed");
    }

    // Dropping the refresh token as well, so a deactivated admin cannot mint a
    // fresh access token if they are ever reactivated under a stolen session.
    const update = isActive
        ? { $set: { isActive: true } }
        : { $set: { isActive: false }, $unset: { refreshToken: 1 } };

    const admin = await Admin.findByIdAndUpdate(
        adminId,
        update,
        { new: true }
    ).select('-password -refreshToken');

    if (!admin) {
        throw new ApiError(404, "Admin not found");
    }

    await req.admin.logActivity(
        isActive ? 'admin_activated' : 'admin_deactivated',
        'admin',
        adminId,
        `${isActive ? 'Activated' : 'Deactivated'} admin: ${admin.fullName}`
    );

    return res.status(200).json(
        new ApiResponse(200, admin, `Admin ${isActive ? 'activated' : 'deactivated'} successfully`)
    );
});
