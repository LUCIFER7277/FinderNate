import { asyncHandler } from "../utlis/asyncHandler.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import { v4 as uuidv4 } from "uuid";


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
    console.log("📩 Received request:", req.body);
    const { fullName, username, email, password, phoneNumber, dateOfBirth, gender } = req.body;

    // ✅ Basic validation
    if (!fullName || !username || !email || !password) {
        throw new ApiError(400, "Full name, username, email and password are required");
    }

    // ✅ Detailed duplicate checks
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

    // ✅ Create user
    const user = await User.create({
        uid: uuidv4(),
        fullName,
        fullNameLower: fullName.toLowerCase(),
        username: username.toLowerCase(),
        email,
        password,
        phoneNumber,
        dateOfBirth,
        gender
    });

    const createdUser = await User.findById(user._id).select("-password -refreshToken");

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering user");
    }

    // ✅ Return successful response
    return res.status(201).json(
        new ApiResponse(201, createdUser, "User registered successfully")
    );
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, username, fullName, fullNameLower, password } = req.body;

    if (!(username || email)) {
        throw new ApiError(400, "username or email is required");
    }

    const user = await User.findOne({
        $or: [{ username }, { email }]
    })
    if (!user) {
        throw new ApiError(404, "User does not exist");
    }

    const isPasswordValid = await user.isPasswordCorrect(password);

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid user credentials");
    }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);

    const loggedUser = await User.findById(user._id).select("-password -refreshToken");

    const options = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedUser,
                    accessToken,
                    refreshToken
                },
                "User logged in successfully"
            )
        )
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
})

export {
    registerUser,
    loginUser,
    logOutUser
};
