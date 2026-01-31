const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the web client

// Store player state: { x, y, z, dimension, mute, channel }
const players = {};
// Map playerName -> socketId for direct communication
const playerSockets = {};

// Distance -> Volume configuration
const getVolume = (distance) => {
    if (distance <= 5) return 1.0;
    if (distance <= 10) return 0.6;
    if (distance <= 20) return 0.3;
    return 0.0;
};

const calculateDistance = (p1, p2) => {
    if (!p1 || !p2 || p1.dimension !== p2.dimension) return Infinity;
    return Math.sqrt(
        Math.pow(p1.x - p2.x, 2) +
        Math.pow(p1.y - p2.y, 2) +
        Math.pow(p1.z - p2.z, 2)
    );
};

// Handle player updates from Minecraft Addon
app.post('/api/player-update', (req, res) => {
    const { player, x, y, z, dimension, mute, channel, mutedPlayers } = req.body;

    if (!player) return res.status(400).send('Missing player name');

    players[player] = {
        x: parseFloat(x),
        y: parseFloat(y),
        z: parseFloat(z),
        dimension,
        mute: !!mute,
        channel: channel || 'global',
        mutedPlayers: mutedPlayers || [],
        lastUpdate: Date.now()
    };

    // Prepare response with speaking players
    const speakingPlayers = [];
    const now = Date.now();
    for (const pName in players) {
        if (pName !== player && players[pName].isSpeaking && (now - players[pName].lastUpdate < 5000)) {
            speakingPlayers.push(pName);
        }
    }

    res.json({ speaking: speakingPlayers });
});

let serverMute = false;

app.post('/api/admin/mute-all', (req, res) => {
    const { mute } = req.body;
    serverMute = mute;
    console.log(`Global Server Mute set to: ${serverMute}`);
    // Broadcast state to all clients immediately
    io.emit('server-mute-update', serverMute);
    res.json({ success: true, serverMute });
});

// Broadcast volume updates periodically
setInterval(() => {
    const now = Date.now();
    const activePlayers = [];

    // Cleanup and collect active players
    for (const p in players) {
        if (now - players[p].lastUpdate > 5000) {
            delete players[p];
            io.emit('player-left', p); // Notify removal
        } else {
            activePlayers.push(p);
        }
    }

    // Send personalized volume data to each connected socket
    for (const [socketId, socket] of io.of("/").sockets) {
        if (!socket.playerName || !players[socket.playerName]) continue;

        const observer = players[socket.playerName];
        const volumeUpdates = {};

        activePlayers.forEach(targetName => {
            if (targetName === socket.playerName) return;

            const target = players[targetName];

            if (observer.channel !== target.channel) {
                volumeUpdates[targetName] = 0;
                return;
            }

            // Global Server Mute (Admin)
            if (serverMute) {
                volumeUpdates[targetName] = 0;
                return;
            }

            // Check mute (Global Mute of Target)
            if (target.mute) {
                volumeUpdates[targetName] = 0;
                return;
            }

            // Check individual mute (Observer muted Target)
            if (observer.mutedPlayers && observer.mutedPlayers.includes(targetName)) {
                volumeUpdates[targetName] = 0;
                return;
            }

            if (observer.mutedPlayers && observer.mutedPlayers.includes(targetName)) {
                volumeUpdates[targetName] = 0;
                return;
            }

            const dist = calculateDistance(observer, target);
            volumeUpdates[targetName] = getVolume(dist);
        });

        socket.emit('volume-update', volumeUpdates);

        // Notify client about self state (e.g., mute)
        socket.emit('self-update', { mute: observer.mute, channel: observer.channel });
    }
}, 200); // Update volume 5 times a second

// Socket.io for WebRTC signaling and Audio
io.on('connection', (socket) => {
    console.log('Web client connected:', socket.id);

    socket.on('join-room', (playerName) => {
        socket.playerName = playerName;
        playerSockets[playerName] = socket.id;

        socket.join('global');
        console.log(`${playerName} joined global`);

        // Notify others for WebRTC
        socket.broadcast.emit('user-connected', playerName);

        // Broadcast user count
        io.emit('user-count', Object.keys(playerSockets).length);
    });

    // WebRTC Signaling
    socket.on('speaking-status', (isSpeaking) => {
        if (socket.playerName && players[socket.playerName]) {
            players[socket.playerName].isSpeaking = isSpeaking;
        }
    });

    socket.on('offer', (data) => {
        const targetSocketId = playerSockets[data.target];
        if (targetSocketId) {
            io.to(targetSocketId).emit('offer', data);
        }
    });

    socket.on('answer', (data) => {
        const targetSocketId = playerSockets[data.target];
        if (targetSocketId) {
            io.to(targetSocketId).emit('answer', data);
        }
    });

    socket.on('ice-candidate', (data) => {
        const targetSocketId = playerSockets[data.target];
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice-candidate', data);
        }
    });

    socket.on('disconnect', () => {
        if (socket.playerName) {
            delete playerSockets[socket.playerName];
            // We don't delete from `players` immediately, we let the timeout handle it

            // Broadcast user count
            io.emit('user-count', Object.keys(playerSockets).length);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
