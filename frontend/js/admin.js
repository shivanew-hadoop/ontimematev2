// frontend/js/admin.js

//---------------------------------------------------
// DOM
//---------------------------------------------------
const userTableBody = document.getElementById("userTableBody");
const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");
const adminEmailBox = document.getElementById("adminEmail");

//---------------------------------------------------
// Load admin session
//---------------------------------------------------
const session = JSON.parse(localStorage.getItem("session") || "{}");

if (!session?.is_admin) {
  window.location.href = "/auth?tab=login";
}

adminEmailBox.textContent = session?.user?.email || "";

//---------------------------------------------------
// Fetch all users
//---------------------------------------------------
async function loadUsers() {
  try {
    userTableBody.innerHTML = `<tr><td colspan="6">Loading...</td></tr>`;

    const res = await fetch(`/api/admin/users`);
    const data = await res.json();

    if (!data?.users) {
      userTableBody.innerHTML = `<tr><td colspan="6">No users found.</td></tr>`;
      return;
    }

    renderUsers(data.users);

  } catch (err) {
    userTableBody.innerHTML = `<tr><td colspan="6">Error loading users</td></tr>`;
    console.error(err);
  }
}

//---------------------------------------------------
// Render rows
//---------------------------------------------------
function renderUsers(users) {
  if (!users.length) {
    userTableBody.innerHTML = `<tr><td colspan="6">No users found.</td></tr>`;
    return;
  }

  userTableBody.innerHTML = "";

  users.forEach((u) => {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${u.name || "-"}</td>
      <td>${u.email}</td>
      <td>${u.phone || "-"}</td>
      <td>${formatDate(u.created_at)}</td>
      <td>${u.approved ? "Approved" : "Pending"}</td>
      <td>${u.credits}</td>

      <td>
        <button class="btnApprove" data-id="${u.id}" data-status="${!u.approved}">
          ${u.approved ? "Reject" : "Approve"}
        </button>
      </td>

      <td>
        <input type="number" class="creditInput" placeholder="Add" style="width:70px;" data-id="${u.id}">
        <button class="btnAddCredits" data-id="${u.id}">Add</button>
      </td>
    `;

    userTableBody.appendChild(tr);
  });

  attachHandlers();
}

//---------------------------------------------------
// Approve / Reject / Add Credits Handlers
//---------------------------------------------------
function attachHandlers() {
  document.querySelectorAll(".btnApprove").forEach((btn) => {
    btn.onclick = async () => {
      const user_id = btn.dataset.id;
      const approved = btn.dataset.status === "true";

      await approveUser(user_id, approved);
      loadUsers();
    };
  });

  document.querySelectorAll(".btnAddCredits").forEach((btn) => {
    btn.onclick = async () => {
      const user_id = btn.dataset.id;
      const input = document.querySelector(`input.creditInput[data-id="${user_id}"]`);
      const amount = Number(input.value);

      if (!amount || isNaN(amount)) {
        alert("Enter a valid number");
        return;
      }

      await addCredits(user_id, amount);
      loadUsers();
    };
  });
}

//---------------------------------------------------
// Approve / Reject API
//---------------------------------------------------
async function approveUser(user_id, approved) {
  await fetch(`/api/admin/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": session.token },
    body: JSON.stringify({ user_id, approved })
  });
}

//---------------------------------------------------
// Add credits API
//---------------------------------------------------
async function addCredits(user_id, amount) {
  await fetch(`/api/admin/credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": session.token },
    body: JSON.stringify({ user_id, delta: amount })
  });
}

//---------------------------------------------------
// Date Format
//---------------------------------------------------
function formatDate(dt) {
  if (!dt) return "-";
  const d = new Date(dt);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

//---------------------------------------------------
// Buttons
//---------------------------------------------------
refreshBtn.onclick = loadUsers;

logoutBtn.onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth?tab=login";
};

//---------------------------------------------------
// INIT
//---------------------------------------------------
loadUsers();
