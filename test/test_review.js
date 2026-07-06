import mongoose from 'mongoose';
import Business from '../src/models/business.models.js';
import BusinessRating from '../src/models/businessRating.models.js';
import { User } from '../src/models/user.models.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/findernate';

async function testReviews() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        // Find a user with a business profile
        const businesses = await Business.find().limit(5).populate('userId');
        console.log('\nBusinesses found:', businesses.length);
        
        for (const business of businesses) {
            console.log('\n---');
            console.log('Business:', business.businessName);
            console.log('User ID:', business.userId);
            
            // Check ratings for this business
            const ratings = await BusinessRating.find({ businessId: business._id });
            console.log('Ratings count:', ratings.length);
            
            if (ratings.length > 0) {
                const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
                console.log('Average rating:', avgRating.toFixed(1));
            }
        }

        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

testReviews();
