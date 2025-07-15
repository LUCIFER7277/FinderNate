import dotenv from 'dotenv';
dotenv.config();

import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";


cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});


export const uploadBufferToCloudinary = (fileBuffer, folder = "profile_images") => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: "auto",
                folder: folder,
            },
            (error, result) => {
                if(error) return reject(error);
                return resolve(result);
            }
        );
        streamifier.createReadStream(fileBuffer).pipe(stream);
    });
};