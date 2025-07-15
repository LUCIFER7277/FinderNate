import fetch from 'node-fetch';

const getCoordinates = async (locationName) => {
    const encoded = encodeURIComponent(locationName);
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encoded}`, {
        headers: { "User-Agent": "findernate-app" }
    });

    const data = await response.json();
    if (data && data[0]) {
        return {
            latitude: parseFloat(data[0].lat),
            longitude: parseFloat(data[0].lon)
        };
    }

    return null;
};

export { getCoordinates };
