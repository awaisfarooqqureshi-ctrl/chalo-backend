const express = require('express');
const mongoose = require('mongoose');
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

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Chalo DB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Firebase Admin Setup
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized");
    }
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
}

// Modular Routes
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/rides', require('./routes/rides'));
app.use('/carpool', require('./routes/carpool'));
app.use('/payments', require('./routes/payments'));
app.use('/emergency', require('./routes/emergency'));

// Sockets Logic
const User = require('./models/User');
io.on('connection', (socket) => {
    console.log("New client connected:", socket.id);

    socket.on('update_location', async (data) => {
        if (data.userId) {
            const cleanId = data.userId.replace('+', '').trim();
            try {
                await User.findByIdAndUpdate(cleanId, {
                    lastLat: data.lat,
                    lastLng: data.lng,
                    isOnline: true
                });
                io.emit('location_updated', { ...data, userId: cleanId });
            } catch (e) {
                console.error("Socket location update error:", e.message);
            }
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
