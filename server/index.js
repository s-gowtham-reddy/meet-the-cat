const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const geoip = require('geoip-lite');
const requestIp = require('request-ip');
require('dotenv').config();

const SessionLog = require('./models/SessionLog');
const UniqueVisitor = require('./models/UniqueVisitor');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();

// Trust proxy for correct IP when behind reverse proxy (e.g. production)
app.set('trust proxy', 1);

// HTTPS redirect in production (when behind a proxy that sets x-forwarded-proto)
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        const proto = req.get('x-forwarded-proto');
        if (proto === 'http') {
            return res.redirect(301, `https://${req.get('host')}${req.url}`);
        }
        next();
    });
}

// HTTP rate limiting: 100 requests per 15 minutes per IP
const httpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests; please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(httpLimiter);

// More permissive CORS for easier debugging during initial deployment
app.use(cors({
    origin: [FRONTEND_URL, 'https://meet-the-cat.vercel.app'],
    credentials: true,
    methods: ['GET', 'POST'],
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: [FRONTEND_URL, 'https://meet-the-cat.vercel.app'],
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// MongoDB Connection (optional: app works without DB for chat; analytics are skipped if disconnected)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/meetthecat';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB 🐾'))
    .catch(err => {
        console.error('MongoDB connection error (analytics disabled):', err.message);
    });

function isDbConnected() {
    return mongoose.connection.readyState === 1;
}

console.log('Production Config:');
console.log('- FRONTEND_URL:', FRONTEND_URL);

let waitingUsers = []; // Array of { socketId, profile, joinedAt }
let pairs = {}; // socket.id -> partner's socket.id
let privateRooms = {}; // roomId -> { roomName, creatorName }
let activeSessions = {}; // socketId -> { startTime, gender, username, type, roomId, location }
let usedCodes = new Map(); // roomId -> expiry timestamp

// Socket event rate limits: max events per minute per socket
const SOCKET_RATE_LIMITS = {
    send_message: 60,
    join_queue: 10,
    create_room: 10,
    join_private_room: 15,
    typing: 120,
    stop_typing: 120
};
const socketRateCounts = new Map(); // key: `${socketId}:${eventName}` -> { count, resetAt }

function checkSocketRateLimit(socketId, eventName) {
    const limit = SOCKET_RATE_LIMITS[eventName];
    if (!limit) return true;
    const key = `${socketId}:${eventName}`;
    const now = Date.now();
    const windowMs = 60 * 1000;
    let entry = socketRateCounts.get(key);
    if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs };
        socketRateCounts.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit) return false;
    return true;
}

function cleanupSocketRateLimits(socketId) {
    for (const key of socketRateCounts.keys()) {
        if (key.startsWith(`${socketId}:`)) socketRateCounts.delete(key);
    }
}

const MAX_MESSAGE_LENGTH = 2000;

function sanitizeMessage(input) {
    if (input == null || typeof input !== 'string') return '';
    let s = input.trim();
    s = s.replace(/<[^>]*>/g, ''); // Strip HTML tags
    s = s.replace(/\s+/g, ' '); // Normalize whitespace to single space
    if (s.length > MAX_MESSAGE_LENGTH) s = s.slice(0, MAX_MESSAGE_LENGTH);
    return s.trim();
}

function generateRoomCode() {
    const mainChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const specChars = '@#&*';
    let code = '';

    // Ensure at least 2 special characters
    for (let i = 0; i < 2; i++) {
        code += specChars.charAt(Math.floor(Math.random() * specChars.length));
    }

    // Fill the rest to 8 characters
    for (let i = 0; i < 6; i++) {
        code += mainChars.charAt(Math.floor(Math.random() * mainChars.length));
    }

    // Shuffle the code
    code = code.split('').sort(() => 0.5 - Math.random()).join('');

    // Check for 24h uniqueness
    const now = Date.now();
    if (usedCodes.has(code) && usedCodes.get(code) > now) {
        return generateRoomCode(); // Collision - try again
    }

    // Mark as used for 24 hours
    usedCodes.set(code, now + 24 * 60 * 60 * 1000);

    // Cleanup old codes periodically
    if (usedCodes.size > 1000) {
        for (const [key, expiry] of usedCodes) {
            if (expiry < now) usedCodes.delete(key);
        }
    }

    return code;
}

function getLocation(socket) {
    const clientIp = requestIp.getClientIp(socket.request);
    // Handle local development (localhost)
    if (clientIp === '::1' || clientIp === '127.0.0.1' || !clientIp) {
        return 'Local Chat';
    }
    const geo = geoip.lookup(clientIp);
    if (geo) {
        return `${geo.city || 'Unknown City'}, ${geo.country}`;
    }
    return 'Unknown Cat-land';
}

const broadcastUserCount = () => {
    const allSockets = Array.from(io.of("/").sockets.values());
    const totalCount = allSockets.length;

    // Calculate how many users are in ANY private room
    let roomUsersCount = 0;
    const roomCounts = {};

    Object.keys(privateRooms).forEach(roomId => {
        const room = io.sockets.adapter.rooms.get(roomId);
        const count = room ? room.size : 0;
        roomCounts[roomId] = count;
        roomUsersCount += count;
        // Emit specific count to each room
        io.to(roomId).emit('room_count', count);
    });

    const lobbyCount = Math.max(0, totalCount - roomUsersCount);

    // Broadcast lobby count to everyone (lobby users will use this)
    io.emit('lobby_count', lobbyCount);

    // Also emit old-style user_count for backward compatibility if needed, 
    // but we'll transition the client to lobby_count.
    io.emit('user_count', totalCount);
};

io.on('connection', (socket) => {
    broadcastUserCount();
    console.log(`User Connected: ${socket.id}. Total: ${io.engine.clientsCount}`);

    socket.on('register_cat', async (data) => {
        const { userId } = data;
        if (!userId) return;
        if (!isDbConnected()) return;
        try {
            const exists = await UniqueVisitor.findOne({ userId });
            if (!exists) {
                const location = getLocation(socket);
                await UniqueVisitor.create({
                    userId,
                    location
                });
                console.log(`New Cat Registered: ${userId} from ${location} 🐾`);
            }
        } catch (err) {
            console.error('Error registering cat:', err);
        }
    });

    socket.on('join_queue', (profile) => {
        if (!profile || !profile.name || !profile.gender) return;
        if (!checkSocketRateLimit(socket.id, 'join_queue')) return;

        // Ensure user is not in a private room
        socket.leaveAll();
        socket.join(socket.id); // rejoin personal room

        // Check if already in queue
        const existingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
        if (existingIndex !== -1) {
            waitingUsers[existingIndex].profile = profile;
        } else {
            waitingUsers.push({
                socketId: socket.id,
                profile: profile,
                joinedAt: Date.now()
            });
        }

        console.log(`${profile.name} joined queue`);
        tryMatch(socket.id);
    });

    socket.on('create_room', async (data) => {
        const { roomName, profile } = data;
        if (!checkSocketRateLimit(socket.id, 'create_room')) return;
        const roomId = generateRoomCode();
        privateRooms[roomId] = {
            roomName,
            creatorName: profile?.name || 'Stranger'
        };
        socket.join(roomId);

        // Start session log for creator
        activeSessions[socket.id] = {
            type: 'private',
            startTime: Date.now(),
            gender: profile?.gender,
            username: profile?.name,
            roomId: roomId,
            concurrentAtStart: io.engine.clientsCount,
            location: getLocation(socket)
        };

        socket.emit('room_created', { roomId, roomName: privateRooms[roomId].roomName });
        console.log(`Room created: ${roomId} by ${profile?.name}`);
        broadcastUserCount();
    });

    socket.on('get_room_info', (data) => {
        const { roomId } = data;
        const roomInfo = privateRooms[roomId];
        if (roomInfo) {
            socket.emit('room_info_preview', { roomId, ...roomInfo });
        }
    });

    socket.on('join_private_room', async (data) => {
        const { roomId, profile } = data;
        if (!checkSocketRateLimit(socket.id, 'join_private_room')) {
            socket.emit('room_error', { message: 'Too many join attempts. Please wait a moment. 🐾' });
            return;
        }
        if (!privateRooms[roomId]) {
            socket.emit('room_error', { message: 'This room code is invalid or has expired. 🐾🚫' });
            return;
        }

        // Before joining, ask existing members to identify themselves to the new joiner
        socket.to(roomId).emit('request_partner_info');

        socket.join(roomId);
        console.log(`User ${profile.name} joined room: ${roomId}`);

        const roomInfo = privateRooms[roomId] || { roomName: 'Private Room', creatorName: 'Stranger' };

        // Let the joiner know they've successfully joined
        socket.emit('room_joined', { roomId, ...roomInfo });

        // Start session log for joiner
        activeSessions[socket.id] = {
            type: 'private',
            startTime: Date.now(),
            gender: profile?.gender,
            username: profile?.name,
            roomId: roomId,
            concurrentAtStart: io.engine.clientsCount,
            location: getLocation(socket)
        };

        // Notify others in the room
        socket.to(roomId).emit('partner_joined', {
            partner: { name: profile.name, avatarSeed: profile.avatarSeed },
            isGroup: true
        });

        // Notify others in the room
        socket.to(roomId).emit('receive_message', {
            message: `${profile.name} joined the room! 🐾`,
            isSystem: true,
            timestamp: new Date().toISOString()
        });

        // Tell the joiner they've arrived
        socket.emit('receive_message', {
            message: `Welcome to ${roomInfo.roomName}! 🐾`,
            isSystem: true,
            timestamp: new Date().toISOString()
        });

        broadcastUserCount();
    });

    socket.on('send_partner_info', (data) => {
        const { roomId, profile } = data;
        // Send to everyone in room so the new joiner gets it
        io.to(roomId).emit('partner_joined', {
            partner: { name: profile.name, avatarSeed: profile.avatarSeed }
        });
    });

    socket.on('send_message', async (data) => {
        const { message, roomId, profile, messageId } = data;
        if (!checkSocketRateLimit(socket.id, 'send_message')) return;
        const sanitized = sanitizeMessage(message);
        if (!sanitized) return;
        if (roomId) {
            const msgData = {
                message: sanitized,
                sender: profile ? { name: profile.name, avatarSeed: profile.avatarSeed } : null,
                userId: profile?.userId,
                timestamp: new Date().toISOString(),
                replyTo: data.replyTo,
                messageId: messageId || null,
                senderSocketId: socket.id
            };
            socket.to(roomId).emit('receive_message', msgData);
        } else {
            const partnerId = pairs[socket.id];
            if (partnerId) {
                const msgData = {
                    message: sanitized,
                    userId: profile?.userId,
                    timestamp: new Date().toISOString(),
                    replyTo: data.replyTo,
                    messageId: messageId || null,
                    senderSocketId: socket.id
                };
                io.to(partnerId).emit('receive_message', msgData);
            }
        }
    });

    socket.on('message_delivered', (data) => {
        const { messageId, senderSocketId } = data;
        if (messageId && senderSocketId) {
            io.to(senderSocketId).emit('message_delivered', { messageId });
        }
    });


    socket.on('typing', (data) => {
        if (!checkSocketRateLimit(socket.id, 'typing')) return;
        const roomId = data?.roomId;
        if (roomId) {
            socket.to(roomId).emit('partner_typing');
        } else {
            const partnerId = pairs[socket.id];
            if (partnerId) io.to(partnerId).emit('partner_typing');
        }
    });

    socket.on('stop_typing', (data) => {
        if (!checkSocketRateLimit(socket.id, 'stop_typing')) return;
        const roomId = data?.roomId;
        if (roomId) {
            socket.to(roomId).emit('partner_stop_typing');
        } else {
            const partnerId = pairs[socket.id];
            if (partnerId) io.to(partnerId).emit('partner_stop_typing');
        }
    });

    socket.on('skip_chat', () => {
        unpairUser(socket.id);
    });

    socket.on('disconnecting', () => {
        // Handle private room disconnection
        for (const room of socket.rooms) {
            if (room !== socket.id && privateRooms[room]) {
                const profile = activeSessions[socket.id];
                const name = profile?.username || 'A Cat';

                // Notify others in the room
                socket.to(room).emit('receive_message', {
                    message: `${name} has exited. 🐾👋`,
                    isSystem: true,
                    timestamp: new Date().toISOString()
                });

                // Check if last user is leaving
                const roomObj = io.sockets.adapter.rooms.get(room);
                if (roomObj && roomObj.size <= 1) {
                    console.log(`Room Empty: ${room}. Deleting.`);
                    delete privateRooms[room];
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User Disconnected', socket.id);
        cleanupSocketRateLimits(socket.id);
        unpairUser(socket.id);
        broadcastUserCount();
    });
});

function unpairUser(socketId) {
    waitingUsers = waitingUsers.filter(u => u.socketId !== socketId);

    const partnerId = pairs[socketId];
    if (partnerId) {
        const myName = activeSessions[socketId]?.username || 'A Cat';
        // Emit to partner first so they see "disconnected" immediately (before any async work)
        io.to(partnerId).emit('receive_message', {
            message: `${myName} has exited. 🐾👋`,
            isSystem: true,
            timestamp: new Date().toISOString()
        });
        io.to(partnerId).emit('partner_disconnected');
        delete pairs[partnerId];
        delete pairs[socketId];
        // Save session logs after partner is notified
        saveSession(socketId);
        saveSession(partnerId);
    } else {
        // If it was a private room, just save the individual session
        saveSession(socketId);
    }
}

async function saveSession(socketId) {
    const session = activeSessions[socketId];
    if (session) {
        if (!isDbConnected()) {
            delete activeSessions[socketId];
            return;
        }
        const duration = Math.floor((Date.now() - session.startTime) / 1000);
        try {
            await SessionLog.create({
                type: session.type,
                userId: socketId,
                username: session.username,
                gender: session.gender,
                startTime: new Date(session.startTime),
                endTime: new Date(),
                duration: duration,
                concurrentAtStart: session.concurrentAtStart || 0,
                roomId: session.roomId
            });
            console.log(`Analytics: ${session.type} session saved for ${session.username} (${duration}s)`);
        } catch (err) {
            console.error('Error saving session log:', err);
        }
        delete activeSessions[socketId];
    }
}

function tryMatch(socketId) {
    const user = waitingUsers.find(u => u.socketId === socketId);
    if (!user) return;

    // Match with the first available person who isn't self
    const partner = waitingUsers.find(u => u.socketId !== socketId);

    if (partner) {
        // Remove both from queue
        waitingUsers = waitingUsers.filter(u => u.socketId !== user.socketId && u.socketId !== partner.socketId);

        pairs[user.socketId] = partner.socketId;
        pairs[partner.socketId] = user.socketId;

        // Log the start of a random session
        const startTime = Date.now();
        const concurrent = io.engine.clientsCount;
        activeSessions[user.socketId] = {
            type: 'random',
            startTime: startTime,
            gender: user.profile.gender,
            username: user.profile.name,
            concurrentAtStart: concurrent
        };
        activeSessions[partner.socketId] = {
            type: 'random',
            startTime: startTime,
            gender: partner.profile.gender,
            username: partner.profile.name,
            concurrentAtStart: concurrent
        };

        console.log(`Matched ${user.profile.name} with ${partner.profile.name}`);

        // Emit chat_start
        io.to(user.socketId).emit('chat_start', {
            partner: { name: partner.profile.name, avatarSeed: partner.profile.avatarSeed }
        });
        io.to(partner.socketId).emit('chat_start', {
            partner: { name: user.profile.name, avatarSeed: user.profile.avatarSeed }
        });
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`SERVER RUNNING ON PORT ${PORT}`));
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other process or set PORT in .env`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
