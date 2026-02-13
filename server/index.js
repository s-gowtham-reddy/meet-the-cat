const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

let waitingUsers = []; // Array of { socketId, profile, joinedAt }
let pairs = {}; // socket.id -> partner's socket.id
const broadcastUserCount = () => {
    // Using io.sockets.size is often more consistent for connected sockets
    const count = io.of("/").sockets.size;
    io.emit('user_count', count);
};

io.on('connection', (socket) => {
    broadcastUserCount();
    console.log(`User Connected: ${socket.id}. Total: ${io.engine.clientsCount}`);

    socket.on('join_queue', (profile) => {
        if (!profile || !profile.name || !profile.gender) return;

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

    socket.on('send_message', (data) => {
        const partnerId = pairs[socket.id];
        if (partnerId) {
            io.to(partnerId).emit('receive_message', {
                message: data.message,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    });

    socket.on('meow', () => {
        const partnerId = pairs[socket.id];
        if (partnerId) {
            io.to(partnerId).emit('partner_meow');
        }
    });

    socket.on('typing', () => {
        const partnerId = pairs[socket.id];
        if (partnerId) io.to(partnerId).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        const partnerId = pairs[socket.id];
        if (partnerId) io.to(partnerId).emit('partner_stop_typing');
    });

    socket.on('skip_chat', () => {
        unpairUser(socket.id);
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
