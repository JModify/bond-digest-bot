const notice = document.querySelector(".notice");
if (notice) {
  const url = new URL(window.location.href);
  url.searchParams.delete("notice");
  window.history.replaceState(null, "", url);
  window.setTimeout(() => notice.remove(), 6000);
}
