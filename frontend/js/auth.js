//--------------------------------------------------------------
// HELPERS
//--------------------------------------------------------------
const statusBox = document.getElementById("statusBox");

function showMsg(text, isError = false) {
  if (!statusBox) return;
  statusBox.textContent = text;
  statusBox.className = isError
    ? "text-sm mb-4 bg-red-50 text-red-700 border border-red-200 rounded-lg p-3"
    : "text-sm mb-4 bg-green-50 text-green-800 border-green-200 border rounded-lg p-3";
  statusBox.classList.remove("hidden");
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? (el.value || "").trim() : "";
}

//--------------------------------------------------------------
// TAB SWITCHING
//--------------------------------------------------------------
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const tabForgot = document.getElementById("tabForgot");
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const forgotForm = document.getElementById("forgotForm");

function setTab(active) {
  const setBtn = (btn, on) => {
    if (!btn) return;
    btn.className = on
      ? "font-semibold text-blue-700 border-b-2 border-blue-700 pb-2"
      : "font-semibold text-slate-500 pb-2";
  };

  loginForm.classList.toggle("hidden", active !== "login");
  signupForm.classList.toggle("hidden", active !== "signup");
  forgotForm.classList.toggle("hidden", active !== "forgot");

  setBtn(tabLogin, active === "login");
  setBtn(tabSignup, active === "signup");
  setBtn(tabForgot, active === "forgot");
}

const params = new URLSearchParams(location.search);
setTab(params.get("tab") || "login");

tabLogin?.addEventListener("click", () => setTab("login"));
tabSignup?.addEventListener("click", () => setTab("signup"));
tabForgot?.addEventListener("click", () => setTab("forgot"));


//--------------------------------------------------------------
// LOGIN
//--------------------------------------------------------------
loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  try {
    const email = getVal("loginEmail");
    const password = getVal("loginPassword");

    if (!email || !password)
      return showMsg("Enter email and password.", true);

    showMsg("Signing in…");

    const data = await postJSON("/api/auth/login", { email, password });

    // MUST HAVE SESSION
    if (!data?.session)
      throw new Error("Login failed: No session returned.");

    // SAVE SESSION (fixes infinite refresh)
    localStorage.setItem("session", JSON.stringify(data.session));

    // REDIRECT
    window.location.href = data.session.is_admin ? "/admin" : "/app";

  } catch (err) {
    showMsg(err?.message || String(err), true);
  }
});


//--------------------------------------------------------------
// SIGNUP
//--------------------------------------------------------------
signupForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const name = getVal("signupName");
    const phone = getVal("signupPhone");
    const email = getVal("signupEmail");
    const password = getVal("signupPassword");
    const confirm = getVal("signupConfirm");

    if (!name || !email || !password)
      return showMsg("Fill all required fields.", true);

    if (password !== confirm)
      return showMsg("Passwords do not match.", true);

    showMsg("Creating account…");

    const out = await postJSON("/api/auth/signup", {
      name, phone, email, password
    });

    showMsg(out.message || "Account created.");
    setTab("login");

  } catch (err) {
    showMsg(err?.message || String(err), true);
  }
});


//--------------------------------------------------------------
// FORGOT PASSWORD
//--------------------------------------------------------------
forgotForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const email = getVal("forgotEmail");
    if (!email) return showMsg("Enter your email.", true);

    showMsg("Sending reset link…");

    await postJSON("/api/auth/forgot", { email });

    showMsg("Reset link sent.");
    setTab("login");

  } catch (err) {
    showMsg(err?.message || String(err), true);
  }
});
