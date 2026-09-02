const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// 1. RATE LIMITING (Scale Optimization: Prevents Bot Abuse & Cost Spikes)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Limit each IP to 200 requests per window
    message: { success: false, message: "Too many requests from this IP, please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiter to all routes
app.use(limiter);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Share IO with routes
app.set('socketio', io);

app.use(cors());
app.use(express.json({
    verify: (req, res, buffer) => {
        req.rawBody = Buffer.from(buffer);
    }
}));
app.use(express.urlencoded({ extended: true }));

// Global Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// Firebase Admin Setup
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://indrive-d69e1-default-rtdb.firebaseio.com"
        });
        console.log("✅ Firebase Admin Initialized");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
}

// Modular Routes & Middleware
const { verifyAppKey, verifyToken, verifyAdmin } = require('./middleware/auth');

// 1. PUBLIC ROUTES
app.use('/auth', require('./routes/auth'));

// 2. GLOBAL APP KEY PROTECTION (Applies to all routes below)
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    verifyAppKey(req, res, next);
});

// 3. PROTECTED ROUTES (Require Token)
app.use('/users', verifyToken, require('./routes/users'));
app.use('/rides', verifyToken, require('./routes/rides'));
app.use('/carpool', verifyToken, require('./routes/carpool'));
app.use('/payments', verifyToken, require('./routes/payments'));
app.use('/emergency', verifyToken, require('./routes/emergency'));
app.use('/maps', verifyToken, require('./routes/maps'));

// 4. ADMIN API
app.use('/admin', verifyToken, verifyAdmin, require('./routes/admin'));

// Sockets Logic
const geohash = require('ngeohash');
io.on('connection', (socket) => {
    socket.on('update_location', async (data) => {
        if (data.userId && data.lat && data.lon) {
            const cleanId = data.userId.replace('+', '').trim();

            // Add Geohash on server side for consistency
            const hash = geohash.encode(data.lat, data.lon, 7);
            const updatedData = { ...data, userId: cleanId, geohash: hash };

            // Broadcast location directly via sockets
            io.emit('location_updated', updatedData);

            // Optional: Update Firebase RTDB for persistence if not already done by app
            try {
                admin.database().ref(`users/${cleanId}`).update({
                    lastLat: data.lat,
                    lastLon: data.lon,
                    geohash: hash,
                    lastSeen: Date.now()
                });
            } catch (e) { /* ignore */ }
        }
    });
    socket.on('disconnect', () => { });
});

app.get('/', (req, res) => res.json({ status: "Online", message: "Chalo API Secured" }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
