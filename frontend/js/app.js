//--------------------------------------------------------------
// SESSION
//--------------------------------------------------------------
function getSession() {
  try {
    return JSON.parse(localStorage.getItem("session") || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem("session");
}

//--------------------------------------------------------------
// ENSURE USER (NOT ADMIN)
//--------------------------------------------------------------
async function ensureUser() {
  const s = getSession();
  if (!s || s.is_admin) {
    window.location.href = "/auth?tab=login";
    return null;
  }
  return s;
}

//--------------------------------------------------------------
// DOM ELEMENTS
//--------------------------------------------------------------
const userInfo = document.getElementById("userInfo");
const instructionsBox = document.getElementById("instructionsBox");
const instrStatus = document.getElementById("instrStatus");
const resumeInput = document.getElementById("resumeInput");
const resumeStatus = document.getElementById("resumeStatus");
const promptBox = document.getElementById("promptBox");
const responseBox = document.getElementById("responseBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sysBtn = document.getElementById("sysBtn");
const resetBtn = document.getElementById("resetBtn");
const sendBtn = document.getElementById("sendBtn");
const sendStatus = document.getElementById("sendStatus");
const audioStatus = document.getElementById("audioStatus");
const logoutBtn = document.getElementById("logoutBtn");

let session = null;

//--------------------------------------------------------------
// LOAD PROFILE
//--------------------------------------------------------------
async function loadUserProfile() {
  const res = await fetch("/api/user/profile", {
    headers: { Authorization: `Bearer ${session.access_token}` }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  userInfo.innerHTML = `
    Logged in as <b>${data.user.email}</b><br>
    Credits: <b>${data.user.credits}</b><br>
    Joined: ${data.user.created_ymd}
  `;
}

//--------------------------------------------------------------
// RESUME UPLOAD
//--------------------------------------------------------------
resumeInput?.addEventListener("change", async () => {
  const file = resumeInput.files?.[0];
  if (!file) return;

  resumeStatus.textContent = "Uploading...";

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api/resume/extract", { method: "POST", body: fd });
  const data = await res.json();

  localStorage.setItem("resumeText", data.text || "");
  resumeStatus.textContent = "Resume uploaded.";
});

//--------------------------------------------------------------
// SAVE INSTRUCTIONS
//--------------------------------------------------------------
instructionsBox?.addEventListener("input", () => {
  localStorage.setItem("instructions", instructionsBox.value);
  instrStatus.textContent = "Saved";
});

//--------------------------------------------------------------
// SEND CHAT REQUEST
//--------------------------------------------------------------
sendBtn?.addEventListener("click", async () => {
  const prompt = promptBox.value.trim();
  if (!prompt) return;

  sendStatus.textContent = "Sending...";

  const body = {
    prompt,
    instructions: localStorage.getItem("instructions") || "",
    resumeText: localStorage.getItem("resumeText") || ""
  };

  const res = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  responseBox.textContent = "";

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseBox.textContent += new TextDecoder().decode(value);
  }

  sendStatus.textContent = "Done.";
});

//--------------------------------------------------------------
// RESET
//--------------------------------------------------------------
resetBtn?.addEventListener("click", () => {
  responseBox.textContent = "";
  promptBox.value = "";
});

//--------------------------------------------------------------
// AUDIO CAPTURE (MIC)
//--------------------------------------------------------------
let recorder = null;

startBtn?.addEventListener("click", async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  recorder.ondataavailable = async (e) => {
    const fd = new FormData();
    fd.append("file", e.data, "chunk.webm");

    const res = await fetch("/api/transcribe", { method: "POST", body: fd });
    const data = await res.json();
    promptBox.value += " " + data.text;
  };

  recorder.start(2000);
  audioStatus.textContent = "Recording...";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.classList.remove("opacity-50");
});

stopBtn?.addEventListener("click", () => {
  recorder?.stop();
  audioStatus.textContent = "Stopped";
  startBtn.disabled = false;
  stopBtn.disabled = true;
  stopBtn.classList.add("opacity-50");
});

//--------------------------------------------------------------
// LOGOUT
//--------------------------------------------------------------
logoutBtn?.addEventListener("click", () => {
  clearSession();
  window.location.href = "/auth?tab=login";
});

//--------------------------------------------------------------
// INIT
//--------------------------------------------------------------
window.addEventListener("load", async () => {
  session = await ensureUser();
  if (!session) return;

  instructionsBox.value = localStorage.getItem("instructions") || "";

  try {
    await loadUserProfile();
  } catch (e) {
    console.error("Profile load failed:", e);
    clearSession();
    window.location.href = "/auth?tab=login";
  }
});
