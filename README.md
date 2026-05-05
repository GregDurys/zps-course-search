# ZPS Course Search

Tampermonkey userscript that adds full-text search to Zero Point Security course players.

The LearnWorlds platform used by Zero Point Security ships no in-course search. Finding a specific command, technique, or concept means manually clicking through modules one by one. Lab instructions are locked behind SCORM iframes and not searchable at all. This script injects a Search tab next to Path and Discuss in the course player sidebar and indexes every unit, making any keyword or phrase findable across the whole course from one place.

The course material is a valuable reference during real engagements, but looking up a specific technique or code snippet across dozens of modules is impractical without search. This tool makes the course material usable as a day-to-day reference, not just a learning path.

<img src="screenshots/search-empty.png" alt="Search tab" width="380">

## Features

### Scope toggles

Each scope can be toggled independently via the toolbar. Only enabled scopes are searched and indexed.

| Icon | Scope | Description | Default |
|------|-------|-------------|---------|
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M6.941 3.952c-.459-1.378-2.414-1.363-2.853.022l-4.053 12.8a.75.75 0 001.43.452l1.101-3.476h6.06l1.163 3.487a.75.75 0 101.423-.474l-4.27-12.81zm1.185 8.298L5.518 4.427 3.041 12.25h5.085zm6.198-5.537a4.74 4.74 0 013.037-.081A3.743 3.743 0 0120 10.208V17a.75.75 0 01-1.5 0v-.745a7.971 7.971 0 01-2.847 1.355 2.998 2.998 0 01-3.15-1.143C10.848 14.192 12.473 11 15.287 11H18.5v-.792c0-.984-.641-1.853-1.581-2.143a3.24 3.24 0 00-2.077.056l-.242.089a2.222 2.222 0 00-1.34 1.382l-.048.145a.75.75 0 01-1.423-.474l.048-.145a3.722 3.722 0 012.244-2.315l.243-.09zM18.5 12.5h-3.213c-1.587 0-2.504 1.801-1.57 3.085.357.491.98.717 1.572.57a6.47 6.47 0 002.47-1.223l.741-.593V12.5z" fill="currentColor"/></svg> | Title | Unit titles and section headings | On |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M3 5h14M3 9h14M3 13h10M3 17h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> | Body text | Ebook prose and paragraph content | Off |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M7 15L2 10l5-5M13 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> | Code | Code blocks and inline code | Off |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path d="M8.571 12h6.857m-6.857 4.572h6.857m2.286 5.714H6.286A2.286 2.286 0 014 20V4a2.286 2.286 0 012.286-2.285h6.383c.304 0 .594.12.808.335l6.188 6.187c.214.214.335.505.335.808V20a2.285 2.285 0 01-2.286 2.286z" fill="none" stroke="currentColor" stroke-width="1.929" stroke-linecap="round" stroke-linejoin="round"/></svg> | Labs | Lab markdown files fetched via the attachment-unlock API | Off |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.862 9.862 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> | Discussions | Student and staff comments from the Discuss tab | Off |

### Search modes

| Mode | How to use | Description |
|------|-----------|-------------|
| Exact | Type normally | Matches the exact phrase, flexible on whitespace and special characters |
| Fuzzy | Prefix with `~` | Matches words in any order within a paragraph. Tolerates curly quotes, en-dashes, non-breaking spaces, and zero-width characters injected by the LearnWorlds renderer |

### Additional toolbar controls

| Icon | Name | Description |
|------|------|-------------|
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M2 10c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> | Fuzzy toggle | Switch between exact and fuzzy search mode |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> | Clear | Clear the search query and results |
| <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M10 3c-2 0-4 2-4 4v3l-1 1h10l-1-1V7c0-2-2-4-4-4zM8 14h4M3 3l14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> | Suppress prompts | Silences the "Leave site?" beforeunload dialog when navigating between lab units. Recommended on for speed-skimming, off when solving labs |

### Other features

- Multi-hit highlighting: long bodies, code blocks, and discussions emit one result row per occurrence with separate navigation between matches
- Clicking a discuss result switches to the Discuss tab, expands collapsed reply threads, and highlights the matching comment
- Lab markdown rendered inline with a preview panel. Lab content is normally only visible after launching a lab
- Per-course cache keyed by the courseid query parameter. Course switching does not require re-indexing
- Active selection indicator on clicked search results

<img src="screenshots/search-results.png" alt="Search results" width="380">

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

<img src="screenshots/lab-preview.png" alt="Lab preview" width="600">

## Indexing

During indexing, the script makes the following requests to build the search cache. All requests use the same authentication as normal course browsing.

| Content type | Endpoint | Requests | Notes |
|-------------|----------|----------|-------|
| Ebook units | GET per unit page | ~135 | Fetches rendered HTML |
| Discussion comments | GET /api/posts per unit | ~164 | Returns all posts for a unit in a single call |
| Lab markdown | GET /api/unlock/attachment per SCORM unit | ~22 | Fetches .md files via signed Azure Blob URLs |

Request counts are approximate and depend on the course. Concurrency and delay between requests are configurable at the top of the script.

## Todo

- Search through highlights
- Search through notes
- Export search results

## Support

If you find this useful, consider buying me a coffee.

<a href="https://buymeacoffee.com/payloadforge" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## Licence

[MIT](LICENSE)
