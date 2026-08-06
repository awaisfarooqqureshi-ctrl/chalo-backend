const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const jwt = require('jsonwebtoken'); // Install this: npm install jsonwebtoken
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// --- USER MODEL ---
const UserSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: String,
    role: { type: String, default: 'Passenger' },
    walletBalance: { type: Number, default: 0 },
    welcomeBonusApplied: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

// --- AUTH ROUTES ---

// 1. Send OTP (Currently Simulation)
app.post('/auth/send-otp', async (req, res) => {
    const { phone } = req.body;
    console.log(`Sending OTP to ${phone}`);
    // Shuruat me hum SMS nahi bhej rahe, sirf success return kar rahe hain
    // User 1234 enter karega toh login ho jaye ga
    res.json({ message: "OTP sent successfully (Use 1234 for testing)" });
});

// 2. Verify OTP
app.post('/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;

    if (otp === "1234") { // Testing OTP
        let user = await User.findOne({ phone });
        if (!user) {
            user = new User({ phone });
            await user.save();
        }

        // Generate JWT Token
        const token = jwt.sign({ userId: user._id, phone: user.phone }, 'YOUR_SECRET_KEY', { expiresIn: '30d' });
        
        res.json({
            token,
            userId: user._id,
            message: "Login successful"
        });
    } else {
        res.status(400).json({ message: "Invalid OTP" });
    }
});

app.get('/', (req, res) => {
    res.send("Chalo API is Running Live with Auth!");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
