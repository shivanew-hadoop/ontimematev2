const loginCard = document.getElementById("loginCard");
const usersCard = document.getElementById("usersCard");
const usersTbody = document.getElementById("usersTbody");
const usersErr = document.getElementById("usersErr");
const loginErr = document.getElementById("loginErr");
const adminEmailEl = document.getElementById("adminEmail");
const countPill = document.getElementById("countPill");

const adminLoginForm = document.getElementById("adminLoginForm");
const adminLoginEmail = document.getElementById("adminLoginEmail");
const adminLoginPassword = document.getElementById("adminLoginPassword");

const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const searchBox = document.getElementById("searchBox");

function getToken() {
  return localStorage.getItem("admin_token") || "";
}
function setToken(t) {
  localStorage.setItem("admin_token", t);
}
function clearToken() {
  localStorage.removeItem("admin_token");
  localStorage.removeItem("admin_email");
}

function showLogin() {
  loginCard.classList.remove("hidden");
  usersCard.classList.add("hidden");
  adminEmailEl.textContent = "";
}
function showUsers() {
  loginCard.classList.add("hidden");
  usersCard.classList.remove("hidden");
  adminEmailEl.textContent = localStorage.getItem("admin_email") || "";
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function api(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

let allUsers = [];

function renderUsers(list) {
  usersTbody.innerHTML = "";
  countPill.textContent = `${list.length} users`;
  for (const u of list) {
    const tr = document.createElement("tr");
    tr.className = "border-b";

    const statusPill = u.approved
      ? `<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Approved</span>`
      : `<span class="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">Pending</span>`;

    tr.innerHTML = `
      <td class="p-2 font-medium">${u.name || ""}</td>
      <td class="p-2">${u.email || ""}</td>
      <td class="p-2">${u.phone || ""}</td>
      <td class="p-2">${fmtDate(u.created_at)}</td>
      <td class="p-2">${statusPill}</td>
      <td class="p-2">${u.credits ?? 0}</td>
      <td class="p-2">
        <div class="flex items-center gap-2 flex-wrap">
          <button data-act="toggle" data-id="${u.user_id}" data-approved="${u.approved}"
            class="px-2 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700">
            ${u.approved ? "Unapprove" : "Approve"}
          </button>

          <input data-act="delta" data-id="${u.user_id}"
            class="w-24 border rounded px-2 py-1 text-xs" placeholder="+credits" />

          <button data-act="add" data-id="${u.user_id}"
            class="px-2 py-1 rounded bg-gray-200 text-xs hover:bg-gray-300">
            Add
          </button>
        </div>
      </td>
    `;
    usersTbody.appendChild(tr);
  }
}

async function loadUsers() {
  usersErr.classList.add("hidden");
  const data = await api("/api/admin/users", { method: "GET" });
  allUsers = data.users || [];
  applyFilter();
}

function applyFilter() {
  const q = (searchBox.value || "").toLowerCase().trim();
  if (!q) return renderUsers(allUsers);

  const filtered = allUsers.filter((u) => {
    const s = `${u.name || ""} ${u.email || ""} ${u.phone || ""}`.toLowerCase();
    return s.includes(q);
  });
  renderUsers(filtered);
}

usersTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.dataset.act;
  const user_id = btn.dataset.id;

  try {
    if (act === "toggle") {
      const approved = btn.dataset.approved === "true";
      await api("/api/admin/approve", {
        method: "POST",
        body: JSON.stringify({ user_id, approved: !approved }),
      });
      await loadUsers();
    }

    if (act === "add") {
      const input = usersTbody.querySelector(`input[data-act="delta"][data-id="${user_id}"]`);
      const delta = Number(input?.value || 0);
      if (!Number.isFinite(delta) || delta === 0) return;

      await api("/api/admin/credits", {
        method: "POST",
        body: JSON.stringify({ user_id, delta }),
      });
      input.value = "";
      await loadUsers();
    }
  } catch (err) {
    usersErr.textContent = err.message || String(err);
    usersErr.classList.remove("hidden");
  }
});

refreshBtn.onclick = () => loadUsers();
searchBox.oninput = () => applyFilter();

logoutBtn.onclick = () => {
  clearToken();
  showLogin();
};

adminLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErr.classList.add("hidden");

  try {
    const email = adminLoginEmail.value.trim();
    const password = adminLoginPassword.value;

    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Admin login failed");

    setToken(data.token);
    localStorage.setItem("admin_email", data.adminEmail || email);

    showUsers();
    await loadUsers();
  } catch (err) {
    loginErr.textContent = err.message || String(err);
    loginErr.classList.remove("hidden");
  }
});

(async function boot() {
  if (!getToken()) return showLogin();
  showUsers();
  try {
    await loadUsers();
  } catch {
    clearToken();
    showLogin();
  }
})();
