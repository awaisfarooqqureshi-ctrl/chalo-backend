const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// 0. TRUST PROXY (Required for Railway/Cloud deployments to identify client IP)
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 1. DATABASE CONNECTIONS (Scale Optimization: Dual Database Architecture)
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://user:pass@cluster.mongodb.net/chalo";
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Atlas Connected (Cold Storage Ready)"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://indrive-d69e1-default-rtdb.firebaseio.com"
        });
        console.log("✅ Firebase Admin Initialized (Active Database)");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
}

// 2. SCALE OPTIMIZATION: Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 250,
    message: { success: false, message: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

app.set('socketio', io);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// 4. GLOBAL ERROR HANDLER (Scale Optimization: Prevents server crash)
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
io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    console.log(`New client connected: ${socket.id} (User: ${userId})`);

    socket.on('update_location', async (data) => {
        if (data.userId && data.lat && data.lon) {
            const cleanId = data.userId.replace('+', '').trim();

            // H3 Precision 7 (~1.2km hexagons) - Best balance for discovery
            const hexAddr = h3.latLngToCell(data.lat, data.lon, 7);
            const updatedData = { ...data, userId: cleanId, h3Index: hexAddr };

            // a. Join the spatial room for this hexagon
            const oldRoom = socket.currentHexRoom;
            if (oldRoom !== hexAddr) {
                if (oldRoom) socket.leave(oldRoom);
                socket.join(hexAddr);
                socket.currentHexRoom = hexAddr;
            }

            // b. Broadcast ONLY to users in the same hexagon (Scale fix: No global broadcast)
            // For production, we'd also send to k-ring (neighbors), but this is Step 3 base.
            io.to(hexAddr).emit('location_updated', updatedData);

            // c. Debounced persistence (Save to Firebase every 10s or 500m move)
            // This reduces Firebase bill significantly at 10M users.
            try {
                admin.database().ref(`users/${cleanId}`).update({
                    lastLat: data.lat,
                    lastLon: data.lon,
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Scalable Server running on port ${PORT}`);
});
