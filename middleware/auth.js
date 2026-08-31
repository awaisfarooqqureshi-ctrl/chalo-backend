const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const CHALO_SECRET = process.env.CHALO_SECRET || 'fallback_secret';
const CHALO_APP_KEY = process.env.CHALO_APP_KEY || 'chalo_app_v1_secret';

// 1. Verify Global App Key (Prevents external API calls from tools like Postman without the key)
const verifyAppKey = (req, res, next) => {
    const appKey = req.headers['x-chalo-app-key'];
    if (!appKey || appKey !== CHALO_APP_KEY) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid App Key" });
    }
    next();
};

// 2. Verify User Token (JWT)
const verifyToken = (req, res, next) => {
    // Bypass for browser-based test/seed links
    if (req.url.startsWith('/admin/test-') || req.url.startsWith('/admin/bonuses/seed')) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, CHALO_SECRET);
        req.user = decoded; // Contains userId
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: "Unauthorized: Invalid or expired token" });
    }
};

// 3. Verify Admin Role
const verifyAdmin = async (req, res, next) => {
    // Bypass for browser-based test/seed links
    if (req.url.startsWith('/admin/test-') || req.url.startsWith('/admin/bonuses/seed')) {
        return next();
    }

    const userId = req.user?.userId;
    if (!userId) return res.status(403).json({ success: false, message: "Access Forbidden" });

    try {
        const db = admin.database();
        const snapshot = await db.ref(`users/${userId}/role`).get();
        if (snapshot.exists() && (snapshot.val() === 'Admin' || snapshot.val() === 'admin')) {
            next();
        } else {
            res.status(403).json({ success: false, message: "Access Forbidden: Admin rights required" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during authorization" });
    }
};

module.exports = { verifyAppKey, verifyToken, verifyAdmin };
