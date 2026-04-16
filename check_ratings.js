import mongoose from 'mongoose';
import BusinessRating from './src/models/businessRating.models.js';
import Business from './src/models/business.models.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/findernate';

async function checkRatings() {
    try {
        await mongoose.connect(MONGODB_URI);
        // console.log('Connected to MongoDB\n');

        // Check all collections
        // console.log('=== Checking Collections ===');
        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log('Available collections:', collections.map(c => c.name).join(', '));
        
        // Check BusinessRating collection
        const ratings = await BusinessRating.find().limit(10);
        // console.log('\nTotal ratings in BusinessRating:', await BusinessRating.countDocuments());
        
        if (ratings.length > 0) {
            // console.log('\nSample ratings:');
            for (const rating of ratings) {
                console.log('- Rating:', rating.rating, '| Business ID:', rating.businessId, '| User ID:', rating.userId);
            }
        }
        
        // Check Business collection
        const businesses = await Business.countDocuments();
        console.log('\nTotal businesses:', businesses);
        
        // Check collection names (case sensitive)
        const businessCollections = collections.filter(c => 
            c.name.toLowerCase().includes('business')
        );
        console.log('\nBusiness-related collections:', businessCollections.map(c => c.name).join(', '));

        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkRatings();
