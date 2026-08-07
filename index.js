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
    .then(() => console.log("✅ Chalo Database Connected (100% Complete)"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// --- MODELS ---

const UserSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "User" },
    role: { type: String, enum: ['Driver', 'Passenger', 'Admin'], default: 'Passenger' },
    walletBalance: { type: Number, default: 50 },
    rating: { type: Number, default: 5.0 },
    isOnline: { type: Boolean, default: false },
    lastLat: Number,
    lastLng: Number,
    driverRegistered: { type: Boolean, default: false },
    driverVerificationStatus: { type: String, default: 'not_submitted' },
    vehicleInfo: Object,
    documents: Object,
    transactions: [{
        title: String, amount: Number, type: String, timestamp: { type: Date, default: Date.now }
    }]
});
const User = mongoose.model('User', UserSchema);

const RideSchema = new mongoose.Schema({
    passengerId: String, passengerName: String,
    pickupLocation: String, destination: String,
    pickupLat: Number, pickupLng: Number,
    fare: Number, status: { type: String, default: 'PENDING' },
    driverId: String, driverName: String,
    timestamp: { type: Date, default: Date.now }
});
const Ride = mongoose.model('Ride', RideSchema);

const CarpoolOfferSchema = new mongoose.Schema({
    driverId: String, driverName: String,
    pickupLocation: String, destination: String,
    pickupLat: Number, pickupLng: Number,
    destLat: Number, destLng: Number,
    price: Number, totalSeats: Number, availableSeats: Number,
    departureTime: String, status: { type: String, default: 'ACTIVE' },
    timestamp: { type: Date, default: Date.now }
});
const CarpoolOffer = mongoose.model('CarpoolOffer', CarpoolOfferSchema);

const ReviewSchema = new mongoose.Schema({
    targetUserId: String, reviewerId: String,
    rating: Number, comment: String, compliments: [String],
    timestamp: { type: Date, default: Date.now }
});
const Review = mongoose.model('Review', ReviewSchema);

const EmergencyAlertSchema = new mongoose.Schema({
    userId: String, userName: String, role: String,
    location: Object, mapLink: String, status: { type: String, default: 'active' },
    timestamp: { type: Date, default: Date.now }
});
const EmergencyAlert = mongoose.model('EmergencyAlert', EmergencyAlertSchema);

// --- ROUTES ---

// 1. Auth & Profile
app.post('/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (otp === "1234") {
        try {
            let user = await User.findOne({ phone });
            if (!user) {
                user = await User.create({ phone, name: "New User", walletBalance: 50 });
                user.transactions.push({ title: "Welcome Bonus", amount: 50, type: "CREDIT" });
                await user.save();
            }
            if (!user.name) user.name = "User"; // Double check name is not null

            const token = jwt.sign({ userId: user._id }, 'CHALO_SECRET');
            res.json({ token, userId: user._id.toString(), user, message: "Success" });
        } catch(e) { res.status(500).send(e.message); }
    } else res.status(400).send("Invalid OTP");
});

app.get('/users/profile/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        user ? res.json(user) : res.status(404).send("User not found");
    } catch(e) { res.status(200).json({ name: "User" }); }
});

app.post('/users/update-profile', async (req, res) => {
    const { userId, name, role } = req.body;
    const user = await User.findByIdAndUpdate(userId, { name, role }, { new: true });
    res.json(user);
});

app.post('/users/register-driver', async (req, res) => {
    const { userId, vehicleInfo, documents } = req.body;
    const user = await User.findByIdAndUpdate(userId, { 
        driverRegistered: true, driverVerificationStatus: 'pending', vehicleInfo, documents 
    }, { new: true });
    res.json({ success: true, user });
});

// NEW: Driver Quick Approval (Testing Only)
app.post('/admin/approve-driver', async (req, res) => {
    const { userId } = req.body;
    try {
        const user = await User.findByIdAndUpdate(userId, { 
            driverVerificationStatus: 'approved',
            role: 'Driver',
            driverRegistered: true
        }, { new: true });
        res.json({ success: true, user });
    } catch(e) { res.status(500).send(e.message); }
});

// 2. Rides & Bidding
app.post('/rides/request', async (req, res) => {
    const ride = await Ride.create(req.body);
    io.emit('new_ride_request', ride);
    res.json(ride);
});

app.post('/rides/bid', (req, res) => {
    io.emit(`new_bid_${req.body.rideId}`, req.body);
    res.json({ success: true });
});

app.post('/rides/update-status', async (req, res) => {
    const ride = await Ride.findByIdAndUpdate(req.body.rideId, { status: req.body.status }, { new: true });
    io.emit('ride_status_updated', { rideId: req.body.rideId, status: req.body.status });
    res.json(ride);
});

// 3. Carpool & Reviews
app.post('/carpool/offer', async (req, res) => {
    const offer = await CarpoolOffer.create(req.body);
    io.emit('new_carpool_offer', offer);
    res.json(offer);
});

app.get('/carpool/offers', async (req, res) => {
    const offers = await CarpoolOffer.find({ status: 'ACTIVE' });
    res.json(offers);
});

app.post('/users/review', async (req, res) => {
    const review = await Review.create(req.body);
    const reviews = await Review.find({ targetUserId: req.body.targetUserId });
    const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    await User.findByIdAndUpdate(req.body.targetUserId, { rating: avg });
    res.json(review);
});

// 4. Wallet & SOS
app.get('/users/transactions/:userId', async (req, res) => {
    const user = await User.findById(req.params.userId);
    res.json(user ? user.transactions : []);
});

app.post('/emergency/sos', async (req, res) => {
    const alert = await EmergencyAlert.create(req.body);
    io.emit('admin_emergency_alert', alert);
    res.json({ success: true });
});

// 5. Chat
app.post('/chat/send', (req, res) => {
    io.emit('receive_message', { ...req.body, id: Date.now().toString(), timestamp: Date.now() });
    res.json({ success: true });
});

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('update_location', async (data) => {
        await User.findByIdAndUpdate(data.userId, { lastLat: data.lat, lastLng: data.lng, isOnline: true });
        io.emit('location_updated', data);
    });
});

app.get('/', (req, res) => res.send("Chalo API is 100% Operational!"));
server.listen(process.env.PORT || 8080, "0.0.0.0", () => console.log("🚀 Server Running"));
