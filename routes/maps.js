const express = require('express');
const router = express.Router();
const axios = require('axios');

const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// 1. Get Directions (Proxy)
router.get('/directions', async (req, res) => {
    const { origin, destination, waypoints } = req.query;
    if (!MAPS_API_KEY) return res.status(503).send("Maps key missing on server");

    try {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&waypoints=${waypoints || ''}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 2. Reverse Geocode (Proxy)
router.get('/reverse', async (req, res) => {
    const { lat, lon } = req.query;
    console.log(`🔍 Reverse Geocoding for: ${lat}, ${lon}`);

    if (!MAPS_API_KEY) {
        console.error("❌ Maps Key Missing on Server");
        return res.status(503).send("Maps key missing on server");
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url);

        if (response.data.status !== "OK") {
            console.warn(`⚠️ Google API Error: ${response.data.status}. Falling back to Nominatim.`);
            // Fallback to Nominatim
            const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
            const nomRes = await axios.get(nominatimUrl, { headers: { 'User-Agent': 'ChaloDrive-App' } });

            // Map Nominatim to Google-like format for App compatibility
            return res.json({
                status: "OK",
                results: [{
                    formatted_address: nomRes.data.display_name
                }]
            });
        }

        console.log(`✅ Found Address: ${response.data.results[0]?.formatted_address}`);
        res.json(response.data);
    } catch (e) {
        console.error("❌ Geocode Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 3. Search Places (Proxy)
router.get('/search', async (req, res) => {
    const { query } = req.query;
    console.log(`🔍 Searching for: ${query}`);

    if (!MAPS_API_KEY) return res.status(503).send("Maps key missing");

    try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${MAPS_API_KEY}&region=pk`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        console.error("❌ Search Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
