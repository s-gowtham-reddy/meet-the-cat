const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();
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

console.log('Production Config:');
console.log('- FRONTEND_URL:', FRONTEND_URL);

let waitingUsers = []; // Array of { socketId, profile, joinedAt }
let pairs = {}; // socket.id -> partner's socket.id
let privateRooms = {}; // roomId -> { roomName, creatorName }

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@';
    let code = '';
    for (let i = 0; i < 7; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
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

    socket.on('join_queue', (profile) => {
        if (!profile || !profile.name || !profile.gender) return;

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

    socket.on('create_room', (data) => {
        const { roomName, profile } = data;
        const roomId = generateRoomCode();
        privateRooms[roomId] = {
            roomName: roomName || 'Private Room',
            creatorName: profile?.name || 'Stranger'
        };
        socket.join(roomId);
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

    socket.on('join_private_room', (data) => {
        const { roomId, profile } = data;
        socket.join(roomId);
        console.log(`User ${profile.name} joined room: ${roomId}`);

        const roomInfo = privateRooms[roomId] || { roomName: 'Private Room', creatorName: 'Stranger' };

        // Let the joiner know they've successfully joined
        socket.emit('room_joined', { roomId, ...roomInfo });

        // Notify others in the room
        socket.to(roomId).emit('partner_joined', {
            partner: { name: profile.name, avatarSeed: profile.avatarSeed },
            isGroup: true
        });

        // For group chat, we can just say "User X joined"
        socket.to(roomId).emit('receive_message', {
            message: `${profile.name} joined the room! 🐾`,
            isSystem: true,
            timestamp: new Date().toISOString()
        });

        broadcastUserCount();
    });

    socket.on('send_partner_info', (data) => {
        const { roomId, profile } = data;
        socket.to(roomId).emit('partner_joined', {
            partner: { name: profile.name, avatarSeed: profile.avatarSeed }
        });
    });

    socket.on('send_message', (data) => {
        const { message, roomId, profile } = data;
        if (roomId) {
            // Private room message - broadcast to EVERYONE else in the room
            socket.to(roomId).emit('receive_message', {
                message: message,
                sender: profile ? { name: profile.name, avatarSeed: profile.avatarSeed } : null,
                timestamp: new Date().toISOString()
            });
        } else {
            // Matched chat message
            const partnerId = pairs[socket.id];
            if (partnerId) {
                io.to(partnerId).emit('receive_message', {
                    message: message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

    socket.on('meow', (data) => {
        const roomId = data?.roomId;
        if (roomId) {
            socket.to(roomId).emit('partner_meow');
        } else {
            const partnerId = pairs[socket.id];
            if (partnerId) {
                io.to(partnerId).emit('partner_meow');
            }
        }
    });

    socket.on('typing', (data) => {
        const roomId = data?.roomId;
        if (roomId) {
            socket.to(roomId).emit('partner_typing');
        } else {
            const partnerId = pairs[socket.id];
            if (partnerId) io.to(partnerId).emit('partner_typing');
        }
    });

    socket.on('stop_typing', (data) => {
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
            if (room !== socket.id) {
                socket.to(room).emit('partner_disconnected');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User Disconnected', socket.id);
        unpairUser(socket.id);
        broadcastUserCount();
    });
});

function unpairUser(socketId) {
    waitingUsers = waitingUsers.filter(u => u.socketId !== socketId);

    const partnerId = pairs[socketId];
    if (partnerId) {
        io.to(partnerId).emit('partner_disconnected');
        delete pairs[partnerId];
        delete pairs[socketId];
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

        // Register Pair
        pairs[user.socketId] = partner.socketId;
        pairs[partner.socketId] = user.socketId;

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
