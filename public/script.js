const socket = io();
const loginScreen = document.getElementById('login-screen');
const statusScreen = document.getElementById('status-screen');
const displayName = document.getElementById('display-name');
const joinBtn = document.getElementById('join-btn');
const usernameInput = document.getElementById('username');
const micStatus = document.getElementById('mic-status');
const connStatus = document.getElementById('connection-status');
const playersList = document.getElementById('players-list');
const userCountDisplay = document.getElementById('user-count-display');

let localStream;
let myName = '';
const peers = {}; // playerName -> RTCPeerConnection
const audioElements = {}; // playerName -> HTMLAudioElement

// Configuration for WebRTC
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

joinBtn.addEventListener('click', async () => {
    const name = usernameInput.value.trim();
    if (!name) return alert('Por favor ingresa tu Gamertag');

    myName = name;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micStatus.classList.add('active');

        // Voice Activity Detection (VAD)
        const audioContext = new AudioContext();
        const mediaStreamSource = audioContext.createMediaStreamSource(localStream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        mediaStreamSource.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let isSpeaking = false;
        const silenceThreshold = 10; // Adjustable threshold

        // Check volume periodically
        setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;

            const currentlySpeaking = average > silenceThreshold;

            if (currentlySpeaking !== isSpeaking) {
                isSpeaking = currentlySpeaking;
                socket.emit('speaking-status', isSpeaking);

                // Visual feedback for self
                if (isSpeaking) {
                    micStatus.style.boxShadow = "0 0 10px #00ff00";
                } else {
                    micStatus.style.boxShadow = "none";
                }
            }
        }, 100);

        loginScreen.classList.add('hidden');
        statusScreen.classList.remove('hidden');
        displayName.textContent = myName;

        socket.emit('join-room', myName);
        connStatus.classList.add('active');

    } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('No se pudo acceder al micrófono');
    }
});

// WebRTC logic
socket.on('user-connected', async (userName) => {
    if (userName === myName) return;
    console.log('User connected:', userName);
    createPeer(userName, true);
});

socket.on('player-left', (userName) => {
    if (peers[userName]) {
        peers[userName].close();
        delete peers[userName];
    }
    if (audioElements[userName]) {
        audioElements[userName].remove();
        delete audioElements[userName];
    }
    updatePlayerList();
});

socket.on('offer', async (data) => {
    if (data.target !== myName) return;
    await createPeer(data.caller, false);
    await peers[data.caller].setRemoteDescription(new RTCSessionDescription(data.offer));

    // Process queued candidates
    if (peers[data.caller].candidateQueue) {
        for (const candidate of peers[data.caller].candidateQueue) {
            try {
                await peers[data.caller].addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error('Error adding queued ice candidate', e);
            }
        }
        peers[data.caller].candidateQueue = [];
    }

    const answer = await peers[data.caller].createAnswer();
    await peers[data.caller].setLocalDescription(answer);
    socket.emit('answer', { target: data.caller, caller: myName, answer });
});

socket.on('answer', async (data) => {
    if (data.target !== myName) return;
    await peers[data.caller].setRemoteDescription(new RTCSessionDescription(data.answer));

    // Process queued candidates
    if (peers[data.caller].candidateQueue) {
        for (const candidate of peers[data.caller].candidateQueue) {
            try {
                await peers[data.caller].addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error('Error adding queued ice candidate', e);
            }
        }
        peers[data.caller].candidateQueue = [];
    }
});

socket.on('ice-candidate', async (data) => {
    if (data.target !== myName) return;
    const peer = peers[data.caller];
    if (peer) {
        if (peer.remoteDescription) {
            try {
                await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
                console.error('Error adding received ice candidate', e);
            }
        } else {
            // Queue candidate if remote description is not yet set
            if (!peer.candidateQueue) {
                peer.candidateQueue = [];
            }
            peer.candidateQueue.push(data.candidate);
        }
    }
});

socket.on('volume-update', (volumes) => {
    // volumes is { playerName: volumeLevel }
    for (const [player, volume] of Object.entries(volumes)) {
        if (audioElements[player]) {
            audioElements[player].volume = volume;

            // Visual indicator update (optional)
            const li = document.getElementById(`li-${player}`);
            if (li) {
                li.style.opacity = volume > 0 ? 1 : 0.5;
                li.innerHTML = `${player} <span>🔊 ${(volume * 100).toFixed(0)}%</span>`;
            }
        }
    }
});

socket.on('self-update', (data) => {
    // data: { mute: boolean, channel: string }
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            // If data.mute is true, we disable the track (mute)
            // If data.mute is false, we enable it (hablar)
            const shouldBeEnabled = !data.mute;
            if (audioTrack.enabled !== shouldBeEnabled) {
                audioTrack.enabled = shouldBeEnabled;
                console.log(`Microphone ${shouldBeEnabled ? 'enabled' : 'disabled'} by server`);

                // Update UI
                if (shouldBeEnabled) {
                    micStatus.classList.add('active');
                    micStatus.classList.remove('error');
                } else {
                    micStatus.classList.remove('active');
                    micStatus.classList.add('error'); // Use error color for mute
                }
            }
        }
    }
});

async function createPeer(targetName, initiator) {
    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetName] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: targetName, caller: myName, candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        if (!audioElements[targetName]) {
            const audio = new Audio();
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audioElements[targetName] = audio;
            updatePlayerList();
        }
    };

    if (initiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: targetName, caller: myName, offer });
    }
}

function updatePlayerList() {
    playersList.innerHTML = '';
    for (const p in audioElements) {
        const li = document.createElement('li');
        li.id = `li-${p}`;
        li.textContent = p;
        playersList.appendChild(li);
    }

    // Add volume updates to list just in case
    // This will be populated by volume-update event
}

socket.on('user-count', (count) => {
    if (userCountDisplay) {
        userCountDisplay.textContent = `Usuarios conectados: ${count}`;
    }
});
