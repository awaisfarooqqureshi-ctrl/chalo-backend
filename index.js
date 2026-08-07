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
    name: { type: String, default: "User" },
    role: { type: String, default: 'Passenger' },
    walletBalance: { type: Number, default: 50 },
    welcomeBonusApplied: { type: Boolean, default: true },
    transactions: []
});
const User = mongoose.model('User', UserSchema);

// --- AUTH ROUTES ---

app.post('/auth/send-otp', async (req, res) => {
    console.log("OTP Request for:", req.body.phone);
    res.json({ message: "OTP sent (Use 1234)" });
});

app.post('/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    console.log(`Verifying: ${phone} with code: ${otp}`);

    if (otp === "1234") {
        try {
            let user = await User.findOne({ phone });
            if (!user) {
                user = await User.create({ phone, name: "New User" });
            }

            const token = jwt.sign({ userId: user._id }, 'CHALO_SECRET');
            
            // IMPORTANT: Sending the exact structure Android expects
            res.json({
                token: token,
                userId: user._id.toString(),
                user: user,
                message: "Success"
            });
        } catch (err) {
            res.status(500).json({ message: "Server Database Error" });
        }
    } else {
        res.status(400).json({ message: "Invalid OTP Code" });
    }
});

app.get('/users/profile/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        res.json(user || {});
    } catch (err) { res.status(200).json({}); }
});

app.get('/', (req, res) => res.send("Chalo API is Ready"));

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 API on ${PORT}`));
