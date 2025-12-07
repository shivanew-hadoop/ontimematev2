// frontend/js/admin.js

const logoutBtn = document.getElementById("logoutBtn");
const adminEmailEl = document.getElementById("adminEmail");
const usersTbody = document.getElementById("usersTbody");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const statusMsg = document.getElementById("statusMsg");

let session = null;
let token = "";
let allUsers = [];

function getSession() {
  try { return JSON.parse(localStorage.getItem("session") || "null"); }
  catch { return null; }
}

function setMsg(text, isError = false) {
  if (!statusMsg) return;
  statusMsg.textContent = text || "";
  statusMsg.className = isError ? "text-sm text-red-700 mb-4" : "text-sm text-gray-700 mb-4";
}

function fmtYMD(dateStr) {
  try {
    const d = new Date(dateStr);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch { return ""; }
}

function ensureAdmin() {
  session = getSession();
  token = session?.token || "";

  if (!session || !session.is_admin || !token) {
    window.location.href = "/auth?tab=login";
    return false;
  }
  return true;
}

async function apiAdmin(path, method = "GET", body = null) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

function filteredUsers() {
  const q = (searchInput?.value || "").toLowerCase().trim();
  if (!q) return allUsers;
  return allUsers.filter(u => (`${u.name||""} ${u.email||""} ${u.phone||""}`).toLowerCase().includes(q));
}

function rowHtml(u) {
  const approved = !!u.approved;
  const credits = Number(u.credits ?? 0);
  const created = u.created_at ? fmtYMD(u.created_at) : "";

  const approveBtn = approved
    ? `<button class="px-2 py-1 text-xs rounded bg-gray-200" data-act="approve" data-id="${u.id}" data-approved="false">Approved</button>`
    : `<button class="px-2 py-1 text-xs rounded bg-green-600 text-white" data-act="approve" data-id="${u.id}" data-approved="true">Approve</button>`;

  return `
    <tr class="border-b">
      <td class="p-2 border">${u.name || ""}</td>
      <td class="p-2 border">${u.email || ""}</td>
      <td class="p-2 border">${u.phone || "-"}</td>
      <td class="p-2 border">${created}</td>
      <td class="p-2 border">${approved ? "approved" : "pending"}</td>
      <td class="p-2 border"><b>${credits}</b></td>
      <td class="p-2 border">${approveBtn}</td>
      <td class="p-2 border">
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
    usersTbody.innerHTML = `<tr><td colspan="8" class="p-3 text-center text-gray-500">No users found</td></tr>`;
    return;
  }
  usersTbody.innerHTML = list.map(rowHtml).join("");
}

async function loadUsers() {
  setMsg("Loading users...");
  const out = await apiAdmin("admin/users", "GET");
  allUsers = out.users || [];
  renderUsers(filteredUsers());
  setMsg(`Loaded ${allUsers.length} users`);
}

async function doApprove(user_id, approved) {
  setMsg("Updating approval...");
  await apiAdmin("admin/approve", "POST", { user_id, approved });
  await loadUsers();
  setMsg("Updated");
}

async function doAddCredits(user_id, delta) {
  setMsg("Updating credits...");
  await apiAdmin("admin/credits", "POST", { user_id, delta });
  await loadUsers();
  setMsg("Updated");
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;

  const act = btn.getAttribute("data-act");
  const id = btn.getAttribute("data-id");

  try {
    if (act === "approve") {
      const approved = btn.getAttribute("data-approved") === "true";
      await doApprove(id, approved);
    }

    if (act === "addcredits") {
      const input = document.querySelector(`input[data-credit-input="${id}"]`);
      const val = (input?.value || "").trim();
      const n = Number(val);
      if (!Number.isFinite(n)) return setMsg("Enter numeric credits like 100 or -50", true);
      await doAddCredits(id, n);
      if (input) input.value = "";
    }
  } catch (err) {
    setMsg(err?.message || String(err), true);
  }
});

refreshBtn?.addEventListener("click", () => loadUsers().catch(e => setMsg(e.message, true)));
searchInput?.addEventListener("input", () => renderUsers(filteredUsers()));

logoutBtn?.addEventListener("click", () => {
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
});

window.addEventListener("load", async () => {
  if (!ensureAdmin()) return;
  if (adminEmailEl) adminEmailEl.textContent = session?.user?.email || "";
  await loadUsers().catch(e => setMsg(e.message, true));
});
