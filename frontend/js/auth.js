// -------------------------------
// TAB SWITCHING
// -------------------------------
const loginTab = document.getElementById("loginTab");
const signupTab = document.getElementById("signupTab");
const forgotTab = document.getElementById("forgotTab");

const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const forgotForm = document.getElementById("forgotForm");

function showLogin() {
  loginTab.classList.add("active");
  signupTab.classList.remove("active");
  forgotTab.classList.remove("active");

  loginForm.style.display = "block";
  signupForm.style.display = "none";
  forgotForm.style.display = "none";
}

function showSignup() {
  signupTab.classList.add("active");
  loginTab.classList.remove("active");
  forgotTab.classList.remove("active");

  signupForm.style.display = "block";
  loginForm.style.display = "none";
  forgotForm.style.display = "none";
}

function showForgot() {
  forgotTab.classList.add("active");
  loginTab.classList.remove("active");
  signupTab.classList.remove("active");

  forgotForm.style.display = "block";
  loginForm.style.display = "none";
  signupForm.style.display = "none";
}

loginTab.onclick = showLogin;
signupTab.onclick = showSignup;
forgotTab.onclick = showForgot;

// -------------------------------
// LOGIN
// -------------------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value.trim()
  };

  const res = await fetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.error) {
    errorBox.textContent = data.error;
    errorBox.classList.remove("hidden");
    return;
  }

  if (data.admin === true) {
    localStorage.setItem("adminToken", data.token);
    window.location.href = "/admin";
    return;
  }

  localStorage.setItem("session", JSON.stringify(data.session));
  window.location.href = "/app";
});

// -------------------------------
// SIGNUP
// -------------------------------
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    name: document.getElementById("name").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value.trim(),
    confirmPassword: document.getElementById("confirmPassword").value.trim()
  };

  if (payload.password !== payload.confirmPassword) {
    signupError.textContent = "Passwords do not match";
    signupError.classList.remove("hidden");
    return;
  }

  const res = await fetch("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.error) {
    signupError.textContent = data.error;
    signupError.classList.remove("hidden");
    return;
  }

  alert("Account created! Please login.");
  showLogin();
});

// -------------------------------
// FORGOT PASSWORD
// -------------------------------
forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("forgotEmail").value.trim();

  const res = await fetch("https://nicigbmhzpgyhkzeshbl.supabase.co/auth/v1/recover", {
    method: "POST",
    headers: {
      "apikey": "YOUR_SUPABASE_ANON_KEY",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email })
  });

  const data = await res.json();

  if (res.ok) {
    forgotSuccess.textContent = "Reset link sent!";
    forgotSuccess.classList.remove("hidden");
    forgotError.classList.add("hidden");
  } else {
    forgotError.textContent = data.error_description || "Failed to send reset link";
    forgotError.classList.remove("hidden");
    forgotSuccess.classList.add("hidden");
  }
});
