// -----------------------------
// SESSION AND USER DATA
// -----------------------------
const session = JSON.parse(localStorage.getItem("session"));
if (!session) window.location.href = "/auth";

const user_id = session.user.id;

// -----------------------------
// DOM REFERENCES
// -----------------------------
const chatBox = document.getElementById("chatBox");
const userInput = document.getElementById("userInput");
const sendBtnChat = document.getElementById("sendBtnChat");

const promptBox = document.getElementById("promptBox");
const sendBtn = document.getElementById("sendBtn");

const creditsBox = document.getElementById("creditsBox");
const logoutBtn = document.getElementById("logoutBtn");

// -----------------------------
// LOAD USER CREDITS
// -----------------------------
async function loadCredits() {
  const res = await fetch("/api/user/profile", {
    method: "POST",
    body: JSON.stringify({ user_id })
  });

  const data = await res.json();
  creditsBox.textContent = `Credits: ${data?.data?.credits ?? "--"}`;
}

loadCredits();

// -----------------------------
// AUTO-DEDUCT 1 CREDIT / SECOND
// -----------------------------
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


// -----------------------------
// CHAT MESSAGE BUBBLES
// -----------------------------
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


// -----------------------------
// WEBSOCKET SETUP
// -----------------------------
let ws;

async function connectWS() {
  const tokenRes = await fetch("/api/chat/token");
  const token = await tokenRes.json();

  ws = new WebSocket(token.client_ws_url, {
    headers: { Authorization: `Bearer ${token.client_secret}` }
  });

  ws.onopen = () => console.log("WebSocket connected");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "response.delta") {
      addMsg("assistant", msg.delta);
    }
  };

  ws.onerror = (e) => console.log("WS error", e);
}

connectWS();


// -----------------------------
// SEND MESSAGE (COMMON HANDLER)
// -----------------------------
function sendMessage(text) {
  if (!text) return;

  addMsg("user", text);

  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "text", text }]
      }
    })
  );

  ws.send(JSON.stringify({ type: "response.create" }));
}


// -----------------------------
// RIGHT COLUMN CHAT INPUT
// -----------------------------
sendBtnChat.onclick = () => {
  const text = userInput.value.trim();
  userInput.value = "";
  sendMessage(text);
};

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const text = userInput.value.trim();
    userInput.value = "";
    sendMessage(text);
  }
});


// -----------------------------
// LEFT COLUMN: SEND TRANSCRIPT
// -----------------------------
sendBtn.onclick = () => {
  const text = promptBox.value.trim();
  if (!text) return;
  sendMessage(text);
};


// -----------------------------
// CLEAR TRANSCRIPT BUTTON
// -----------------------------
resetBtn.onclick = () => {
  promptBox.value = "";
};


// -----------------------------
// LOGOUT
// -----------------------------
logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth";
};
