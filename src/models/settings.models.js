import mongoose from 'mongoose';
import { ALLOWED_SETTING_KEYS } from '../constants/settings.js';

const SettingSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            enum: ALLOWED_SETTING_KEYS,
        },
        value: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
        },
    },
    { timestamps: true }
);

export default mongoose.model('Setting', SettingSchema);
