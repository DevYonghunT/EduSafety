const form = document.querySelector("#login-form");
const errorElement = document.querySelector("#login-error");
const button = document.querySelector("#login-submit");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorElement.textContent = "";
  button.disabled = true;
  const data = new FormData(form);
  try {
    const response = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "로그인하지 못했습니다.");
    location.assign("/admin/certification");
  } catch (error) { errorElement.textContent = error instanceof Error ? error.message : "로그인하지 못했습니다."; }
  finally { button.disabled = false; }
});
