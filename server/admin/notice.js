// Remove the notice query parameter after a form submission and dismiss the notice after six seconds.

const notice = document.querySelector(".notice");
if (notice) {
  const url = new URL(window.location.href);
  url.searchParams.delete("notice");
  window.history.replaceState(null, "", url);
  window.setTimeout(() => notice.remove(), 6000);
}
