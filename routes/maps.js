const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');

// 1. CACHE SETUP (Scale Optimization: Reduces API Costs & Improves Speed)
// Cache directions for 24 hours (10 million users don't need to fetch the same route again)
const mapsCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Trim keys to prevent hidden space issues
const MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

// 2. Get Directions (OSRM-FIRST Optimization: Saves $1000s in Google Fees)
router.get('/directions', async (req, res) => {
    const { origin, destination, waypoints } = req.query;
    const cacheKey = `dir_${origin}_${destination}_${waypoints || 'none'}`;

    // Check Cache first
    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) {
        console.log("⚡ Serving Directions from Cache");
        return res.json(cachedResult);
    }

    console.log(`🛣️ Route Request: ${origin} to ${destination}`);

    try {
        // PREFER OSRM (FREE) over Google (PAID) for high-scale cost saving
        // Google is kept as a fallback for high-precision or if OSRM is down
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.split(',').reverse().join(',')};${destination.split(',').reverse().join(',')}?overview=full&geometries=polyline`;

        try {
            const osrmRes = await axios.get(osrmUrl, { timeout: 4000 });
            if (osrmRes.data.code === "Ok") {
                console.log("✅ OSRM Directions Success (Free)");
                const result = {
                    status: "OK",
                    routes: [{
                        overview_polyline: { points: osrmRes.data.routes[0].geometry },
                        legs: []
                    }]
                };
                mapsCache.set(cacheKey, result);
                return res.json(result);
            }
        } catch (osrmErr) {
            console.warn("⚠️ OSRM Failed, Falling back to Google...");
        }

        // FALLBACK TO GOOGLE (PAID)
        if (!MAPS_API_KEY) return res.status(503).send("Maps key missing");

        const googleUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&waypoints=${waypoints || ''}&key=${MAPS_API_KEY}`;
        const response = await axios.get(googleUrl, { timeout: 8000 });

        if (response.data.status === "OK") {
            console.log("✅ Google Directions Success (Paid)");
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }

        res.json({ status: "ZERO_RESULTS", routes: [] });
    } catch (e) {
        console.error("❌ Directions Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 3. Reverse Geocode (Proxy with Caching)
router.get('/reverse', async (req, res) => {
    const { lat, lon } = req.query;
    const cacheKey = `rev_${parseFloat(lat).toFixed(4)}_${parseFloat(lon).toFixed(4)}`;

    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    try {
        // Try Nominatim (FREE) First
        const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
        try {
            const nomRes = await axios.get(nomUrl, {
                headers: { 'User-Agent': 'ChaloDrive-App-Scale-Proxy' },
                timeout: 3000
            });
            // NOMINATIM SCALE FIX: If result is too short or just numbers, it's a poor result
            if (nomRes.data.display_name && nomRes.data.display_name.length > 15) {
                console.log("✅ Reverse Geocoding Success (OSM)");
                const result = {
                    status: "OK",
                    results: [{ formatted_address: nomRes.data.display_name }]
                };
                mapsCache.set(cacheKey, result);
                return res.json(result);
            }
        } catch (err) {
            console.warn("⚠️ OSM Reverse Failed or Poor Quality, using Google...");
        }

        // Google Fallback
        if (!MAPS_API_KEY) return res.json({ status: "OK", results: [{ formatted_address: `${lat}, ${lon}` }] });
        const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${MAPS_API_KEY}`;
        const response = await axios.get(googleUrl, { timeout: 5000 });

        if (response.data.status === "OK") {
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }

        res.json({ status: "OK", results: [{ formatted_address: `${lat}, ${lon}` }] });
    } catch (e) {
        res.json({ status: "ERROR", results: [] });
    }
});

// 4. Search Places (Proxy with Caching)
router.get('/search', async (req, res) => {
    const { query } = req.query;
    const cacheKey = `search_${query.toLowerCase().trim()}`;

    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    try {
        // Try Nominatim (FREE) First for better scale
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&countrycodes=pk&limit=10`;
        try {
            const nomRes = await axios.get(nomUrl, {
                headers: { 'User-Agent': 'ChaloDrive-App-Scale-Proxy' },
                timeout: 4000
            });
            if (nomRes.data && nomRes.data.length > 0) {
                const result = {
                    status: "OK",
                    results: nomRes.data.map(item => ({
                        formatted_address: item.display_name,
                        geometry: { location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) } }
                    }))
                };
                mapsCache.set(cacheKey, result);
                return res.json(result);
            }
        } catch (err) {
            console.warn("⚠️ OSM Search Failed, using Google...");
        }

        if (!MAPS_API_KEY) return res.json({ status: "ZERO_RESULTS", results: [] });
        const googleUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${MAPS_API_KEY}&region=pk`;
        const response = await axios.get(googleUrl, { timeout: 8000 });

        if (response.data.status === "OK") {
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }

        res.json({ status: "ZERO_RESULTS", results: [] });
    } catch (e) {
        res.json({ status: "ERROR", results: [] });
    }
});

module.exports = router;
