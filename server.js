const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const activeUsers = {};

io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    // यूजर रजिस्टर होना और ऑनलाइन स्टेटस ब्रॉडकास्ट करना
    socket.on('register', (username) => {
        if (username) {
            const cleanUser = username.toUpperCase();
            activeUsers[cleanUser] = socket.id;
            console.log(`User registered: ${cleanUser} -> ${socket.id}`);
            
            // सभी को बताएं कि यह यूजर ऑनलाइन आ गया है
            io.emit('user-status-changed', { username: cleanUser, status: 'online' });
        }
    });

    // 💬 चैट मैसेज, फाइल्स और वॉइस नोट (Voice Mail) फॉरवर्ड करना
    socket.on('send-message', (data) => {
        if (data && data.to) {
            const targetKey = data.to.toUpperCase();
            const targetSocketId = activeUsers[targetKey];

            if (targetSocketId) {
                io.to(targetSocketId).emit('private-message', {
                    from: data.from,
                    message: data.message,
                    isFile: data.isFile || false,
                    fileName: data.fileName || ''
                });
            }
        }
    });

    // WebRTC कॉलिंग इवेंट्स (ऑफर, आंसर, ICE, हँगअप)
    socket.on('call-user', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('incoming-call', {
                    from: data.from,
                    offer: data.offer,
                    callType: data.callType
                });
            }
        }
    });

    socket.on('make-answer', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('call-answered', { answer: data.answer });
            }
        }
    });

    socket.on('ice-candidate', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('ice-candidate', { candidate: data.candidate });
            }
        }
    });

    socket.on('hangup', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('hangup');
            }
        }
    });

    // डिसकनेक्ट होने पर ऑफलाइन स्टेटस अपडेट करना
    socket.on('disconnect', () => {
        let disconnectedUser = '';
        for (let username in activeUsers) {
            if (activeUsers[username] === socket.id) {
                disconnectedUser = username;
                delete activeUsers[username];
                break;
            }
        }
        if (disconnectedUser) {
            console.log(`User disconnected: ${disconnectedUser}`);
            io.emit('user-status-changed', { username: disconnectedUser, status: 'offline' });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
