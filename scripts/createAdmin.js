import mongoose from 'mongoose';
import { Admin } from '../src/models/admin.models.js';
import dotenv from 'dotenv';

dotenv.config();

const createAdmin = async () => {
    try {
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI);

        // Check if admin already exists
        const existingAdmin = await Admin.findOne({ role: 'admin' });
        if (existingAdmin) {
            process.exit(0);
        }

        // Create admin with full permissions (admin IS the super admin)
        const admin = await Admin.create({
            uid: `admin_${Date.now()}`,
            username: 'admin',
            email: 'admin@findernate.com', // Change this to your desired email
            password: 'Admin@123', // Change this to a strong password
            fullName: 'Administrator',
            role: 'admin',
            permissions: {
                verifyAadhaar: true,
                manageReports: true,
                manageUsers: true,
                manageBusiness: true,
                systemSettings: true,
                viewAnalytics: true,
                deleteContent: true,
                banUsers: true
            },
            isActive: true
        });

    } catch (error) {
        console.error('Error creating admin:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
};

createAdmin();
