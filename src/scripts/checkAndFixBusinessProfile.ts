import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../models/user.models.js';
import type { IUser } from '../types/user.types.js';

dotenv.config();

async function checkUser(): Promise<void> {
    try {
        await mongoose.connect(process.env.MONGODB_URI!);
        const user: IUser | null = await User.findOne({ username: 'darksuryansh' })
            .select('username isBusinessProfile businessDetails');
        console.log('User info:');
        console.log(JSON.stringify(user, null, 2));

        if (!user!.isBusinessProfile) {
            console.log('\n⚠️ User is NOT a business profile!');
            console.log('The "My Sales" tab only shows for business profiles.');
            console.log('\nUpdating user to have business profile...');

            await User.updateOne(
                { username: 'darksuryansh' },
                { $set: { isBusinessProfile: true } }
            );
            console.log('✅ User updated! Now refresh the page to see "My Sales" tab.');
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkUser();
