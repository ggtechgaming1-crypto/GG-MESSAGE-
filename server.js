const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// ऑनलाइन यूजर्स को ट्रैक करने के लिए
const activeUsers = {};

io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    // यूजर रजिस्टर होना
    socket.on('register', (username) => {
        if (username) {
            activeUsers[username.toUpperCase()] = socket.id;
            console.log(`User registered: ${username.toUpperCase()} -> ${socket.id}`);
        }
    });

    // 💬 चैट मैसेज / एसएमएस भेजना और रिसीव करना (यह कनेक्शन के अंदर होना चाहिए)
    socket.on('send-message', (data) => {
        // data में { to, from, message, isFile, fileName } होता है
        if (data && data.to) {
            const targetKey = data.to.toUpperCase();
            const targetSocketId = activeUsers[targetKey];
            
            console.log(`Message from ${data.from} to ${data.to} (Target Socket: ${targetSocketId})`);

            if (targetSocketId) {
                // सही यूजर की सॉकेट आईडी पर मैसेज भेजें
                io.to(targetSocketId).emit('private-message', {
                    from: data.from,
                    message: data.message,
                    isFile: data.isFile || false,
                    fileName: data.fileName || ''
                });
            }
        }
    });

    // WebRTC ऑफर भेजना (कॉल मिलाना)
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

    // WebRTC आंसर भेजना (कॉल रिसीव करना)
    socket.on('make-answer', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('call-answered', {
                    answer: data.answer
                });
            }
        }
    });

    // ICE Candidate शेयर करना (नेटवर्क पाथ जोड़ने के लिए)
    socket.on('ice-candidate', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('ice-candidate', {
                    candidate: data.candidate
                });
            }
        }
    });

    // कॉल काटना / डिसकनेक्ट होना
    socket.on('hangup', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('hangup');
            }
        }
    });

    socket.on('disconnect', () => {
        for (let username in activeUsers) {
            if (activeUsers[username] === socket.id) {
                delete activeUsers[username];
                break;
            }
        }
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
