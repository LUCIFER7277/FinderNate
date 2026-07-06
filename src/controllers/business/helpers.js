export const BUSINESS_CATEGORIES = [
    "Technology & Software",
    "E-commerce & Retail",
    "Health & Wellness",
    "Education & Training",
    "Finance & Accounting",
    "Marketing & Advertising",
    "Real Estate",
    "Travel & Hospitality",
    "Food & Beverage",
    "Fashion & Apparel",
    "Automotive",
    "Construction & Engineering",
    "Legal & Consulting",
    "Entertainment & Media",
    "Art & Design",
    "Logistics & Transportation",
    "Agriculture & Farming",
    "Manufacturing & Industrial",
    "Non-profit & NGOs",
    "Telecommunications"
];

export function extractTagsFromText(...fields) {
    const text = fields.filter(Boolean).join(' ').toLowerCase();
    const words = text.match(/\b\w+\b/g) || [];
    const stopwords = new Set(['the', 'and', 'for', 'with', 'new', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'by', 'is', 'we']);
    return [...new Set(words.filter(word => word.length > 2 && !stopwords.has(word)))];
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
