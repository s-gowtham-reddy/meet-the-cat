const mongoose = require('mongoose');

const sessionLogSchema = new mongoose.Schema({
    type: { type: String, enum: ['random', 'private'], required: true },
    userId: { type: String }, // Optional, helpful for linking but study focused on identity changes
    username: { type: String },
    gender: { type: String }, // Captured per session for "playful" data
    startTime: { type: Date, default: Date.now },
    endTime: { type: Date },
    duration: { type: Number }, // In seconds
    concurrentAtStart: { type: Number, default: 0 }, // Study site density
    roomId: { type: String }, // Only for private rooms
    totalMessages: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('SessionLog', sessionLogSchema);
