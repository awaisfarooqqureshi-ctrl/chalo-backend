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
    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 3. Search Places (Proxy)
router.get('/search', async (req, res) => {
    const { query } = req.query;
    try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${MAPS_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
