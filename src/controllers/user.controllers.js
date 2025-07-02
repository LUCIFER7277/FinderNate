import { asyncHandler } from "../utlis/asyncHandler.js";
import { ApiError } from "../utlis/ApiError.js";
import { ApiResponse } from "../utlis/ApiResponse.js";
import {User} from "../models/user.models.js";
import jwt from "jsonwebtoken";

const registerUser = asyncHandler (async (req, res) => {

    console.log("📩 Received request:", req.body);
    const {fullName, username, email, password} = req.body;
     
    console.log(email);

    if(!fullName || !username || !email || !password) {
        throw new ApiError(400, "All fields are required");
    }

    const existedUser = await User.findOne({
        $or: [{username}, {email}]
    })

    if(existedUser) {
        throw new ApiError(409, "User already exists");
    }

    const user = await User.create({
        fullName,
        email,
        password,
        username: username.toLowerCase()
    })

    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
     );

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering user");
     }
    return res.status(201).json(
        new ApiResponse(200, createdUser, "User registered successfully")
     )
})

export { registerUser };