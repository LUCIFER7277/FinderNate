import { asyncHandler } from "../utlis/asyncHandler.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { v4 as uuidv4 } from "uuid";
import { sendEmail } from "../utlis/sendEmail.js"
import { uploadBufferToCloudinary } from "../utlis/cloudinary.js";



const generateAcessAndRefreshToken = async (userId) => {
    try {
        const user = await User.findById(userId);
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave: false });

        return { accessToken, refreshToken };
    } catch (error) {
        throw new ApiError(500, "something went wrong while generating tokens");
    }
}

const registerUser = asyncHandler(async (req, res) => {
    const { fullName, username, email, password, confirmPassword, phoneNumber, dateOfBirth, gender } = req.body;

    if (!fullName || !username || !email || !password || !confirmPassword) {
        throw new ApiError(400, "All fields are required");
    }

     if(password !== confirmPassword) {
        throw new ApiError(400, "Password and confirm password do not match");
     }

    const errors = [];

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
        errors.push({ field: "email", message: "Email already in use" });
    }

    const existingUsername = await User.findOne({ username: username.toLowerCase() });
    if (existingUsername) {
        errors.push({ field: "username", message: "Username already in use" });
    }

    if (errors.length > 0) {
        throw new ApiError(409, "User already exists with this username or email", errors);
    }

    const user = await User.create({
        uid: uuidv4(),
        fullName,
        fullNameLower: fullName.toLowerCase(),
        username: username.toLowerCase(),
        email,
        password,
        phoneNumber,
        dateOfBirth,
        gender,
    });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    user.emailOTP = otp;
    user.emailOTPExpiry = expiry;
    await user.save({validateBeforeSave: false});

    await sendEmail({
        to: user.email,
        subject: "verify your email - FinderNate",
        html: `
                <h3>Email verification OTP</h3>
                <h2>Your OTP is: <b>${otp}</b></h2>
                <p>This OTP is valid for 10 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>`
    })

    const createdUser = await User.findById(user._id).select("-password -refreshToken");

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering user");
    }

    return res.status(201).json(
        new ApiResponse(201, createdUser, "User registered successfully")
    );
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, username, password } = req.body;

    if (!(email || username)) {
        throw new ApiError(400, "Email or username is required");
    }

    if (!password) {
        throw new ApiError(400, "Password is required");
    }

    const user = await User.findOne({
        $or: [{ email }, { username }]
    });

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid credentials");
    }

    // if(!user.isEmailVerified) {
    //     throw new ApiError(403, "Email is not verified. Please verify your email to login");
    // }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const loggedUser = await User.findById(user._id).select("-password -refreshToken");

    const options = {
        httpOnly: true,
        secure: true
    };

    return res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(200, {
            user: loggedUser,
            accessToken,
            refreshToken
        }, "Login successful"));
});


const logOutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                refreshToken: undefined
            }
        },
        {
            new: true
        }
    )

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(
            new ApiResponse(200, {}, "User logged Out Successfully")
        )
});

const getUserProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const user = await User.findById(userId).select(
        "username fullName email phoneNumber gender dateOfBirth bio profileImageUrl location link followers following posts isBusinessProfile isEmailVerified isPhoneVerified"
    );
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res
        .status(200)
        .json(
            new ApiResponse(200, user, "User profile retrieved successfully")
        )
});

const updateUserProfile = asyncHandler(async (req, res) => {
    const updates = req.body;

    const disallowedFields = [
        "email",
        "password",
        "refreshToken",
        "isEmailVerified",
        "isPhoneVerified",
        "acccoutStatus",
        "followers",
        "following",
        "posts",
        "uid"
    ];
    for (const field of disallowedFields) {
        if (updates.hasOwnProperty(field)) {
            throw new ApiError(400, `Field '${field}' cannot be updated`);
        }
    }

    if (updates.fullName) {
        updates.fullNameLower = updates.fullName.toLowerCase();
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        updates,
        {
            new: true,
            runValidators: true,
        })
        .select("-password -refreshToken -emailVerificationToken ");

    return res
        .status(200)
        .json(
            new ApiResponse(200, updatedUser, "User profile updated successfully")
        );
});

const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        throw new ApiError(400, "Current password and new password are required");
    }
    const user = await User.findById(req.user._id);
    const isMatch = await user.isPasswordCorrect(currentPassword);

    if (!isMatch) {
        throw new ApiError(401, "current Password is incorrect");
    }

    user.password = newPassword;
    await user.save();

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {},
                "Password changed Successfully"
            )
        )
});

const deleteAccount = asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
        throw new ApiError(400, "Password is required to delete your account");
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isMatch = await user.isPasswordCorrect(password);

    if (!isMatch) {
        throw new ApiError(401, "Password is incorrect");
    }
    user.refreshToken = null;

    await user.save({ validateBeforeSave: false });
    await user.deleteOne();

    return res
        .status(200)
        .clearCookie("accessToken")
        .clearCookie("refreshToken")
        .json(
            new ApiResponse(
                200,
                {},
                "Account deleted Successfully"
            )
        )

});

const searchUsers = asyncHandler(async (req, res) => {
    const { query } = req.query;

    if (!query || query.trim() == "") {
        throw new ApiError(400, "Search query is required");
    }

    const user = await User.find({
        accountStatus: "active",
        $or: [
            { username: new RegExp(query, "i") },
            { fullNameLower: new RegExp(query, "i") }
        ]
    }).select("username fullName profileImageUrl");

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Users found successfully"
            )
        );
});

const sendVerificationOTP = asyncHandler(async (req, res) => {
    
    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "Email is required");
    }

    const user = await User.findOne({ email });

    if (!user) {
        throw new ApiError(404, "User not found with this email");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // valid for 10 minutes

    user.emailOTP = otp;
    user.emailOTPExpiry = expiry;
    await user.save({ validateBeforeSave: false });

    
    await sendEmail({
        to: user.email,
        subject: "Your OTP for Email Verification - Findernate",
        html: `
            <h3>Email Verification OTP</h3>
            <h2>Your OTP is: <b>${otp}</b></h2>
            <p>This OTP is valid for 10 minutes.</p>
            <p>If you did not request this, please ignore this email.</p>
        `
    });

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "OTP sent to your email successfully"));
});

const verifyEmailWithOTP = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        throw new ApiError(400, "Email and OTP are required");
    }

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, "User not found");

    if (
        user.emailOTP !== otp ||
        !user.emailOTPExpiry ||
        user.emailOTPExpiry < new Date()
    ) {
        throw new ApiError(400, "Invalid or expired OTP");
    }

    user.isEmailVerified = true;
    user.emailOTP = undefined;
    user.emailOTPExpiry = undefined;
    user.emailVerificationToken = undefined;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, "Email verified successfully"));
})

const uploadProfileImage = asyncHandler(async (req, res) => {
    if(!req.file) {
        throw new ApiError(400, "Profile Image is required");
    }

    const userId = req.user._id;

    const uploadResult = await uploadBufferToCloudinary(req.file.buffer);

    if(!uploadResult || !uploadResult.secure_url) {
        throw new ApiError(500, "Failed to upload image to Cloudinary");
    }

    const user = await User.findByIdAndUpdate(userId,
        {profileImageUrl: uploadResult.secure_url},
        {new: true, runValidators: true}
    ).select("username fullName profileImageUrl")

    return res
    .status(200)
    .json(new ApiResponse(200, user, "profile image uploaded successfully"));
});


export {
    registerUser,
    loginUser,
    logOutUser,
    getUserProfile,
    updateUserProfile,
    changePassword,
    deleteAccount,
    searchUsers,
    verifyEmailWithOTP,
    sendVerificationOTP,
    uploadProfileImage
};
