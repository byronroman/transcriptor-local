import { initApp } from "./bootstrap.js";

initApp().catch((error) => {
  const statusLine = document.getElementById("statusLine");
  if (statusLine) statusLine.textContent = visibleErrorMessage(error);
});
