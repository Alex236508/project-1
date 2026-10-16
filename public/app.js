
const form = document.querySelector("#upload-form");
const input = document.querySelector("#project-file");
const notice = document.querySelector("#notice");
const button = document.querySelector("#deploy-button");
const list = document.querySelector("#deployments");

function message(text, error = false) {
  notice.textContent = text;
  notice.hidden = false;
  notice.classList.toggle("error", error);
}

input.addEventListener("change", () => {
  const file = input.files[0];
  if (!file) return;

  document.querySelector("#file-name").textContent = file.name;
  document.querySelector("#file-info").textContent =
    `${(file.size / 1024 / 1024).toFixed(2)} MB selected`;
});

form.addEventListener("submit", async event => {
  event.preventDefault();

  const file = input.files[0];
  if (!file) return message("Choose a ZIP file first.", true);
  if (!file.name.toLowerCase().endsWith(".zip")) {
    return message("Only ZIP files are supported.", true);
  }

  const data = new FormData();
  data.append("project", file);

  button.disabled = true;
  button.textContent = "Deploying…";
  message("Uploading and starting your deployment. This can take a few minutes.");

  try {
    const response = await fetch("/api/deployments", {
      method: "POST",
      body: data
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || "Deployment failed.");

    message(`Deployment created for "${result.name}". Refresh the list to check status.`);
    form.reset();
    document.querySelector("#file-name").textContent = "Choose a project ZIP";
    document.querySelector("#file-info").textContent =
      "Click here to browse · Maximum 20 MB";
    await refreshDeployments();
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Deploy project ↗";
  }
});

async function refreshDeployments() {
  try {
    const response = await fetch("/api/deployments");
    const items = await response.json();
    list.replaceChildren();

    if (!items.length) {
      list.textContent = "No deployments yet. Upload a ZIP to get started.";
      list.className = "muted";
      return;
    }

    list.className = "";

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "deployment";

      const info = document.createElement("div");
      info.className = "deployment-info";

      const name = document.createElement("strong");
      name.textContent = item.name;

      const detail = document.createElement("small");
      detail.textContent = item.message || item.status;
      info.append(name, detail);

      const state = document.createElement("span");
      state.className = "state" + (item.status === "failed" ? " failed" : "");
      state.textContent = item.status;

      const actions = document.createElement("div");

      if (item.url) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open app";
        link.style.marginRight = "12px";
        actions.append(link);
      }

      const remove = document.createElement("button");
      remove.className = "delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete "${item.name}"?`)) return;

        const result = await fetch(
          `/api/deployments/${encodeURIComponent(item.id)}`,
          { method: "DELETE" }
        );

        if (result.ok) refreshDeployments();
        else message("Could not delete deployment.", true);
      });

      actions.append(remove);
      row.append(info, state, actions);
      list.append(row);
    }
  } catch {
    list.textContent = "Could not load deployments. Is the backend running?";
  }
}

document.querySelector("#refresh").addEventListener("click", refreshDeployments);
refreshDeployments();
