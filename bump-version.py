"""
Bumps the app version everywhere it appears in index.html.

    python bump-version.py            -> next build today, e.g. 2026-09-22-27
    python bump-version.py 2026-10-01-1

The version busts the browser and service worker caches, so
run this before every deploy that changes the site.
"""
import re, sys, datetime, pathlib

page = pathlib.Path(__file__).with_name('index.html')
html = page.read_text(encoding='utf-8')

current = re.search(r"window\.NASTIVEE_VERSION = '([^']+)'", html).group(1)

if len(sys.argv) > 1:
    new = sys.argv[1]
else:
    today = datetime.date.today().isoformat()
    day, build = current.rsplit('-', 1)
    new = f"{today}-{int(build) + 1 if day == today else 1:02d}"

html = html.replace(current, new)
page.write_text(html, encoding='utf-8')
print(f'{current} -> {new}')
