// Defines the recurring Careers at Bond article for the automatic delivery worker.

import { readFileSync } from "node:fs";
import { staffNewsTimeZone } from "../dist/core/preset.js";
import { linkDestination } from "../dist/core/sharepoint.js";

export const weekdays = Object.freeze([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);
export const defaultCareersDay = "Wednesday";

const brisbaneWeekday = new Intl.DateTimeFormat("en-AU", {
  weekday: "long",
  timeZone: staffNewsTimeZone,
});
const articleUrl = new URL(
  "https://bonduni.sharepoint.com/sites/ShowcaseNews/SitePages/Careers-at-Bond(3).aspx",
);
const articlePath = articleUrl.pathname.toLowerCase();
const careersArticle = {
  title: "Careers at Bond",
  href: articleUrl.href,
  summary:
    "Looking for a new position? We are currently recruiting for a number of roles across campus.",
  author: "Annelize Oosthuizen",
  date: "25/01/2026",
  image: {
    kind: "inline",
    type: "image/png",
    bytes: readFileSync(new URL("./assets/careers-at-bond.png", import.meta.url)),
  },
};

// Identify an existing copy by its SharePoint page, including Safe Links and encoded parentheses.
function isCareersArticle({ href }) {
  const { hostname, pathname } = new URL(linkDestination(href));
  const path = pathname.replaceAll("%28", "(").replaceAll("%29", ")").toLowerCase();
  return hostname === articleUrl.hostname && path === articlePath;
}

// On the configured Brisbane weekday, replace any copy in the digest and put the standard article
// last.
export function appendCareersArticle(articles, date, day) {
  if (brisbaneWeekday.format(date) !== day) return articles;
  return [...articles.filter((article) => !isCareersArticle(article)), careersArticle];
}
