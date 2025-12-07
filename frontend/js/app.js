// frontend/js/admin.js
// Admin panel uses admin token stored in localStorage.session.token (ADMIN::...)
// Endpoints (merged):
// GET  /api/admin/users
// POST /api/admin/approve
// POST /api/admin/credits

const logoutBtn = document.getElementById("logoutBtn");
const adminEmailEl = document.getElementById("adminEmail");
const usersTbody = document.getElementById("usersTbody");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const statusMsg = document.getElementById("statusMsg");

let session = null;
let allUsers = [];

function setMsg(text, isError = false) {
  if (!statusMsg) return;
  statusMsg.textContent = text || "";
  statusMsg.className = isError
    ? "text-sm text-red-700"
    : "text-sm text-gray-700";
}

function fmtYMD(dateStr) {
  try {
    const d = new Date(dateStr);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return "";
  }
}

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

function ensureAdmin() {
  session = getSession();
  if (!session || !session.is_admin || !session.token) {
    window.location.href = "/auth?tab=login";
    return false;
  }
  return true;
}

async function apiAdmin(path, method = "GET", body = null) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  headers["Authorization"] = `Bearer ${session.token}`;

  const res = await fetch(`/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

function rowHtml(u) {
  const approved = !!u.approved;
  const credits = Number(u.credits ?? 0);
  const created = u.created_at ? fmtYMD(u.created_at) : "";

  const approveBtn = approved
    ? `<button class="px-2 py-1 text-xs rounded bg-gray-200" data-act="disapprove" data-id="${u.id}">Approved</button>`
    : `<button class="px-2 py-1 text-xs rounded bg-green-600 text-white" data-act="approve" data-id="${u.id}">Approve</button>`;

  return `
    <tr class="border-b">
      <td class="p-2">${u.name || ""}</td>
      <td class="p-2">${u.email || ""}</td>
      <td class="p-2">${u.phone || ""}</td>
      <td class="p-2">${created}</td>
      <td class="p-2">${approved ? "approved" : "pending"}</td>
      <td class="p-2"><b>${credits}</b></td>
      <td class="p-2">${approveBtn}</td>
      <td class="p-2">
        <div class="flex gap-2 items-center">
          <input class="border px-2 py-1 text-xs w-24" placeholder="+100" data-credit-input="${u.id}" />
          <button class="px-2 py-1 text-xs rounded bg-blue-600 text-white" data-act="addcredits" data-id="${u.id}">Add</button>
        </div>
      </td>
    </tr>
  `;
}

function renderUsers(list) {
  if (!usersTbody) return;
  if (!list.length) {
    usersTbody.innerHTML = `<tr><td class="p-3 text-sm text-gray-600" colspan="8">No users</td></tr>`;
    return;
  }
  usersTbody.innerHTML = list.map(rowHtml).join("");
}

function filteredUsers() {
  const q = (searchInput?.value || "").toLowerCase().trim();
  if (!q) return allUsers;

  return allUsers.filter(u => {
    const s = `${u.name || ""} ${u.email || ""} ${u.phone || ""}`.toLowerCase();
    return s.includes(q);
  });
}

async function loadUsers() {
  setMsg("Loading users...");
  const out = await apiAdmin("admin/users", "GET");
  allUsers = out.users || [];
  renderUsers(filteredUsers());
  setMsg(`Loaded ${allUsers.length} users`);
}

async function doApprove(userId, approved) {
  setMsg("Updating approval...");
  await apiAdmin("admin/approve", "POST", { user_id: userId, approved });
  await loadUsers();
  setMsg("Updated");
}

async function doAddCredits(userId, delta) {
  setMsg("Updating credits...");
  await apiAdmin("admin/credits", "POST", { user_id: userId, delta });
  await loadUsers();
  setMsg("Updated");
}

function wireTableActions() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.getAttribute("data-act");
    const id = btn.getAttribute("data-id");

    try {
      if (act === "approve") {
        await doApprove(id, true);
      } else if (act === "disapprove") {
        await doApprove(id, false);
      } else if (act === "addcredits") {
        const input = document.querySelector(`input[data-credit-input="${id}"]`);
        const val = (input?.value || "").trim();
        const n = Number(val);
        if (!Number.isFinite(n)) return setMsg("Enter a number in Add Credits box", true);
        await doAddCredits(id, n);
        if (input) input.value = "";
      }
    } catch (err) {
      setMsg(err?.message || String(err), true);
    }
  });
}

async function logout() {
  clearSession();
  window.location.href = "/auth?tab=login";
}

refreshBtn?.addEventListener("click", () => loadUsers().catch(e => setMsg(e.message, true)));
searchInput?.addEventListener("input", () => renderUsers(filteredUsers()));
logoutBtn?.addEventListener("click", logout);

window.addEventListener("load", async () => {
  if (!ensureAdmin()) return;

  if (adminEmailEl) adminEmailEl.textContent = (session?.user?.email || "");
  wireTableActions();

  try {
    await loadUsers();
  } catch (e) {
    setMsg(e.message, true);
    renderUsers([]);
  }
});
