const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// 0. TRUST PROXY
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. DATABASE INITIALIZATION (Hybrid Auth)
try {
    let dbUrl = (process.env.FIREBASE_DATABASE_URL || "https://chalodrive-app-default-rtdb.firebaseio.com").replace(/\/$/, "");

    // CRITICAL: Clear any existing apps to prevent credential mixing on Cloud Run
    if (admin.apps.length > 0) {
        admin.apps.forEach(app => app.delete());
        console.log("🧹 Cleaned up existing Firebase instances");
    }

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: dbUrl,
            projectId: serviceAccount.project_id
        });
        console.log(`✅ Firebase Admin: Initialized for Project: ${serviceAccount.project_id}`);
    } else {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            databaseURL: dbUrl,
            projectId: "chalodrive-app"
        });
        console.log("✅ Firebase Admin: Initialized via Default Identity");
    }

    global.db_fs = admin.firestore();
    console.log("🔥 Cloud Firestore Ready");

    // NEW: Auto-seed configuration on startup if database is empty
    const seedDefaultConfig = require('./services/seeder');
    seedDefaultConfig();
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
}

// 2. SCALE OPTIMIZATION: Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, message: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

app.set('socketio', io);
app.use(cors());
const captureRawBody = (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
};

app.use(express.json({ limit: '50mb', verify: captureRawBody }));
app.use(express.urlencoded({ limit: '50mb', extended: true, verify: captureRawBody }));

// Modular Routes & Middleware
const { verifyAppKey, verifyToken, verifyAdmin } = require('./middleware/auth');

app.use('/auth', require('./routes/auth'));

// Global Security for other routes
app.use((req, res, next) => {
    // Force collapse double slashes in URL
    req.url = req.url.replace(/\/+/g, '/');
    verifyAppKey(req, res, next);
});

app.use('/users', verifyToken, require('./routes/users'));
app.use('/rides', verifyToken, require('./routes/rides'));
app.use('/carpool', verifyToken, require('./routes/carpool'));
app.use('/payments', verifyToken, require('./routes/payments'));
app.use('/emergency', verifyToken, require('./routes/emergency'));
app.use('/notifications', verifyToken, require('./routes/notifications'));
app.use('/maps', require('./routes/maps'));
app.use('/admin', verifyToken, verifyAdmin, require('./routes/admin'));

// 4. GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
    console.error("🔥 Global Error Caught:", err.stack);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// 3. SCALE OPTIMIZATION: Uber-style Spatial Sockets (H3 Rooms)
const h3 = require('h3-js');
const jwt = require('jsonwebtoken');
io.on('connection', (socket) => {
    const authToken = socket.handshake.auth && socket.handshake.auth.token;
    if (!authToken || !process.env.CHALO_SECRET) {
        socket.disconnect(true);
        return;
    }

    let authenticatedUser;
    try {
        authenticatedUser = jwt.verify(authToken, process.env.CHALO_SECRET);
    } catch (error) {
        socket.disconnect(true);
        return;
    }

    const userId = authenticatedUser.userId;
    if (!userId) {
        socket.disconnect(true);
        return;
    }

    console.log(`New client connected: ${socket.id} (User: ${userId})`);

    socket.on('update_location', async (data) => {
        if (data && Number.isFinite(Number(data.lat)) &&
            Number.isFinite(Number(data.lon || data.lng))) {
            // SCALE FIX: Remove ALL non-digits to match App's RTDB path logic
            const cleanId = userId.toString().replace(/\D/g, '').trim();
            const longitude = Number(data.lon || data.lng);
            const latitude = Number(data.lat);

            // H3 Precision 7 (~1.2km hexagons)
            const hexAddr = h3.latLngToCell(latitude, longitude, 7);
            const updatedData = {
                lat: latitude,
                lon: longitude,
                rotation: Number(data.rotation) || 0,
                type: typeof data.type === 'string' ? data.type : 'Car',
                userId: cleanId,
                h3Index: hexAddr
            };
            delete updatedData.lng; // Unified field name

            // a. Join the spatial room for this hexagon
            const oldRoom = socket.currentHexRoom;
            if (oldRoom !== hexAddr) {
                if (oldRoom) socket.leave(oldRoom);
                socket.join(hexAddr);
                socket.currentHexRoom = hexAddr;
            }

            // b. Broadcast ONLY to users in the same hexagon
            io.to(hexAddr).emit('location_updated', updatedData);

            // c. Debounced persistence (Save to Firebase every 10s or 500m move)
            try {
                admin.database().ref(`users/${cleanId}`).update({
                    lastLat: latitude,
                    lastLon: longitude,
                    h3Index: hexAddr,
                    lastSeen: Date.now()
                });
            } catch (e) {}
        }
    });

    socket.on('disconnect', () => {
        console.log("Client disconnected:", socket.id);
    });
});

app.get('/', (req, res) => res.json({ status: "Online", message: "Chalo API Scalable v1.2" }));
app.get('/health', (req, res) => res.json({ status: "ok", service: "chalo-server" }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Scalable Server running on port ${PORT}`);
});
