import mongoose from 'mongoose';
import Business from './src/models/business.models.js';
import BusinessRating from './src/models/businessRating.models.js';
import { User } from './src/models/user.models.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/findernate';

async function checkReviews() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');

        // Find all businesses
        const businesses = await Business.find().select('_id userId businessName isBusinessProfile');
        console.log('Total businesses:', businesses.length);
        
        for (const business of businesses) {
            // Get ratings for this business
            const ratings = await BusinessRating.find({ businessId: business._id });
            
            if (ratings.length > 0) {
                const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
                console.log('\n=== Business with Reviews ===');
                console.log('Business Name:', business.businessName);
                console.log('Business ID:', business._id);
                console.log('User ID:', business.userId);
                console.log('Total Reviews:', ratings.length);
                console.log('Average Rating:', avgRating.toFixed(1));
                
                // Get user details
                const user = await User.findById(business.userId).select('username fullName');
                if (user) {
                    console.log('Username:', user.username);
                    console.log('Full Name:', user.fullName);
                }
            }
        }

        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkReviews();
