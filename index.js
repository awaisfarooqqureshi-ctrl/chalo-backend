const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// --- MODELS ---

const UserSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ['Driver', 'Passenger', 'Admin'], default: 'Passenger' },
    walletBalance: { type: Number, default: 0 },
    rating: { type: Number, default: 5.0 },
    isOnline: { type: Boolean, default: false },
    lastLat: Number,
    lastLng: Number
});
const User = mongoose.model('User', UserSchema);

const RideSchema = new mongoose.Schema({
    passengerId: String,
    passengerName: String,
    pickupLocation: String,
    destination: String,
    pickupLat: Number,
    pickupLng: Number,
    destLat: Number,
    destLng: Number,
    fare: Number,
    status: { type: String, default: 'PENDING' }, // PENDING, ACCEPTED, ON_TRIP, COMPLETED
    driverId: String,
    driverName: String,
    timestamp: { type: Date, default: Date.now }
});
const Ride = mongoose.model('Ride', RideSchema);

// --- ROUTES ---

// 1. Auth & Profile
app.post('/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (otp === "1234") {
        let user = await User.findOne({ phone });
        if (!user) user = await User.create({ phone });
        const token = jwt.sign({ userId: user._id }, 'CHALO_SECRET', { expiresIn: '30d' });
        res.json({ token, userId: user._id, user });
    } else res.status(400).send("Invalid OTP");
});

app.post('/users/update-profile', async (req, res) => {
    const { userId, name, role } = req.body;
    const user = await User.findByIdAndUpdate(userId, { name, role }, { new: true });
    res.json(user);
});

// 2. Rides
app.post('/rides/request', async (req, res) => {
    const ride = await Ride.create(req.body);
    io.emit('new_ride_request', ride); // Broadcast to all drivers
    res.json(ride);
});

// --- REAL-TIME (SOCKET.IO) ---
io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

    // Live Tracking
    socket.on('update_location', async (data) => {
        const { userId, lat, lng } = data;
        await User.findByIdAndUpdate(userId, { lastLat: lat, lastLng: lng });
        io.emit('location_updated', data); // Inform other users
    });

    socket.on('disconnect', () => console.log('User Disconnected'));
});

// Driver Sends a Bid
app.post('/rides/bid', async (req, res) => {
    const { rideId, driverId, bidFare, driverName } = req.body;
    console.log(`Bid received for ${rideId} from ${driverName}: Rs.${bidFare}`);
    
    // Notify the passenger specifically via Socket
    io.emit('new_bid_' + rideId, req.body); 
    
    res.json({ success: true, message: "Bid submitted" });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on ${PORT}`));
