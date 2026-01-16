import fetch from 'node-fetch';

/**
 * Normalizes address string by fixing common formatting issues
 * @param {string} address - The address string to normalize
 * @returns {string} Normalized address
 */
const normalizeAddress = (address) => {
    if (!address || typeof address !== 'string') return address;

    let normalized = address.trim();

    // Remove leading 't' or other single character prefixes that might be typos
    normalized = normalized.replace(/^[tT]\s*/, '');

    // Fix missing spaces after numbers (e.g., "600040India" -> "600040 India")
    normalized = normalized.replace(/(\d)([A-Za-z])/g, '$1 $2');

    // Fix missing spaces between words where lowercase is followed by uppercase and then lowercase
    // This handles cases like "VillaAnna" -> "Villa Anna", "WestChennai" -> "West Chennai"
    // The pattern [a-z][A-Z][a-z] ensures we're splitting actual word boundaries
    normalized = normalized.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');

    // Fix multiple spaces and trim
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
};

/**
 * Attempts to geocode a location using Nominatim API
 * @param {string} query - The location query string
 * @param {number} retries - Number of retry attempts
 * @returns {Promise<{latitude: number, longitude: number} | null>}
 */
const geocodeWithNominatim = async (query, retries = 2) => {
    const encoded = encodeURIComponent(query);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=1`;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Add delay between retries to respect rate limits
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }

            const response = await fetch(url, {
                headers: {
                    "User-Agent": "findernate-app",
                    "Accept": "application/json"
                }
            });

            if (!response.ok) {
                if (attempt < retries) {
                    continue;
                }
                return null;
            }

            const data = await response.json();
            if (data && Array.isArray(data) && data.length > 0 && data[0].lat && data[0].lon) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);

                // Validate coordinates
                if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                    return { latitude: lat, longitude: lon };
                }
            }

            return null;
        } catch (error) {
            console.error(`Geocoding attempt ${attempt + 1} failed for "${query}":`, error.message);
            if (attempt < retries) {
                continue;
            }
            return null;
        }
    }

    return null;
};

/**
 * Gets coordinates for a location with multiple fallback strategies
 * @param {string|Object} locationInput - Location name string or location object with name/address fields
 * @returns {Promise<{latitude: number, longitude: number} | null>}
 */
const getCoordinates = async (locationInput) => {
    if (!locationInput) return null;

    // Handle both string and object inputs
    let locationName = typeof locationInput === 'string' ? locationInput : locationInput.name || locationInput.address;
    const locationAddress = typeof locationInput === 'object' ? locationInput.address : null;
    const locationCity = typeof locationInput === 'object' ? locationInput.city : null;
    const locationState = typeof locationInput === 'object' ? locationInput.state : null;
    const locationCountry = typeof locationInput === 'object' ? locationInput.country : null;

    if (!locationName && !locationAddress) return null;

    // Strategy 1: Try with normalized full address/name
    const strategies = [];

    if (locationName) {
        const normalizedName = normalizeAddress(locationName);
        if (normalizedName) {
            strategies.push(normalizedName);
        }
    }

    // Strategy 2: Try with address field if different from name
    if (locationAddress && locationAddress !== locationName) {
        const normalizedAddress = normalizeAddress(locationAddress);
        if (normalizedAddress && !strategies.includes(normalizedAddress)) {
            strategies.push(normalizedAddress);
        }
    }

    // Strategy 3: Try with city, state, country combination
    if (locationCity || locationState || locationCountry) {
        const cityStateCountry = [locationCity, locationState, locationCountry]
            .filter(Boolean)
            .join(', ');
        if (cityStateCountry && !strategies.includes(cityStateCountry)) {
            strategies.push(cityStateCountry);
        }
    }

    // Strategy 4: Try with just city and state
    if (locationCity && locationState) {
        const cityState = `${locationCity}, ${locationState}`;
        if (!strategies.includes(cityState)) {
            strategies.push(cityState);
        }
    }

    // Strategy 5: Try with just city
    if (locationCity && !strategies.includes(locationCity)) {
        strategies.push(locationCity);
    }

    // Try each strategy until one succeeds
    for (const query of strategies) {
        if (!query || query.trim().length === 0) continue;

        const coords = await geocodeWithNominatim(query);
        if (coords && coords.latitude && coords.longitude) {
            return coords;
        }

        // Small delay between strategies to respect rate limits
        if (strategies.indexOf(query) < strategies.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return null;
};

export { getCoordinates };
