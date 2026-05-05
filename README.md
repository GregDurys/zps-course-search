# ZPS Course Search

Tampermonkey userscript that adds full-text search to Zero Point Security course players.

The LearnWorlds platform used by Zero Point Security ships no in-course search. Finding a specific command, technique, or concept means manually clicking through modules one by one. Lab instructions are locked behind SCORM iframes and not searchable at all. This script injects a Search tab next to Path and Discuss in the course player sidebar and indexes every unit, making any keyword or phrase findable across the whole course from one place.

![Search tab](screenshots/search-empty.png)

## Features

- Full-text search across ebook prose, code blocks, lab markdown, discussion comments, and unit titles
- Individually toggleable scope filters via the toolbar (prose, lines, code, labs, discussions)
- Discussion search indexes all student and staff comments from the Discuss tab, including author names. Clicking a discuss result switches to the Discuss tab, expands collapsed reply threads, and highlights the matching comment
- Exact phrase or fuzzy mode (~) with whitespace-flexible matching that tolerates curly quotes, en-dashes, non-breaking spaces, and zero-width characters injected by the LearnWorlds renderer
- Multi-hit highlighting with one result row per occurrence and separate navigation between matches
- Lab markdown fetched via the attachment-unlock API during indexing and rendered inline with a preview panel. Lab content is normally only visible after launching a lab
- "Suppress Leave site? prompts" toggle silences the SCORM beforeunload dialog when navigating between lab units. Recommended on for speed-skimming, off when actually solving labs
- Per-course cache keyed by the courseid query parameter. Course switching does not require re-indexing

![Search results](screenshots/search-results.png)

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
3. Click "Index" once to build the search cache
4. Search for any keyword, command, or phrase

Results are grouped by module and unit. Click any result to navigate to that unit with the match highlighted. Use the scope toggles to filter by content type.

The course material is a valuable reference during real engagements, but looking up a specific technique or code snippet across dozens of modules is impractical without search. This tool makes the course material usable as a day-to-day reference, not just a learning path.

![Lab preview](screenshots/lab-preview.png)

## Todo

- Search through highlights
- Search through notes
- Export search results

## Support

If you find this useful, consider buying me a coffee.

<a href="https://buymeacoffee.com/payloadforge" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Licence

[MIT](LICENSE)
