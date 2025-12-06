// frontend/js/admin.js

const session = JSON.parse(localStorage.getItem("session"));
const token = session?.token || session?.session_token;

if (!session || !session.is_admin) {
  window.location.href = "/auth";
}

// --------------------------------------
// LOAD ADMIN INFO
// --------------------------------------
document.getElementById("adminInfo").innerHTML =
  `Logged in as: <b>${session.user.email}</b> (Admin)`;

// --------------------------------------
// LOGOUT
// --------------------------------------
document.getElementById("logoutBtn").onclick = () => {
  localStorage.removeItem("session");
  window.location.href = "/auth";
};

// --------------------------------------
// LOAD USERS
// --------------------------------------
async function loadUsers() {
  const res = await fetch("/api/admin/list", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json();
  const tbody = document.getElementById("userTable");
  tbody.innerHTML = "";

  if (!data.users || data.users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-3 text-center text-gray-500">No users found</td></tr>`;
    return;
  }

  data.users.forEach(u => {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td class="border p-2">${u.name}</td>
      <td class="border p-2">${u.email}</td>
      <td class="border p-2">${u.phone || "-"}</td>
      <td class="border p-2">${u.approved ? "Yes" : "No"}</td>
      <td class="border p-2">${u.credits}</td>
      <td class="border p-2">${u.created_at?.slice(0, 10)}</td>
      <td class="border p-2 space-x-2">

        <button class="px-2 py-1 bg-blue-600 text-white text-xs rounded"
            onclick="approveUser('${u.id}', ${!u.approved})">
          ${u.approved ? "Unapprove" : "Approve"}
        </button>

        <button class="px-2 py-1 bg-green-600 text-white text-xs rounded"
            onclick="addCredits('${u.id}')">
          + Credits
        </button>

        <button class="px-2 py-1 bg-red-600 text-white text-xs rounded"
            onclick="deductCredits('${u.id}')">
          - Credits
        </button>

      </td>
    `;

    tbody.appendChild(row);
  });
}

loadUsers();

// --------------------------------------
// APPROVE USER
// --------------------------------------
async function approveUser(user_id, approved) {
  await fetch("/api/admin/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ user_id, approved })
  });

  loadUsers();
}

// --------------------------------------
// ADD CREDITS
// --------------------------------------
async function addCredits(user_id) {
  const amt = prompt("Enter credits to add:");
  if (!amt) return;

  await fetch("/api/admin/credits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ user_id, delta: Number(amt) })
  });

  loadUsers();
}

// --------------------------------------
// DEDUCT CREDITS
// --------------------------------------
async function deductCredits(user_id) {
  const amt = prompt("Enter credits to deduct:");
  if (!amt) return;

  await fetch("/api/admin/credits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ user_id, delta: -Number(amt) })
  });

  loadUsers();
}
