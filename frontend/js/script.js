// ---------------------------------------------------------
// SESSION + USER INITIALIZATION
// ---------------------------------------------------------
const session = JSON.parse(localStorage.getItem("session"));
if (!session) window.location.href = "/auth";

const user_id = session.user.id;

// ---------------------------------------------------------
// DOM REFERENCES
// ---------------------------------------------------------
const promptBox = document.getElementById("promptBox");
const sendBtn = document.getElementById("sendBtn");
const resetBtn = document.getElementById("resetBtn");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sysBtn = document.getElementById("sysBtn");
const audioStatus = document.getElementById("audioStatus");

const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");

const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");

const chatBox = document.getElementById("chatBox");
const userInput = document.getElementById("userInput");
const sendBtnChat = document.getElementById("sendBtnChat");

const creditsBox = document.getElementById("creditsBox");
const logoutBtn = document.getElementById("logoutBtn");

// ---------------------------------------------------------
// LOAD CREDITS
// ---------------------------------------------------------
async function loadCredits() {
  const res = await fetch("/api/user/profile", {
    method: "POST",
    body: JSON.stringify({ user_id })
  });

  const data = await res.json();
  creditsBox.textContent = `Credits: ${data?.data?.credits ?? "--"}`;
}
loadCredits();

// ---------------------------------------------------------
// AUTO DEDUCT 1 CREDIT / SECOND
// ---------------------------------------------------------
setInterval(async () => {
  const res = await fetch("/api/user/credits", {
    method: "POST",
    body: JSON.stringify({ user_id })
  });

  const data = await res.json();
  creditsBox.textContent = `Credits: ${data.credits}`;

  if (data.credits <= 0) {
    alert("No credits left!");
  }
}, 1000);

// ---------------------------------------------------------
// CHAT UI BUBBLES
// ---------------------------------------------------------
function addMsg(role, text) {
  const div = document.createElement("div");
  div.style.marginBottom = "10px";
  div.style.textAlign = role === "user" ? "right" : "left";

  const bubble = document.createElement("span");
  bubble.style.display = "inline-block";
  bubble.style.padding = "6px 12px";
  bubble.style.borderRadius = "8px";
  bubble.style.fontSize = "13px";

  if (role === "user") {
    bubble.style.background = "#1a73e8";
    bubble.style.color = "white";
  } else {
    bubble.style.background = "#eee";
    bubble.style.color = "#333";
  }

  bubble.textContent = text;
  div.appendChild(bubble);

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ---------------------------------------------------------
// WEBSOCKET SETUP
// ---------------------------------------------------------
let ws;

async function connectWS() {
  const tokenRes = await fetch("/api/chat/token");
  const token = await tokenRes.json();

  ws = new WebSocket(token.client_ws_url, {
    headers: { Authorization: `Bearer ${token.client_secret}` }
  });

  ws.onopen = () => console.log("Realtime WS connected");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "response.delta") {
      addMsg("assistant", msg.delta);
    }
  };

  ws.onerror = (err) => console.log("WS error:", err);
}

connectWS();

// ---------------------------------------------------------
// SEND MESSAGE (COMMON FUNCTION)
// ---------------------------------------------------------
function sendMessage(text) {
  if (!text || !ws) return;

  addMsg("user", text);

  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "text", text }]
    }
  }));

  ws.send(JSON.stringify({ type: "response.create" }));
}

// ---------------------------------------------------------
// RIGHT COLUMN CHAT INPUT
// ---------------------------------------------------------
sendBtnChat.onclick = () => {
  const text = userInput.value.trim();
  userInput.value = "";
  sendMessage(text);
};

userInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    const text = userInput.value.trim();
    userInput.value = "";
    sendMessage(text);
  }
};

// ---------------------------------------------------------
// LEFT COLUMN — SEND TRANSCRIPT
// ---------------------------------------------------------
sendBtn.onclick = () => {
  const text = promptBox.value.trim();
  if (!text) return;
  sendMessage(text);
};

resetBtn.onclick = () => {
  promptBox.value = "";
};

// ---------------------------------------------------------
// SAVE & LOAD CUSTOM INSTRUCTIONS
// ---------------------------------------------------------
instructionsBox.value = localStorage.getItem("customInstructions") || "";
instructionsBox.oninput = () => {
  localStorage.setItem("customInstructions", instructionsBox.value);
  instrStatus.textContent = "Saved.";
};

// ---------------------------------------------------------
// RESUME UPLOAD + EXTRACTION
// ---------------------------------------------------------
resumeInput.onchange = async () => {
  const file = resumeInput.files[0];
  if (!file) return;

  resumeStatus.textContent = "Processing...";

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("/api/resume/extract", {
    method: "POST",
    body: formData
  });

  const data = await res.json();

  localStorage.setItem("resumeText", data.text);
  resumeStatus.textContent = "Resume extracted.";
};

// ---------------------------------------------------------
// VOICE AGENT: CAPTURE MIC + SYSTEM AUDIO
// ---------------------------------------------------------
let mediaRecorder;
let mixedStream;
let audioChunks = [];

async function enableSystemAudio() {
  try {
    const sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    audioCtx.createMediaStreamSource(sysStream).connect(dest);
    audioCtx.createMediaStreamSource(micStream).connect(dest);

    mixedStream = dest.stream;
    audioStatus.textContent = "System Audio Enabled";
  } catch (err) {
    audioStatus.textContent = "System audio not allowed";
  }
}

sysBtn.onclick = enableSystemAudio;

// ---------------------------------------------------------
// START RECORDING
// ---------------------------------------------------------
startBtn.onclick = async () => {
  try {
    if (!mixedStream) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mixedStream = stream;
    }

    mediaRecorder = new MediaRecorder(mixedStream, { mimeType: "audio/webm" });
    audioChunks = [];

    mediaRecorder.ondataavailable = async (e) => {
      audioChunks.push(e.data);
      if (audioChunks.length >= 1) {
        await transcribeChunk();
        audioChunks = [];
      }
    };

    mediaRecorder.start(1000);
    audioStatus.textContent = "Recording…";
  } catch (err) {
    audioStatus.textContent = "Error starting mic";
  }
};

// ---------------------------------------------------------
// STOP RECORDING
// ---------------------------------------------------------
stopBtn.onclick = () => {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  audioStatus.textContent = "Stopped";
};

// ---------------------------------------------------------
// SEND CHUNK TO WHISPER
// ---------------------------------------------------------
async function transcribeChunk() {
  const blob = new Blob(audioChunks, { type: "audio/webm" });

  const formData = new FormData();
  formData.append("file", blob, "audio.webm");

  const res = await fetch("/api/transcribe", {
    method: "POST",
    body: formData
  });

  const data = await res.json();

  if (data.text) {
    promptBox.value = promptBox.value + " " + data.text;
  }
}

// ---------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------
logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth";
};
