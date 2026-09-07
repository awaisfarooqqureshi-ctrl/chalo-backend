const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');

// 1. CACHE SETUP (Scale Optimization: Reduces API Costs & Improves Speed)
// Cache directions for 24 hours (10 million users don't need to fetch the same route again)
const mapsCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Trim keys to prevent hidden space issues
const MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

// 2. Get Directions (OSRM-FIRST Optimization)
router.get('/directions', async (req, res) => {
    const { origin, destination, waypoints, lang } = req.query;
    const language = lang || 'en';
    const cacheKey = `dir_${origin}_${destination}_${waypoints || 'none'}_${language}`;

    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    try {
        // OSRM (Free) - Note: OSRM doesn't support complex language labels like Google
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin.split(',').reverse().join(',')};${destination.split(',').reverse().join(',')}?overview=full&geometries=polyline`;

        try {
            const osrmRes = await axios.get(osrmUrl, { timeout: 4000 });
            if (osrmRes.data.code === "Ok") {
                const result = {
                    status: "OK",
                    routes: [{ overview_polyline: { points: osrmRes.data.routes[0].geometry }, legs: [] }]
                };
                mapsCache.set(cacheKey, result);
                return res.json(result);
            }
        } catch (osrmErr) { console.warn("⚠️ OSRM Failed, using Google..."); }

        if (!MAPS_API_KEY) return res.status(503).send("Maps key missing");

        // Google Directions (Paid) with Language Support
        const googleUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&waypoints=${waypoints || ''}&key=${MAPS_API_KEY}&language=${language}`;
        const response = await axios.get(googleUrl, { timeout: 8000 });

        if (response.data.status === "OK") {
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }
        res.json({ status: "ZERO_RESULTS", routes: [] });
    } catch (e) {
        console.error("❌ Directions Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 3. Reverse Geocode (Proxy with Language Support)
router.get('/reverse', async (req, res) => {
    const { lat, lon, lang } = req.query;
    const language = lang || 'en';
    const cacheKey = `rev_${parseFloat(lat).toFixed(4)}_${parseFloat(lon).toFixed(4)}_${language}`;

    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    try {
        // Nominatim (Free) with Language Header
        const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=${language}`;
        try {
            const nomRes = await axios.get(nomUrl, {
                headers: { 'User-Agent': 'ChaloDrive-App', 'Accept-Language': language },
                timeout: 3000
            });
            if (nomRes.data.display_name && nomRes.data.display_name.length > 10) {
                const result = { status: "OK", results: [{ formatted_address: nomRes.data.display_name }] };
                mapsCache.set(cacheKey, result);
                return res.json(result);
            }
        } catch (err) { console.warn("⚠️ OSM Reverse Failed, using Google..."); }

        if (!MAPS_API_KEY) return res.json({ status: "OK", results: [{ formatted_address: `${lat}, ${lon}` }] });

        // Google Geocoding (Paid)
        const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${MAPS_API_KEY}&language=${language}`;
        const response = await axios.get(googleUrl, { timeout: 5000 });

        if (response.data.status === "OK") {
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }
        res.json({ status: "OK", results: [{ formatted_address: `${lat}, ${lon}` }] });
    } catch (e) { res.json({ status: "ERROR", results: [] }); }
});

// 4. Search Places (Proxy with Language Support)
router.get('/search', async (req, res) => {
    const { query, lang } = req.query;
    const language = lang || 'en';
    const cacheKey = `search_${query.toLowerCase().trim()}_${language}`;

    const cachedResult = mapsCache.get(cacheKey);
    if (cachedResult) return res.json(cachedResult);

    try {
        const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&countrycodes=pk&limit=10&accept-language=${language}`;
        try {
            const nomRes = await axios.get(nomUrl, {
                headers: { 'User-Agent': 'ChaloDrive-App', 'Accept-Language': language },
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
        } catch (err) { console.warn("⚠️ OSM Search Failed, using Google..."); }

        if (!MAPS_API_KEY) return res.json({ status: "ZERO_RESULTS", results: [] });
        const googleUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${MAPS_API_KEY}&region=pk&language=${language}`;
        const response = await axios.get(googleUrl, { timeout: 8000 });

        if (response.data.status === "OK") {
            mapsCache.set(cacheKey, response.data);
            return res.json(response.data);
        }
        res.json({ status: "ZERO_RESULTS", results: [] });
    } catch (e) { res.json({ status: "ERROR", results: [] }); }
});

module.exports = router;
