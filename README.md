# Natter AI Bot - Connected Frontend

This version is already configured to call the deployed backend:
https://ai-8vlt.onrender.com

Upload these files to the ROOT of your GitHub Pages repository:
- index.html
- manifest.webmanifest
- sw.js
- icon.svg

Do not put an API key in this frontend.

After GitHub Pages updates, open the site in Safari and use Share -> Add to Home Screen.

## Working on the site

- `index.html` is the page markup, `css/app.css` the styles and `js/app.js` the app code.
  The script is a classic script loaded at the end of the page, so every element it looks
  up must sit **above** `<script src="./js/app.js">`.
- Before deploying, run `python bump-version.py` so browsers and the service worker pick
  up the new files.
- Every push runs `tests/smoke.mjs` in a real browser (GitHub Actions, "Smoke test").
  If it fails, GitHub emails the repo owner. Run it locally with
  `npm i -D playwright && npx playwright install chromium && node tests/smoke.mjs`.
