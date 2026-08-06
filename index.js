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
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- MODELS ---

const UserSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ['Driver', 'Passenger', 'Admin'], default: 'Passenger' },
    walletBalance: { type: Number, default: 0 },
    rating: { type: Number, default: 5.0 },
    isOnline: { type: Boolean, default: false },
    lastLat: Number,
    lastLng: Number,
    welcomeBonusApplied: { type: Boolean, default: false },
    transactions: [{
        title: String,
        amount: Number,
        type: String, // CREDIT, DEBIT
        timestamp: { type: Date, default: Date.now }
    }]
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
    status: { type: String, default: 'PENDING' },
    driverId: String,
    driverName: String,
    timestamp: { type: Date, default: Date.now }
});
const Ride = mongoose.model('Ride', RideSchema);

const EmergencyAlertSchema = new mongoose.Schema({
    userId: String,
    userName: String,
    role: String,
    location: { lat: Number, lng: Number },
    mapLink: String,
    rideId: String,
    timestamp: { type: Date, default: Date.now },
    status: { type: String, default: 'active' }
});
const EmergencyAlert = mongoose.model('EmergencyAlert', EmergencyAlertSchema);

// --- ROUTES ---

// 1. Auth & Profile
app.post('/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (otp === "1234") {
        let user = await User.findOne({ phone });
        if (!user) {
            user = await User.create({ phone });
            // Apply Welcome Bonus (Rs. 50)
            user.walletBalance = 50;
            user.welcomeBonusApplied = true;
            user.transactions.push({ title: "Welcome Bonus", amount: 50, type: "CREDIT" });
            await user.save();
        }
        const token = jwt.sign({ userId: user._id }, 'CHALO_SECRET', { expiresIn: '30d' });
        res.json({ token, userId: user._id, user });
    } else res.status(400).send("Invalid OTP");
});

// GET PROFILE (This was missing and stopping the map!)
app.get('/users/profile/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        user ? res.json(user) : res.status(404).send("User not found");
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/users/update-profile', async (req, res) => {
    const { userId, name, role } = req.body;
    const user = await User.findByIdAndUpdate(userId, { name, role }, { new: true });
    res.json(user);
});

// 2. Rides & Bidding
app.post('/rides/request', async (req, res) => {
    const ride = await Ride.create(req.body);
    io.emit('new_ride_request', ride);
    res.json(ride);
});

app.post('/rides/bid', async (req, res) => {
    const { rideId, driverId, bidFare, driverName } = req.body;
    io.emit(`new_bid_${rideId}`, req.body); 
    res.json({ success: true });
});

app.post('/rides/update-status', async (req, res) => {
    const { rideId, status } = req.body;
    const ride = await Ride.findByIdAndUpdate(rideId, { status }, { new: true });
    io.emit('ride_status_updated', { rideId, status });
    res.json(ride);
});

// 3. SOS (Emergency)
app.post('/emergency/sos', async (req, res) => {
    const alert = await EmergencyAlert.create(req.body);
    io.emit('admin_emergency_alert', alert); // For Admin Panel
    res.json({ success: true, alertId: alert._id });
});

// 4. Chat
app.post('/chat/send', async (req, res) => {
    const msg = { ...req.body, id: Date.now().toString(), timestamp: Date.now() };
    io.emit('receive_message', msg);
    res.json(msg);
});

// --- REAL-TIME (SOCKET.IO) ---
io.on('connection', (socket) => {
    socket.on('update_location', async (data) => {
        const { userId, lat, lng } = data;
        await User.findByIdAndUpdate(userId, { lastLat: lat, lastLng: lng, isOnline: true });
        io.emit('location_updated', data);
    });

    socket.on('disconnect', () => console.log('User Disconnected'));
});

app.get('/', (req, res) => res.send("Chalo Full Backend is Live!"));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Final Server on ${PORT}`));
