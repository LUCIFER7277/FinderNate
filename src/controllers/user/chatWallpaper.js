import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    CHAT_WALLPAPERS,
    isValidWallpaperId,
    normaliseWallpaperId,
} from "../../constants/chatWallpapers.js";

/**
 * The user's chat background wallpaper.
 *
 * One setting for every conversation, stored on the user rather than on any
 * chat, so it follows them between the app and the website and does not change
 * what the person they are talking to sees.
 */

// GET /api/v1/users/chat-wallpaper
// Returns the catalogue alongside the current choice, so a client can render
// the picker without shipping its own copy of the list and drifting from the
// server's idea of what is valid.
export const getChatWallpaper = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('chatWallpaper').lean();

    return res.status(200).json(
        new ApiResponse(200, {
            wallpaper: user?.chatWallpaper ?? null,
            available: CHAT_WALLPAPERS,
        }, 'Chat wallpaper retrieved')
    );
});

// PATCH /api/v1/users/chat-wallpaper   body: { wallpaper: '<id>' | null }
export const updateChatWallpaper = asyncHandler(async (req, res) => {
    const { wallpaper } = req.body;

    // `undefined` means the field was not sent at all, which is a malformed
    // request rather than a request to clear — clearing is an explicit null.
    if (!('wallpaper' in (req.body || {}))) {
        throw new ApiError(400, 'wallpaper is required (send null to clear it)');
    }

    if (!isValidWallpaperId(wallpaper)) {
        // Rejected rather than stored, because an id no client can draw would
        // save happily and then render as nothing, which looks like the
        // setting silently failing.
        throw new ApiError(400, 'Unknown wallpaper. Choose one from the available list.');
    }

    const value = normaliseWallpaperId(wallpaper);

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: { chatWallpaper: value } },
        { new: true }
    ).select('chatWallpaper').lean();

    return res.status(200).json(
        new ApiResponse(200, { wallpaper: user?.chatWallpaper ?? null },
            value === null ? 'Chat wallpaper cleared' : 'Chat wallpaper updated')
    );
});
