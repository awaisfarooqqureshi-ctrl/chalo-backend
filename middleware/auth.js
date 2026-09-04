const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const CHALO_SECRET = process.env.CHALO_SECRET || 'fallback_secret';
const CHALO_APP_KEY = process.env.CHALO_APP_KEY || 'chalo_app_v1_secret';

// 1. Verify Global App Key (STRICT PRODUCTION MODE)
const verifyAppKey = (req, res, next) => {
    if (typeof next !== 'function') {
        console.error("❌ Auth Middleware Error: 'next' is not a function in verifyAppKey");
        return res.status(500).json({ success: false, message: "Server Configuration Error" });
    }

    // Exempt Browser-based Payment Pages
    const path = req.originalUrl || req.url || "";
    if (path.includes('/payments/checkout') ||
        path.includes('/payments/success') ||
        path.includes('/payments/failure') ||
        path.includes('/payments/complete')) {
        return next();
    }

    const appKey = req.headers['x-chalo-app-key'];
    if (!appKey || appKey !== CHALO_APP_KEY) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid App Key" });
    }
    next();
};

// 2. Verify User Token (JWT)
const verifyToken = (req, res, next) => {
    if (typeof next !== 'function') {
        console.error("❌ Auth Middleware Error: 'next' is not a function in verifyToken");
        return res.status(500).json({ success: false, message: "Server Configuration Error" });
    }

    // Exempt Browser-based Payment Pages
    const path = req.originalUrl || req.url || "";
    if (path.includes('/payments/checkout') ||
        path.includes('/payments/success') ||
        path.includes('/payments/failure') ||
        path.includes('/payments/complete')) {
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

// 3. Verify Admin Role (Database Driven + Dashboard Support)
const verifyAdmin = async (req, res, next) => {
    if (typeof next !== 'function') {
        console.error("❌ Auth Middleware Error: 'next' is not a function in verifyAdmin");
        return res.status(500).json({ success: false, message: "Server Configuration Error" });
    }

    const { userId, isAdmin, role } = req.user || {};
    if (!userId) return res.status(403).json({ success: false, message: "Access Forbidden" });

    // A. Dashboard Token Check (JWT carries isAdmin flag)
    if (isAdmin === true && (role === 'SUPER_ADMIN' || role === 'MANAGER')) {
        return next();
    }

    // B. Mobile App Admin Check (Verified against RTDB)
    try {
        const db = admin.database();
        const snapshot = await db.ref(`users/${userId}/role`).get();

        if (snapshot.exists() && (snapshot.val().toLowerCase() === 'admin')) {
            return next();
        } else {
            console.warn(`🛡️ Unauthorized Admin Attempt: ${userId}`);
            res.status(403).json({ success: false, message: "Access Forbidden: Admin rights required" });
        }
    } catch (error) {
        console.error("❌ Admin Verification Error:", error.message);
        res.status(500).json({ success: false, message: "Server error during authorization" });
    }
};

module.exports = { verifyAppKey, verifyToken, verifyAdmin };
