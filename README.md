# ZPS Course Search

Tampermonkey userscript that adds full-text search to Zero Point Security course players.

Zero Point Security courses contain 160+ units across 20+ modules, but the LearnWorlds platform provides no search functionality. Finding a specific command, technique, or concept means manually clicking through modules. Lab instructions are locked behind SCORM iframes and not searchable at all. This script fixes that.

The course material doubles as a reference during real engagements, but finding a specific command, technique, or code snippet across 160+ units is impractical without search. This tool makes the course material usable as a day-to-day reference, not just a learning path.

![Search results](screenshots/search-results.png)

## Features

- Full-text search across ebook prose, code blocks, lab markdown, and discussion comments
- Lab markdown rendered inline with a preview panel (lab content is normally only visible after launching a lab)
- Scope toggles for prose, lines, code, labs, and discussions
- Exact phrase and fuzzy matching with whitespace-flexible search
- Multi-hit highlighting with per-occurrence navigation
- Suppress "Leave site?" dialog toggle for faster browsing between lab units
- Per-course cache (index once, search instantly)

![Lab preview](screenshots/lab-preview.png)

## Compatibility

Tested extensively on Chrome with Tampermonkey. Should work in Firefox with Tampermonkey or Violentmonkey.

The script only reads course content that is already accessible to enrolled students. It does not modify any data, send external requests, or interact with anything beyond the course player DOM.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge) or [Violentmonkey](https://violentmonkey.github.io/) (Firefox)
2. Open `course-search.user.js` in this repository and click "Raw" to trigger the extension install prompt
3. Confirm the installation in the extension dialog

## Usage

1. Open any Zero Point Security course player page
2. Click the "Search" tab in the left sidebar
3. Click "Index" once to build the search cache (takes 15-40 seconds depending on concurrency settings)
4. Search for any keyword, command, or phrase

Results are grouped by module and unit. Click any result to navigate to that unit with the match highlighted. Use the scope toggles to filter by content type (prose, code blocks, labs, discussions).

## Roadmap

- Search through highlights
- Search through notes and bookmarks
- Export search results

## Support

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/payloadforge)

## Licence

[MIT](LICENSE)
