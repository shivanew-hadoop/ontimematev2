function qs(id) { return document.getElementById(id); }

function setStatus(msg, type = "info") {
  const box = qs("statusBox");
  box.className = "text-sm mb-4 rounded-lg p-3 " + (
    type === "error" ? "bg-red-50 text-red-700 border border-red-200" :
    type === "ok" ? "bg-green-50 text-green-700 border border-green-200" :
    "bg-slate-50 text-slate-700 border border-slate-200"
  );
  box.textContent = msg;
  box.classList.remove("hidden");
}

function clearStatus() {
  const box = qs("statusBox");
  box.classList.add("hidden");
  box.textContent = "";
}

function activeTab(tab) {
  const tabLogin = qs("tabLogin");
  const tabSignup = qs("tabSignup");
  const tabForgot = qs("tabForgot");

  const loginForm = qs("loginForm");
  const signupForm = qs("signupForm");
  const forgotForm = qs("forgotForm");

  const allTabs = [tabLogin, tabSignup, tabForgot];
  allTabs.forEach(t => {
    t.classList.remove("text-blue-700", "border-b-2", "border-blue-700");
    t.classList.add("text-slate-500");
  });

  loginForm.classList.add("hidden");
  signupForm.classList.add("hidden");
  forgotForm.classList.add("hidden");

  clearStatus();

  if (tab === "signup") {
    tabSignup.classList.add("text-blue-700", "border-b-2", "border-blue-700");
    tabSignup.classList.remove("text-slate-500");
    signupForm.classList.remove("hidden");
  } else if (tab === "forgot") {
    tabForgot.classList.add("text-blue-700", "border-b-2", "border-blue-700");
    tabForgot.classList.remove("text-slate-500");
    forgotForm.classList.remove("hidden");
  } else {
    tabLogin.classList.add("text-blue-700", "border-b-2", "border-blue-700");
    tabLogin.classList.remove("text-slate-500");
    loginForm.classList.remove("hidden");
  }
}

function getTabFromUrl() {
  const u = new URL(location.href);
  return (u.searchParams.get("tab") || "login").toLowerCase();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const errMsg = json?.error || json?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return json;
}

document.addEventListener("DOMContentLoaded", () => {
  qs("tabLogin").onclick = () => activeTab("login");
  qs("tabSignup").onclick = () => activeTab("signup");
  qs("tabForgot").onclick = () => activeTab("forgot");

  activeTab(getTabFromUrl());

  qs("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const email = qs("loginEmail").value.trim();
      const password = qs("loginPassword").value;

      const data = await postJson("/api/auth/login", { email, password });

      // keep same structure your app expects: session.user.id
      localStorage.setItem("session", JSON.stringify({ user: data.user, session: data.session }));
      setStatus("Login successful. Redirecting…", "ok");
      location.href = "/app";
    } catch (err) {
      setStatus(err.message || "Login failed", "error");
    }
  });

  qs("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const name = qs("signupName").value.trim();
      const phone = qs("signupPhone").value.trim();
      const email = qs("signupEmail").value.trim();
      const password = qs("signupPassword").value;

      const data = await postJson("/api/auth/signup", { name, phone, email, password });

      if (data?.session && data?.user) {
        localStorage.setItem("session", JSON.stringify({ user: data.user, session: data.session }));
        setStatus("Account created. Redirecting…", "ok");
        location.href = "/app";
      } else {
        // Email confirmation flows often return no session
        setStatus("Account created. Check your email for confirmation (if enabled), then login.", "ok");
        activeTab("login");
      }
    } catch (err) {
      setStatus(err.message || "Signup failed", "error");
    }
  });

  qs("forgotForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const email = qs("forgotEmail").value.trim();
      await postJson("/api/auth/forgot", { email });
      setStatus("Reset email requested. Check your inbox.", "ok");
    } catch (err) {
      setStatus(err.message || "Forgot password failed", "error");
    }
  });
});
