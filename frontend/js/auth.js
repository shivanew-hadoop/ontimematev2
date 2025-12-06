const msg = document.getElementById("msg"); // add <p id="msg">...</p> in auth.html if not present

function showMsg(text, isError = false) {
  if (!msg) return;
  msg.textContent = text;
  msg.className = isError ? "text-sm text-red-600 mt-2" : "text-sm text-green-700 mt-2";
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

// LOGIN form submit
document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const email = document.getElementById("loginEmail")?.value?.trim();
    const password = document.getElementById("loginPassword")?.value;
    if (!email || !password) return;

    const data = await postJSON("/api/auth/login", { email, password });

    // store session
    localStorage.setItem("session", JSON.stringify(data.session));
    showMsg("Login successful. Redirecting...");
    window.location.href = "/app";
  } catch (err) {
    showMsg(err.message || String(err), true);
  }
});

// SIGNUP form submit
document.getElementById("signupForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const name = document.getElementById("signupName")?.value?.trim();
    const phone = document.getElementById("signupPhone")?.value?.trim();
    const email = document.getElementById("signupEmail")?.value?.trim();
    const password = document.getElementById("signupPassword")?.value;
    const confirm = document.getElementById("signupConfirm")?.value;

    if (!name || !email || !password || password !== confirm) {
      throw new Error("Please fill all fields and ensure passwords match.");
    }

    await postJSON("/api/auth/signup", { name, phone, email, password });

    showMsg("Account created successfully. Waiting for admin approval. Please log in after approval.");
    // optionally switch to login tab here
  } catch (err) {
    showMsg(err.message || String(err), true);
  }
});

// FORGOT form submit (use your backend route, not direct supabase recover)
document.getElementById("forgotForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const email = document.getElementById("forgotEmail")?.value?.trim();
    if (!email) return;

    await postJSON("/api/auth/recover", { email });
    showMsg("Reset link sent (check inbox/spam).");
  } catch (err) {
    showMsg(err.message || String(err), true);
  }
});
