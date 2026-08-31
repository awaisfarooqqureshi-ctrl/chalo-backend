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

// Global Request Logger for Debugging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Firebase Admin Setup (PRIMARY DATABASE)
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://indrive-d69e1-default-rtdb.firebaseio.com"
        });
        console.log("✅ Firebase Admin Initialized - All data on RTDB");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
}

// Modular Routes & Middleware
const { verifyAppKey, verifyToken, verifyAdmin } = require('./middleware/auth');
const adminRoutes = require('./routes/admin');

// 1. PUBLIC ROUTES (No Security Check)
app.use('/auth', require('./routes/auth'));

// 2. SEMI-PUBLIC ADMIN ROUTES (Bypass JWT for Browser Access)
app.get('/admin/test-seed', adminRoutes);
app.get('/admin/test-clean', adminRoutes);
app.get('/admin/bonuses/seed', adminRoutes);

// 3. GLOBAL APP KEY PROTECTION (Applies to all routes below)
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    verifyAppKey(req, res, next);
});

// 4. PROTECTED ROUTES (Require JWT Token)
app.use('/users', verifyToken, require('./routes/users'));
app.use('/rides', verifyToken, require('./routes/rides'));
app.use('/carpool', verifyToken, require('./routes/carpool'));
app.use('/payments', verifyToken, require('./routes/payments'));
app.use('/emergency', verifyToken, require('./routes/emergency'));
app.use('/maps', require('./routes/maps'));

// 5. SECURE ADMIN API (Remaining admin endpoints)
app.use('/admin', verifyToken, verifyAdmin, adminRoutes);

// Sockets Logic
io.on('connection', (socket) => {
    console.log("New client connected:", socket.id);
    socket.on('update_location', async (data) => {
        if (data.userId) {
            const cleanId = data.userId.replace('+', '').trim();
            io.emit('location_updated', { ...data, userId: cleanId });
        }
    });
    socket.on('disconnect', () => {
        console.log("Client disconnected:", socket.id);
    });
});

app.get('/', (req, res) => res.json({ status: "Online", message: "Chalo Modular API v1.1" }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Chalo Server running on port ${PORT}`);
});
