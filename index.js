const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
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

// 2. SEMI-PUBLIC ADMIN ROUTES (Bypass Global App Key for Browser)
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const url = req.originalUrl || req.url;
    if (url.includes('/admin/test-') || url.includes('/admin/bonuses/seed') || url.includes('/admin/unblock/')) {
        return next();
    }
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
io.on('connection', (socket) => {
    socket.on('update_location', async (data) => {
        if (data.userId) {
            const cleanId = data.userId.replace('+', '').trim();
            io.emit('location_updated', { ...data, userId: cleanId });
        }
    });
    socket.on('disconnect', () => { });
});

app.get('/', (req, res) => res.json({ status: "Online", message: "Chalo API Secured" }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
