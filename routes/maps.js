const express = require('express');
const router = express.Router();
const axios = require('axios');

// Trim keys to prevent hidden space issues
const MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

// 1. Get Directions (Proxy)
router.get('/directions', async (req, res) => {
    const { origin, destination, waypoints } = req.query;
    console.log(`🛣️ Route: ${origin} to ${destination}`);

    if (!MAPS_API_KEY) return res.status(503).send("Maps key missing on server");

    try {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&waypoints=${waypoints || ''}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url, { timeout: 10000 });
        res.json(response.data);
    } catch (e) {
        console.error("❌ Directions Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 2. Reverse Geocode (Proxy)
router.get('/reverse', async (req, res) => {
    const { lat, lon } = req.query;
    console.log(`🔍 Reverse Geocoding: ${lat}, ${lon}`);

    if (!MAPS_API_KEY) return res.status(503).send("Maps key missing");

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url, { timeout: 8000 });

        if (response.data.status === "OK") {
            console.log(`✅ Google Found: ${response.data.results[0]?.formatted_address}`);
            return res.json(response.data);
        }

        console.warn(`⚠️ Google Failed (${response.data.status}). Trying Nominatim...`);
        const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
        const nomRes = await axios.get(nomUrl, {
            headers: { 'User-Agent': 'ChaloDrive-App-Proxy' },
            timeout: 5000
        });

        res.json({
            status: "OK",
            results: [{ formatted_address: nomRes.data.display_name || `${lat}, ${lon}` }]
        });
    } catch (e) {
        console.error("❌ Reverse Proxy Error:", e.message);
        res.json({ status: "ERROR", results: [] });
    }
});

// 3. Search Places (Proxy)
router.get('/search', async (req, res) => {
    const { query } = req.query;
    console.log(`🔍 Search: ${query}`);

    if (!MAPS_API_KEY) return res.status(503).send("Maps key missing");

    try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${MAPS_API_KEY}&region=pk`;
        const response = await axios.get(url, { timeout: 8000 });

        if (response.data.status === "OK") return res.json(response.data);

        console.warn(`⚠️ Google Search Failed. Trying Nominatim...`);
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&countrycodes=pk&limit=10`;
        const nomRes = await axios.get(nomUrl, {
            headers: { 'User-Agent': 'ChaloDrive-App-Proxy' },
            timeout: 5000
        });

        res.json({
            status: "OK",
            results: nomRes.data.map(item => ({
                formatted_address: item.display_name,
                geometry: { location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) } }
            }))
        });
    } catch (e) {
        console.error("❌ Search Proxy Error:", e.message);
        res.json({ status: "ERROR", results: [] });
    }
});

module.exports = router;
