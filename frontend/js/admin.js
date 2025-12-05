// Load admin token
const adminToken = localStorage.getItem("adminToken");
if (!adminToken) {
  window.location.href = "/auth";
}

const usersGrid = document.getElementById("usersGrid");

// Fetch users
async function loadUsers() {
  const res = await fetch("/api/admin/users", {
    headers: { "authorization": `Bearer ${adminToken}` }
  });

  const users = await res.json();

  usersGrid.innerHTML = "";

  users.forEach(user => {
    const card = document.createElement("div");
    card.className =
      "bg-white p-5 rounded-xl shadow-md border border-gray-200";

    card.innerHTML = `
      <h3 class="text-lg font-semibold text-gray-800">${user.name || "No Name"}</h3>
      <p class="text-gray-600 text-sm mt-1"><strong>Email:</strong> ${user.email}</p>
      <p class="text-gray-600 text-sm"><strong>Phone:</strong> ${user.phone || "N/A"}</p>
      <p class="text-gray-600 text-sm"><strong>Registered:</strong> ${user.created_at}</p>

      <p class="mt-3 text-sm">
        <strong>Status:</strong>
        <span class="px-2 py-1 rounded text-white text-xs ${
          user.status === "approved" ? "bg-green-500" : "bg-yellow-500"
        }">
          ${user.status}
        </span>
      </p>

      ${
        user.status !== "approved"
          ? `<button class="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded approveBtn"
              data-id="${user.id}">
              Approve
            </button>`
          : `<button disabled class="mt-4 w-full bg-gray-400 text-white py-2 rounded">
              Approved
            </button>`
      }
    `;

    usersGrid.appendChild(card);
  });

  // Attach approve handlers
  document.querySelectorAll(".approveBtn").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");

      const res = await fetch("/api/admin/approve", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${adminToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id })
      });

      loadUsers();
    };
  });
}

// Logout
document.getElementById("logoutBtn").onclick = () => {
  localStorage.removeItem("adminToken");
  window.location.href = "/auth";
};

// Load data initially
loadUsers();
