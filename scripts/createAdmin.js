/**
 * Bootstrap the first admin account, non-interactively, from the environment.
 *
 * THIS SCRIPT USED TO SHIP A WORKING SUPER ADMIN. It created
 * admin@findernate.com / Admin@123 — both literals committed to this
 * repository — and because it set no `createdBy`, isSuperAdmin() in
 * controllers/admin/superadmin.controllers.js classified that account as the
 * SUPER ADMIN. Anyone who read the repo could sign in to the admin panel. It
 * also printed nothing, so a run that had just minted that account looked
 * identical to a run that did nothing.
 *
 * Every field is now required from the environment and there are no defaults to
 * fall back to: with nothing set, the script refuses and exits non-zero.
 *
 *   ADMIN_EMAIL=you@example.com \
 *   ADMIN_USERNAME=youradmin \
 *   ADMIN_FULL_NAME="Your Name" \
 *   ADMIN_PASSWORD='<a real password>' \
 *   node scripts/createAdmin.js
 *
 * PREFER `node scripts/create-admin.mjs`, which prompts for the password
 * instead of taking it from the environment (an env var is readable from the
 * process listing and tends to end up in shell history and CI logs). This
 * script exists for provisioning where a prompt is not possible.
 *
 * Safe to re-run: it never overwrites an existing admin.
 */
import mongoose from 'mongoose';
import { Admin } from '../src/models/admin.models.js';
import dotenv from 'dotenv';

dotenv.config();

// The credentials this script used to hard-code. They are public, so refuse
// them explicitly rather than letting someone paste them back in.
const PUBLISHED_EMAIL = 'admin@findernate.com';
const PUBLISHED_PASSWORD = 'Admin@123';

const createAdmin = async () => {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
    const fullName = (process.env.ADMIN_FULL_NAME || '').trim();
    const password = process.env.ADMIN_PASSWORD || '';

    const missing = [
        !email && 'ADMIN_EMAIL',
        !username && 'ADMIN_USERNAME',
        !fullName && 'ADMIN_FULL_NAME',
        !password && 'ADMIN_PASSWORD'
    ].filter(Boolean);

    if (missing.length) {
        console.error(
            'Refusing to create an admin: ' + missing.join(', ') + ' not set.\n' +
            'This script has no default credentials. See the comment at the top of ' +
            'scripts/createAdmin.js, or use scripts/create-admin.mjs instead.'
        );
        process.exit(1);
    }

    if (email === PUBLISHED_EMAIL || password === PUBLISHED_PASSWORD) {
        console.error(
            'Refusing to create an admin with the credentials that were published ' +
            'in this repository. Choose a different email and password.'
        );
        process.exit(1);
    }

    if (password.length < 8) {
        console.error('Refusing to create an admin: ADMIN_PASSWORD must be at least 8 characters.');
        process.exit(1);
    }

    if (!process.env.MONGODB_URI) {
        console.error('Refusing to create an admin: MONGODB_URI is not set.');
        process.exit(1);
    }

    let exitCode = 0;

    try {
        await mongoose.connect(process.env.MONGODB_URI);

        // Never overwrite or silently duplicate — that would change who holds
        // the keys to the whole system.
        const existingAdmin = await Admin.findOne({
            $or: [{ email }, { username }]
        });
        if (existingAdmin) {
            console.log('An admin already exists with that email or username. Nothing changed.');
            return;
        }

        const admin = await Admin.create({
            uid: `admin_${Date.now()}`,
            username,
            email,
            password, // hashed by the model's pre-save hook
            fullName,
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
            isActive: true,
            // Null creator is what makes this the root/super admin — deliberate
            // for the bootstrap account, and the reason nothing else may set it.
            createdBy: null
        });

        console.log('Admin created.');
        console.log('  id       :', admin._id.toString());
        console.log('  email    :', admin.email, '  <- log in with this');
        console.log('  username :', admin.username);
    } catch (error) {
        // The old version logged and then exited 0 from `finally`, so a failed
        // provisioning run looked successful to whatever called it.
        console.error('Error creating admin:', error);
        exitCode = 1;
    } finally {
        await mongoose.disconnect();
        process.exit(exitCode);
    }
};

createAdmin();
