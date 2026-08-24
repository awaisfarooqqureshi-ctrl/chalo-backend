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

// Modular Routes
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/rides', require('./routes/rides'));
app.use('/carpool', require('./routes/carpool'));
app.use('/payments', require('./routes/payments'));
app.use('/maps', require('./routes/maps'));
app.use('/emergency', require('./routes/emergency'));

// Sockets Logic (Pure Firebase/Logic, no Mongo)
io.on('connection', (socket) => {
    console.log("New client connected:", socket.id);

    socket.on('update_location', async (data) => {
        if (data.userId) {
            const cleanId = data.userId.replace('+', '').trim();
            // Broadcast location directly via sockets for real-time maps
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
