// ==UserScript==
// @name         ZPS Course Search
// @namespace    zps-course-search
// @version      0.12.3
// @description  Cross-unit full-text search for ZeroPoint Security course players. Adds a Search tab to the sidebar that finds keywords across every ebook unit, code block, lab markdown, and discussion comments. Clicking a result jumps to the unit with the match highlighted.
// @author       gregd
// @match        https://www.zeropointsecurity.co.uk/path-player*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

//
// Purpose
// -------
// LearnWorlds (the platform ZeroPoint use) ships no in-course search. This
// userscript injects a Search tab next to Path/Discuss in the course player
// sidebar and indexes every unit, making any command, keyword, or phrase
// findable across the whole course from one place.
//
// Features
// - Full-text search across ebook prose, code blocks, lab markdown, discussion
//   comments, and unit titles. Scopes toggle individually via the toolbar
//   (Aa / lines / <> / doc / speech-bubble).
// - Discussion search: indexes all student/staff comments from the Discuss tab
//   including author names. Clicking a discuss result switches to the Discuss
//   tab, expands collapsed reply threads, and highlights the matching comment.
// - Exact phrase or fuzzy mode (~) with whitespace-flexible matching that
//   tolerates curly quotes, en-dashes, non-breaking spaces, and zero-width
//   characters injected by the LearnWorlds renderer.
// - Multi-hit highlighting: long bodies, code blocks, and discussions emit one
//   result row per occurrence, with separate navigation between matches.
// - Lab markdown: labs are SCORM units whose .md files are fetched via
//   LearnWorlds' attachment-unlock API during indexing. No separate button
//   or navigation required - lab content is indexed alongside ebook and
//   discussion content in a single pass.
// - "Suppress Leave site? prompts" toggle (bell icon): silences the SCORM
//   beforeunload dialog when navigating between lab units. Default off;
//   recommended on for speed-skimming, off when actually solving labs.
// - Per-course cache, keyed by the ?courseid= query parameter. Course
//   switching does not require re-indexing.
//
// Install
// 1. Install Tampermonkey (Chrome/Edge) or Violentmonkey (Firefox).
// 2. Either load this file's URL in the browser, or paste its contents into a
//    new userscript in the extension dashboard.
// 3. Open any ZeroPoint Security course player page. A Search tab will appear
//    in the left sidebar.
// 4. Click "Index" once. Click "Re-index" when course content changes.
//
// Network requests made during indexing
// - Ebook units: one GET per unit to fetch rendered HTML (~135 requests).
// - Discussion comments: one GET /api/posts per unit to fetch all comments
//   (~164 requests). Returns all posts for that unit in a single call.
// - Lab files: one GET /api/unlock/attachment per SCORM unit with a .md
//   attachment (~22 requests) plus one GET to the signed Azure Blob URL
//   per file (~22 requests, ~44 total for labs).
// - Total: approximately 340 requests per full index build. Requests are
//   made with 4 concurrent workers. No navigation or click-tricks required -
//   all fetching is pure async API calls. The index is built once on demand
//   and cached in localStorage.
//
// Notes
// - The script only reads content already visible to a logged-in user. The
//   discussion comments API returns the same data as the Discuss tab renders.
// - The index is stored in browser localStorage. Nothing leaves the browser.
// - Tested on Red Team Operator and RTO II in Chrome and Firefox with
//   Tampermonkey. Other LearnWorlds-hosted courses on the same domain are
//   expected to behave the same way.
//
// Source: https://github.com/GregDurys/zps-course-search
// License: MIT
//

(function () {
    'use strict';

    const TAG = '[CRTOSearch]';
    // Cache schema versioning. v5 (0.9.0) adds discuss field (Discuss tab comments).
    // order rather than pageState-key order so kindIndex from search lines
    // up with the iframe's <pre> walker. Old v3 caches are ignored - users
    // see a "Index" prompt on next search.
    const CACHE_PREFIX = 'crtoSearchIndex.v5.';
    const LEGACY_CACHE_KEY = 'crtoSearchIndex.v2';

    // ---- User-configurable indexing settings ----
    // CONCURRENCY: number of parallel requests during indexing (1-8).
    // Lower = gentler on the server, higher = faster indexing.
    const CONCURRENCY = 4;
    // REQUEST_DELAY_MS: milliseconds to wait between each request during
    // indexing. Set to 0 for fastest indexing, increase if rate-limited.
    // Each worker waits this long after completing a unit before starting
    // the next. Total time scales with (units / CONCURRENCY) * delay.
    const REQUEST_DELAY_MS = 0;
    // -------------------------------------------------

    function getCourseId() {
        try { return new URL(location.href).searchParams.get('courseid') || 'unknown'; }
        catch { return 'unknown'; }
    }
    function cacheKey() { return CACHE_PREFIX + getCourseId(); }

    // Highlight colours (used only on the match marker in the ebook iframe)
    const HL_ORANGE = '#ff7a33';
    const HL_ORANGE_BG = '#ffdcc0';

    // Discuss-toolbar palette (cloned exactly from learnworlds .social-state-btn)
    const ICON_NAVY = 'rgb(39, 39, 64)';
    const ACTIVE_GREY = 'rgb(242, 242, 242)';
    const HOVER_GREY = 'rgb(248, 248, 248)';

    const NOISE = [
        /Exciting News.*?Zero-Point Security.*?join\w+ the Fortra family.*?\./si,
        /Zero-Point Security.*?joined Fortra.*?curriculum\./si,
    ];
    const TYPE_LABEL = {
        pbEbook: 'EBK', legacyUnitPbEbook: 'EBK',
        scorm: 'LAB', legacyUnitScorm: 'LAB',
        video: 'VID', legacyUnitVideo: 'VID',
    };

    // viewBox 0 0 20 20 for every icon (matches Discuss toolbar SVGs)
    const ICONS = {
        title: {
            fill: 'M6.941 3.952c-.459-1.378-2.414-1.363-2.853.022l-4.053 12.8a.75.75 0 001.43.452l1.101-3.476h6.06l1.163 3.487a.75.75 0 101.423-.474l-4.27-12.81zm1.185 8.298L5.518 4.427 3.041 12.25h5.085zm6.198-5.537a4.74 4.74 0 013.037-.081A3.743 3.743 0 0120 10.208V17a.75.75 0 01-1.5 0v-.745a7.971 7.971 0 01-2.847 1.355 2.998 2.998 0 01-3.15-1.143C10.848 14.192 12.473 11 15.287 11H18.5v-.792c0-.984-.641-1.853-1.581-2.143a3.24 3.24 0 00-2.077.056l-.242.089a2.222 2.222 0 00-1.34 1.382l-.048.145a.75.75 0 01-1.423-.474l.048-.145a3.722 3.722 0 012.244-2.315l.243-.09zM18.5 12.5h-3.213c-1.587 0-2.504 1.801-1.57 3.085.357.491.98.717 1.572.57a6.47 6.47 0 002.47-1.223l.741-.593V12.5z',
        },
        content: { stroke: 'M3 5h14M3 9h14M3 13h10M3 17h14' },
        code: { stroke: 'M7 15L2 10l5-5M13 5l5 5-5 5' },
        // Discuss-exact doc icon (from LW's "Attach a file or video" button).
        lab: {
            stroke: 'M8.571 12h6.857m-6.857 4.572h6.857m2.286 5.714H6.286A2.286 2.286 0 014 20V4a2.286 2.286 0 012.286-2.285h6.383c.304 0 .594.12.808.335l6.188 6.187c.214.214.335.505.335.808V20a2.285 2.285 0 01-2.286 2.286z',
            viewBox: '0 0 24 24', strokeWidth: '1.929',
        },
        fuzzy: { stroke: 'M2 10c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2' },
        clear: { stroke: 'M5 5l10 10M15 5L5 15' },
        // Speech bubble with three dots - Discuss tab comments.
        discuss: { stroke: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.862 9.862 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z', viewBox: '0 0 24 24' },
        // Bell outline with a diagonal slash through it - "notifications off".
        suppress: { stroke: 'M10 3c-2 0-4 2-4 4v3l-1 1h10l-1-1V7c0-2-2-4-4-4zM8 14h4M3 3l14 14' },
    };

    const defaultScope = { title: true, content: false, code: false, lab: false, discuss: false };
    let scope;
    try { scope = { ...defaultScope, ...JSON.parse(localStorage.getItem('crtoSearchScope') || '{}') }; }
    catch { scope = { ...defaultScope }; }
    let fuzzy = localStorage.getItem('crtoSearchFuzzy') === '1';

    let crawl = { running: false, cancel: false };
    let statusEl, fillEl, resultsEl, scopeBtns = {}, fuzzyBtn;

    function waitForReady(attempts = 0) {
        const ready = window.coursePlayerVue && window.coursePlayerVue.$store
            && document.querySelector('ul.-first-col-tabs')
            && document.querySelector('.-first-col-tabs-content')
            && document.querySelector('#lpathContents a.lrn-path-cont-link');
        if (ready) init();
        else if (attempts < 120) setTimeout(() => waitForReady(attempts + 1), 500);
        else console.warn(`${TAG} gave up waiting for course player`);
    }

    function init() {
        if (window.__crtoSearchInit) return;
        window.__crtoSearchInit = true;
        migrateLegacyCache();
        purgeStaleCaches();
        injectSearchTab();
        injectSearchPanel();
        wireExistingTabs();
        watchForRerender();
        watchLabAttachments();
        watchIframeForBeforeUnload();
        console.log(`${TAG} v0.9.1 initialised (course: ${getCourseId()})`);
    }

    const getStore = () => window.coursePlayerVue.$store;
    const loadCache = () => { try { return JSON.parse(localStorage.getItem(cacheKey()) || '{}'); } catch { return {}; } };
    const saveCache = (c) => { try { localStorage.setItem(cacheKey(), JSON.stringify(c)); } catch (e) { console.warn(TAG, 'cache save failed:', e); } };

    // Move legacy single-key cache (pre-0.7.9) to per-course storage if the unit
    // IDs substantially match the current course. Runs once per course.
    function migrateLegacyCache() {
        const key = cacheKey();
        if (localStorage.getItem(key)) return;
        const raw = localStorage.getItem(LEGACY_CACHE_KEY);
        if (!raw) return;
        try {
            const legacy = JSON.parse(raw);
            const legacyIds = Object.keys(legacy);
            const currentIds = Object.keys(getStore().state.unitStates || {});
            if (!legacyIds.length || !currentIds.length) return;
            const current = new Set(currentIds);
            const overlap = legacyIds.filter(id => current.has(id)).length;
            if (overlap / legacyIds.length > 0.5) {
                localStorage.setItem(key, raw);
                localStorage.removeItem(LEGACY_CACHE_KEY);
                console.log(`${TAG} migrated legacy cache (${overlap}/${legacyIds.length} units) to ${key}`);
            }
        } catch {}
    }

    // Purge cache schemas older than the current version. Runs once per session.
    // Without this, every cache-schema bump (e.g. v3 -> v4 in 0.8.36) leaves
    // megabytes of orphan localStorage entries that the script will never read
    // again. Anything matching `crtoSearchIndex.*` that does NOT start with the
    // current `CACHE_PREFIX` is removed. The `LEGACY_CACHE_KEY` migration above
    // gets first crack at v2-style entries; whatever it does not migrate is
    // fair game for purge.
    function purgeStaleCaches() {
        const stale = [];
        for (const k of Object.keys(localStorage)) {
            if (!k.startsWith('crtoSearchIndex')) continue;
            if (k.startsWith(CACHE_PREFIX)) continue;
            if (k === LEGACY_CACHE_KEY) continue; // let migrate run first
            stale.push(k);
        }
        if (stale.length === 0) return;
        let bytes = 0;
        for (const k of stale) {
            bytes += (localStorage.getItem(k) || '').length;
            localStorage.removeItem(k);
        }
        console.log(`${TAG} purged ${stale.length} stale cache key(s), freed ${(bytes/1024).toFixed(0)} KB`);
    }

    function el(tag, props = {}, kids = []) {
        const n = document.createElement(tag);
        if (props.class) n.className = props.class;
        if (props.id) n.id = props.id;
        if (props.style) n.style.cssText = props.style;
        if (props.text != null) n.textContent = props.text;
        if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) n.setAttribute(k, v);
        for (const c of kids) if (c) n.appendChild(c);
        return n;
    }
    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    function svgIcon(def) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', def.viewBox || '0 0 20 20');
        svg.setAttribute('xmlns', ns);
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.style.cssText = 'display:block;pointer-events:none;';
        const p = document.createElementNS(ns, 'path');
        if (def.fill) {
            p.setAttribute('d', def.fill);
            p.setAttribute('fill', 'currentColor');
            p.setAttribute('fill-rule', 'evenodd');
        } else {
            p.setAttribute('d', def.stroke);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', 'currentColor');
            p.setAttribute('stroke-width', def.strokeWidth || '1.5');
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
        }
        svg.appendChild(p);
        return svg;
    }

    function findLegacySkin() {
        if (window.__crtoLegacySkin?.$options?.name === 'legacySkin') return window.__crtoLegacySkin;
        for (const e of document.querySelectorAll('[class]')) {
            const v = e.__vue__;
            if (v && 'activeTab' in (v.$data || {})) {
                window.__crtoLegacySkin = v;
                return v;
            }
        }
        return null;
    }
    function setVueActiveTab(t) { const s = findLegacySkin(); if (s) s.activeTab = t; }

    // Normalise typographic characters to ASCII equivalents so a query typed
    // with straight quotes / plain hyphens still matches rendered text that
    // uses curly quotes, en/em dashes, or non-breaking spaces. Every
    // substitution is 1-to-1 so string length (and therefore index offsets)
    // is preserved - callers can map match positions back to the raw text.
    function normChar(s) {
        return (s || '').toLowerCase()
            .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
            .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
            .replace(/[\u2013\u2014\u2015]/g, '-')
            .replace(/[\u00A0\u200B\u200C\u200D\u2060\uFEFF]/g, ' ');
    }
    function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // Turn a normalised phrase into a regex that matches the same tokens
    // separated by any run of whitespace. Lets a single-space query match
    // rendered text that wraps across lines, double-spaces, or splits across
    // inline tags (once the caller inserts separators between text nodes).
    function buildPhraseRegex(normalisedPhrase, flags = 'g') {
        const tokens = (normalisedPhrase || '').trim().split(/\s+/).filter(t => t.length > 0);
        if (!tokens.length) return null;
        return new RegExp(tokens.map(escRe).join('\\s+'), flags);
    }

    // Walk up from a text node until we hit a block-level element. Used to
    // decide whether two adjacent text nodes need a separator in the combined
    // matching buffer. Inline elements (code, strong, em, a, span) share the
    // block ancestor of the surrounding prose, so their text nodes concatenate
    // directly - which keeps inline-scoped punctuation like `...</code>.` intact.
    const BLOCK_TAGS = new Set([
        'P','DIV','H1','H2','H3','H4','H5','H6','LI','UL','OL','BLOCKQUOTE','PRE',
        'SECTION','ARTICLE','HEADER','FOOTER','NAV','ASIDE','MAIN','TABLE','TR',
        'TD','TH','FORM','FIGURE','FIGCAPTION','DL','DT','DD','BODY','HTML',
    ]);
    function blockAncestor(node) {
        let cur = node.parentNode;
        while (cur && cur.nodeType === 1) {
            if (BLOCK_TAGS.has(cur.tagName)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }

    function ensureCMHighlightStyle(doc) {
        if (doc.querySelector('#crtoCMStyle')) return;
        const s = doc.createElement('style');
        s.id = 'crtoCMStyle';
        s.textContent = `.crto-hl-cm { background:${HL_ORANGE_BG};font-weight:600;border-bottom:2px solid ${HL_ORANGE}; }`;
        doc.head.appendChild(s);
    }

    function clearHighlight() {
        const ifr = document.querySelector('#playerFrame');
        const iframeDoc = (ifr?.contentWindow) ? ifr.contentDocument : null;
        if (iframeDoc) {
            const parents = new Set();
            iframeDoc.querySelectorAll('.crto-hl').forEach(m => { parents.add(m.parentNode); m.parentNode.replaceChild(iframeDoc.createTextNode(m.textContent), m); });
            parents.forEach(p => { try { p.normalize(); } catch {} });
            iframeDoc.querySelectorAll('.CodeMirror').forEach(cmEl => {
                if (cmEl.CodeMirror) cmEl.CodeMirror.getAllMarks().forEach(m => { if (m.className === 'crto-hl-cm') m.clear(); });
            });
        }
        const labBody = document.querySelector('#crto-lab-panel .crto-lab-body');
        if (labBody) {
            const parents = new Set();
            labBody.querySelectorAll('.crto-hl').forEach(m => { parents.add(m.parentNode); m.parentNode.replaceChild(document.createTextNode(m.textContent), m); });
            parents.forEach(p => { try { p.normalize(); } catch {} });
        }
        const discussPane = document.querySelector('.social-app');
        if (discussPane) {
            const parents = new Set();
            discussPane.querySelectorAll('.crto-hl').forEach(m => { parents.add(m.parentNode); m.parentNode.replaceChild(document.createTextNode(m.textContent), m); });
            parents.forEach(p => { try { p.normalize(); } catch {} });
        }
    }

    function doScroll(mark) {
        try { mark.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); }
        catch { mark.scrollIntoView(); }
    }

    function mkMark(doc, text) {
        const mark = doc.createElement('mark');
        mark.className = 'crto-hl';
        mark.style.cssText = `background:${HL_ORANGE_BG};color:#000;font-weight:600;`
            + `border-bottom:2px solid ${HL_ORANGE};`;
        mark.textContent = text;
        return mark;
    }

    // Scans a single target (Document or Element) and marks matches.
    // Returns the first mark element if any were made, otherwise null.
    // opts:
    //   allowFallback   - when false, exact mode won't degrade to "highlight
    //                     first word". Lets the poller keep trying until async
    //                     code blocks render.
    //   targetIndex     - which occurrence to mark in exact mode (0 = first).
    //                     Ignored in fuzzy mode (marks every occurrence).
    //   targetKind      - scope filter. When set to 'code', only text nodes
    //                     inside <pre> blocks are considered. When 'body',
    //                     <pre>-nested nodes are excluded but inline `<code>`
    //                     in prose IS treated as body. This matches how the
    //                     indexer pulls fields: code blocks come from the
    //                     pageState JSON and render as <pre>; inline `<code>`
    //                     in paragraphs is part of body.textContent. Filtering
    //                     on `pre, code` (the v0.8.33 behaviour) was wrong:
    //                     it caused a code-snippet click to highlight the
    //                     first inline `<code>foo</code>` in the prose
    //                     instead of the matching <pre> block.
    function markInTarget(target, needles, fuzzy, opts = {}) {
        const { allowFallback = false, targetIndex = 0, targetKind = null } = opts;
        const ownerDoc = target.nodeType === 9 ? target : target.ownerDocument;
        const root = target.nodeType === 9 ? target.body : target;
        if (!root) return null;
        const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
                const t = n.parentNode?.tagName;
                if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                if (targetKind === 'code') {
                    if (!n.parentNode.closest?.('pre')) return NodeFilter.FILTER_REJECT;
                } else if (targetKind === 'body') {
                    if (n.parentNode.closest?.('pre')) return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        const hitsByNode = new Map();
        if (fuzzy) {
            for (let i = 0; i < textNodes.length; i++) {
                const normalised = normChar(textNodes[i].nodeValue);
                for (const needle of needles) {
                    let idx = 0;
                    while ((idx = normalised.indexOf(needle, idx)) !== -1) {
                        if (!hitsByNode.has(i)) hitsByNode.set(i, []);
                        hitsByNode.get(i).push({ idx, len: needle.length });
                        idx += needle.length;
                    }
                }
            }
        } else {
            // Exact mode: normalise each text node with normChar (1-to-1 so
            // indices still map to the raw text), then join with a single
            // space between nodes so a phrase split across inline tags or
            // block elements still matches. Build a whitespace-flexible regex
            // from the query so single-space queries match multi-space /
            // line-wrapped rendered text. Mark only the targetIndex-th match.
            const needle = needles[0];
            const rx = buildPhraseRegex(needle, 'g');
            let combined = '';
            const starts = [];
            let prevBlock = null;
            for (let i = 0; i < textNodes.length; i++) {
                const curBlock = blockAncestor(textNodes[i]);
                // Only add a separator at block boundaries (different closest
                // block ancestor). Inline siblings with no intervening block
                // share their surrounding prose's whitespace, so injecting one
                // here would break queries like `</code>.` where a period
                // hugs the closing inline tag.
                if (i > 0 && curBlock !== prevBlock) combined += ' ';
                starts.push(combined.length);
                combined += normChar(textNodes[i].nodeValue);
                prevBlock = curBlock;
            }
            const phraseHits = rx ? [...combined.matchAll(rx)].map(m => ({ start: m.index, end: m.index + m[0].length })) : [];
            if (phraseHits.length > 0) {
                const picked = phraseHits[Math.min(targetIndex, phraseHits.length - 1)];
                for (let i = 0; i < textNodes.length; i++) {
                    const ns = starts[i]; const ne = ns + textNodes[i].nodeValue.length;
                    if (ne <= picked.start) continue; if (ns >= picked.end) break;
                    const localStart = Math.max(0, picked.start - ns);
                    const localEnd = Math.min(textNodes[i].nodeValue.length, picked.end - ns);
                    if (localEnd > localStart) {
                        if (!hitsByNode.has(i)) hitsByNode.set(i, []);
                        hitsByNode.get(i).push({ idx: localStart, len: localEnd - localStart });
                    }
                }
            } else if (allowFallback && /\s/.test(needle)) {
                const firstWord = normChar(needle).split(/\s+/)[0];
                for (let i = 0; i < textNodes.length; i++) {
                    const idx = normChar(textNodes[i].nodeValue).indexOf(firstWord);
                    if (idx !== -1) { hitsByNode.set(i, [{ idx, len: firstWord.length }]); break; }
                }
            }
        }
        if (hitsByNode.size === 0) return null;

        const sortedNodeIdxs = [...hitsByNode.keys()].sort((a, b) => a - b);
        let firstMark = null;
        for (const nodeIdx of sortedNodeIdxs) {
            const n = textNodes[nodeIdx];
            const hits = hitsByNode.get(nodeIdx).sort((a, b) => a.idx - b.idx);
            const merged = [];
            for (const h of hits) {
                const last = merged[merged.length - 1];
                if (last && h.idx < last.idx + last.len) last.len = Math.max(last.len, h.idx + h.len - last.idx);
                else merged.push({ ...h });
            }
            const cmEl = n.parentNode.closest?.('.CodeMirror');
            if (cmEl?.CodeMirror) {
                ensureCMHighlightStyle(ownerDoc);
                const cm = cmEl.CodeMirror;
                const lineEl = n.parentNode.closest?.('.CodeMirror-line');
                if (lineEl) {
                    const lineIdx = [...cmEl.querySelectorAll('.CodeMirror-line')].indexOf(lineEl);
                    if (lineIdx >= 0) {
                        for (const h of merged) {
                            const marker = cm.markText(
                                { line: lineIdx, ch: h.idx },
                                { line: lineIdx, ch: h.idx + h.len },
                                { className: 'crto-hl-cm' }
                            );
                            if (!firstMark) {
                                const cmMarks = cmEl.querySelectorAll('.crto-hl-cm');
                                if (cmMarks.length) firstMark = cmMarks[0];
                            }
                        }
                        continue;
                    }
                }
            }
            const parent = n.parentNode; const txt = n.nodeValue;
            const frag = ownerDoc.createDocumentFragment();
            let cursor = 0;
            for (const h of merged) {
                if (h.idx > cursor) frag.appendChild(ownerDoc.createTextNode(txt.slice(cursor, h.idx)));
                const mk = mkMark(ownerDoc, txt.slice(h.idx, h.idx + h.len));
                if (!firstMark) firstMark = mk;
                frag.appendChild(mk);
                cursor = h.idx + h.len;
            }
            if (cursor < txt.length) frag.appendChild(ownerDoc.createTextNode(txt.slice(cursor)));
            parent.replaceChild(frag, n);
        }
        return firstMark;
    }

    // Exact mode: mark only one occurrence of the phrase (the targetIndex-th,
    // default 0). Scope-aware: when targetKind is 'code', only marks inside
    // <pre>/<code>; when 'body', only outside them.
    // Fuzzy mode: mark every occurrence of every token (density view).
    // Scans BOTH the ebook iframe and the lab-content panel.
    function highlightAndScroll(query, opts = {}) {
        clearHighlight();
        // fuzzy: pre-normalised tokens (markInTarget normalises each node in turn).
        // exact: pre-normalised phrase; markInTarget builds a whitespace-flexible regex via buildPhraseRegex.
        const needles = fuzzy
            ? normChar(query).split(/\s+/).filter(t => t.length > 0)
            : [normChar(query)];
        if (!needles.length) return false;

        const marks = [];
        const _ifr = document.querySelector('#playerFrame');
        const iframeDoc = (_ifr?.contentWindow) ? _ifr.contentDocument : null;
        if (iframeDoc?.body) {
            // The lab panel handles 'lab' kind; it has no counterpart in the
            // iframe, so skip iframe marking when the hit was in a lab field.
            if (opts.targetKind !== 'lab') {
                const m = markInTarget(iframeDoc, needles, fuzzy, opts);
                if (m) marks.push(m);
            }
        }
        const labBody = document.querySelector('#crto-lab-panel .crto-lab-body');
        if (labBody) {
            // For the lab panel, ignore targetKind filtering (lab markdown
            // mixes prose and code in one document).
            const labOpts = { ...opts, targetKind: null };
            const m = markInTarget(labBody, needles, fuzzy, labOpts);
            if (m) marks.push(m);
        }
        if (marks.length === 0) return false;
        // Prefer scrolling to the lab panel mark when present (it's the more
        // useful context for lab hits), otherwise the iframe mark.
        const target = marks[marks.length - 1];
        doScroll(target);
        // Single re-scroll after 600ms to handle reflow, then stop.
        // Previous approach (300/800/1500ms) fought user scrolling.
        const reScrollId = setTimeout(() => {
            const _ri = document.querySelector('#playerFrame');
            const m = document.querySelector('#crto-lab-panel .crto-hl') || ((_ri?.contentWindow) ? _ri.contentDocument?.querySelector('.crto-hl') : null);
            if (m) doScroll(m);
        }, 600);
        // Cancel even the single re-scroll if user scrolls anywhere
        const cancelReScroll = () => { clearTimeout(reScrollId); scrollTargets.forEach(el => el.removeEventListener('wheel', cancelReScroll)); };
        const _si = document.querySelector('#playerFrame');
        const ifrDoc = (_si?.contentWindow) ? _si.contentDocument : null;
        const scrollTargets = [document, ifrDoc, document.querySelector('#crto-lab-panel')].filter(Boolean);
        scrollTargets.forEach(el => el.addEventListener('wheel', cancelReScroll, { passive: true, once: true }));
        setTimeout(cancelReScroll, 1500);
        return true;
    }

    let pendingPoll = null;
    function scheduleHighlight(query, opts = {}, maxMs = 8000) {
        if (pendingPoll) pendingPoll();
        if (!query || !query.trim()) return;
        const t0 = performance.now();
        let cancelled = false;
        pendingPoll = () => { cancelled = true; };
        function tick() {
            if (cancelled) return;
            // First 3 seconds: only try the real match. Then allow first-word
            // fallback so code blocks that render asynchronously still get the
            // correct highlight instead of the poller settling on an unrelated
            // early hit of the first token.
            const elapsed = performance.now() - t0;
            const pollOpts = { ...opts, allowFallback: elapsed > 3000 };
            if (highlightAndScroll(query, pollOpts)) { pendingPoll = null; return; }
            if (elapsed > maxMs) { pendingPoll = null; return; }
            setTimeout(tick, 300);
        }
        setTimeout(tick, 400);
    }

    function buildIndex() {
        const units = [];
        const cache = loadCache();
        const us = getStore().state.unitStates || {};
        for (const id of Object.keys(us)) {
            const vm = us[id];
            const ud = vm.$options.propsData.unitData;
            const sd = vm.$options.propsData.sectionData;
            units.push({
                id: ud.id,
                title: vm.unitTitle || ud.unitTitle || '(untitled)',
                type: ud.type,
                subtitle: ud.subtitle,
                section: sd.title,
                sectionIdx: vm.$options.propsData.sectionIndex,
                unitIdx: vm.$options.propsData.unitIndex,
                url: vm.unitRedirectLink || null,
                body: cache[id]?.body || null,
                code: cache[id]?.code || null,
                lab: cache[id]?.lab || null,
                discuss: cache[id]?.discuss || null,
            });
        }
        units.sort((a, b) => a.sectionIdx - b.sectionIdx || a.unitIdx - b.unitIdx);
        return units;
    }

    // Multi-select: build list of (fieldName, text) pairs for active scopes only.
    // Returns [] when no scope active - caller treats empty query as pass-through.
    function fieldsForScope(u) {
        const out = [];
        if (scope.title) {
            out.push({ kind: 'title', text: u.title || '' });
            out.push({ kind: 'section', text: u.section || '' });
        }
        if (scope.content) out.push({ kind: 'body', text: u.body || '' });
        if (scope.code) out.push({ kind: 'code', text: u.code || '' });
        if (scope.lab && u.lab) out.push({ kind: 'lab', text: u.lab });
        if (scope.discuss && u.discuss) out.push({ kind: 'discuss', text: u.discuss });
        return out;
    }

    // Prefer body/lab/code over title/section so the returned hit position yields a snippet.
    const HIT_PRIORITY = ['body', 'lab', 'code', 'discuss', 'title', 'section'];

    // Exact mode: returns all non-overlapping hits across the given fields,
    // ordered by HIT_PRIORITY then by position within each field. Title/section
    // yield at most one hit per field (short, non-repeating). body/code/lab
    // yield every occurrence, each tagged with kindIndex = the Nth occurrence
    // within that kind of field across this unit.
    function exactHits(q, fields) {
        const rx = buildPhraseRegex(normChar(q), 'g');
        if (!rx) return [];
        const out = [];
        const kindCounters = {};
        for (const kind of HIT_PRIORITY) {
            const multi = kind === 'body' || kind === 'code' || kind === 'lab' || kind === 'discuss';
            for (let i = 0; i < fields.length; i++) {
                if (fields[i].kind !== kind) continue;
                const text = normChar(fields[i].text || '');
                const matches = [...text.matchAll(rx)];
                for (const m of matches) {
                    const kindIndex = (kindCounters[kind] = (kindCounters[kind] || 0) + 1) - 1;
                    out.push({ fieldIdx: i, idx: m.index, len: m[0].length, kind, kindIndex });
                    if (!multi) break;
                }
            }
        }
        return out;
    }

    // Fuzzy mode keeps one hit per unit - the matched tokens are then all
    // highlighted in the iframe anyway, so per-occurrence sidebar rows add
    // noise without benefit. Returns the same shape as exactHits for uniform
    // downstream handling.
    function fuzzyHits(q, fields) {
        const tokens = normChar(q).split(/\s+/).filter(t => t.length > 0);
        if (tokens.length === 0) return [];
        const joined = normChar(fields.map(f => f.text || '').join(' \n '));
        if (!tokens.every(t => joined.includes(t))) return [];
        for (const kind of HIT_PRIORITY) {
            for (let i = 0; i < fields.length; i++) {
                if (fields[i].kind !== kind) continue;
                const f = normChar(fields[i].text || '');
                for (const t of tokens) {
                    const idx = f.indexOf(t);
                    if (idx !== -1) return [{ fieldIdx: i, idx, len: t.length, kind, kindIndex: 0 }];
                }
            }
        }
        return [];
    }

    function search(q, units) {
        const anyScope = scope.title || scope.content || scope.code || scope.lab || scope.discuss;
        // No query: show everything regardless of scope
        if (!q || !q.trim()) return units.map(u => ({ ...u, snippet: null, snippetIsCode: false, hitKind: null, hitKindIndex: 0 }));
        // Query but no scope: fall through and search all fields
        const out = [];
        for (const u of units) {
            const fields = anyScope ? fieldsForScope(u) : [
                { kind: 'title', text: u.title || '' },
                { kind: 'section', text: u.section || '' },
                { kind: 'body', text: u.body || '' },
                { kind: 'code', text: u.code || '' },
                ...(u.lab ? [{ kind: 'lab', text: u.lab }] : []),
                ...(u.discuss ? [{ kind: 'discuss', text: u.discuss }] : []),
            ];
            if (fields.length === 0) continue;
            const hits = fuzzy ? fuzzyHits(q, fields) : exactHits(q, fields);
            if (!hits.length) continue;
            for (const hit of hits) {
                let snippet = null, snippetIsCode = false;
                const src = fields[hit.fieldIdx];
                if (hit.kind === 'body' || hit.kind === 'code' || hit.kind === 'lab' || hit.kind === 'discuss') {
                    const s = Math.max(0, hit.idx - 40);
                    const e = Math.min(src.text.length, hit.idx + hit.len + 80);
                    snippet = (s > 0 ? '...' : '') + src.text.slice(s, e) + (e < src.text.length ? '...' : '');
                    snippetIsCode = hit.kind === 'code';
                }
                out.push({ ...u, snippet, snippetIsCode, hitKind: hit.kind, hitKindIndex: hit.kindIndex });
            }
        }
        return out;
    }

    async function fetchUnitData(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript').forEach(n => n.remove());
        let body = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
        for (const rx of NOISE) body = body.replace(rx, '').trim();
        // Code-block extraction must produce blocks in DOM rendering order
        // so kindIndex from search aligns with the iframe's <pre> walker.
        // Walking pageState.components by Object.entries returns
        // pageState-key order which is NOT guaranteed to match DOM order.
        // Instead: enumerate `<div data-node-type="code-block">` elements
        // in DOM order, look up each one's `id` in pageState.components,
        // and concatenate the `code` field.
        let code = '';
        const m = html.match(/var\s+pageState\s*=\s*(\{[\s\S]+?\});\s*(?:var\s|\/\/|<\/script)/);
        if (m) {
            try {
                const ps = JSON.parse(m[1]);
                const components = ps.components || {};
                const codeBlockEls = doc.querySelectorAll('[data-node-type="code-block"]');
                const codes = [];
                for (const el of codeBlockEls) {
                    const c = components[el.id];
                    if (c && typeof c.code === 'string') codes.push(c.code);
                }
                // Fallback: if no code-block markers found (older page templates
                // or unusual structure), fall back to the v3 walker so we don't
                // emit an empty code field.
                if (codes.length === 0) {
                    function walk(o, key) {
                        if (o == null) return;
                        if (typeof o === 'string') { if (key === 'code') codes.push(o); return; }
                        if (Array.isArray(o)) { for (const v of o) walk(v, key); return; }
                        if (typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, k);
                    }
                    walk(ps, '');
                }
                code = codes.join('\n').trim();
            } catch {}
        }
        return { body, code };
    }

    function showToast() {
        document.querySelector('#crtoToast')?.remove();
        const title = el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:6px;color:#333;', text: 'Building full-text index...' });
        const status = el('div', { style: 'font-size:11px;color:#888;margin-bottom:8px;' });
        const fill = el('div', { style: 'height:100%;background:#75b095;width:0;transition:width 0.2s;' });
        const bar = el('div', { style: 'height:4px;background:#e0e0e0;border-radius:2px;overflow:hidden;' }, [fill]);
        const toast = el('div', {
            id: 'crtoToast',
            style: 'position:fixed;top:20px;right:20px;background:#fff;border:1px solid #ccc;'
                + 'border-radius:8px;padding:12px 16px;z-index:999999;box-shadow:0 4px 16px rgba(0,0,0,0.15);'
                + 'min-width:260px;font-family:inherit;',
        }, [title, status, bar]);
        document.body.appendChild(toast);
        return {
            title, status, fill, toast,
            dismiss(msg, color) {
                title.textContent = msg;
                if (color) title.style.color = color;
                setTimeout(() => { toast.style.transition = 'opacity 1s'; }, 2500);
                setTimeout(() => { toast.style.opacity = '0'; }, 3500);
                setTimeout(() => toast.remove(), 4500);
            },
        };
    }

    async function fetchDiscussions(unitId) {
        try {
            const courseSlug = getCourseId();
            const resp = await fetch(`/api/posts?context=${unitId}&parent_context=${courseSlug}&sort=modified_desc&getPinnedPosts=true`, { credentials: 'same-origin' });
            if (!resp.ok) return '';
            const data = await resp.json();
            if (!data.success) return '';
            const posts = data.posts || {};
            const parts = [];
            const entries = Array.isArray(posts) ? posts : Object.values(posts);
            for (const post of entries) {
                const author = post.user_id?.username || '';
                const text = (post.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text) parts.push(`[${author}] ${text}`);
                for (const comment of (post.comments || [])) {
                    const cAuthor = comment.user_id?.username || '';
                    const cText = (comment.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                    if (cText) parts.push(`[${cAuthor}] ${cText}`);
                }
            }
            return parts.join('\n');
        } catch { return ''; }
    }

    async function fetchLabMdDirect(unitId, filePath) {
        try {
            const encodedFile = encodeURIComponent(filePath);
            const resp = await fetch(`/api/unlock/attachment/${encodedFile}?json&learningActivityId=${unitId}`, {
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                    'X-Api-Version': '0.0.1',
                    'Token': JSON.parse(decodeURIComponent(document.cookie.match(/lw_tokens=([^;]+)/)[1])).access_token,
                },
            });
            const data = await resp.json();
            if (!data.success || !data.redirectUrl) return '';
            const mdResp = await fetch(data.redirectUrl);
            return mdResp.ok ? await mdResp.text() : '';
        } catch { return ''; }
    }

    async function crawlAll() {
        if (crawl.running) return;
        crawl = { running: true, cancel: false };
        const allUnits = buildIndex();
        const store = getStore();
        const ebookUnits = allUnits.filter(u => u.url && /ebook/i.test(u.type));
        // SCORM units with .md attachments (labs)
        const labUnits = allUnits.filter(u => {
            if (!/scorm/i.test(u.type || '')) return false;
            const vm = store.state.unitStates[u.id];
            const attachments = vm?.$options?.propsData?.unitData?.attachments || [];
            return attachments.some(a => /^md$/i.test(a.extension || ''));
        });
        const labFileMap = {};
        for (const u of labUnits) {
            const vm = store.state.unitStates[u.id];
            const att = vm?.$options?.propsData?.unitData?.attachments?.find(a => /^md$/i.test(a.extension || ''));
            if (att) labFileMap[u.id] = att.file;
        }
        const nonEbookNonLabUnits = allUnits.filter(u => !(/ebook/i.test(u.type)) && !labFileMap[u.id] && u.id);
        const total = allUnits.length;
        const cache = {};
        saveCache(cache);
        const toast = showToast();
        let done = 0, failed = 0, phase = '';
        const update = () => {
            const msg = `${phase}${done}/${total} (${failed} failed)`;
            if (statusEl) statusEl.textContent = msg;
            if (fillEl) fillEl.style.width = `${Math.round(100 * done / total)}%`;
            toast.status.textContent = msg;
            toast.fill.style.width = `${Math.round(100 * done / total)}%`;
        };
        update();
        const delay = () => REQUEST_DELAY_MS > 0 ? new Promise(r => setTimeout(r, REQUEST_DELAY_MS)) : Promise.resolve();
        // Phase 1: crawl ebook units (body + code + discussions)
        async function ebookWorker(q) {
            for (const u of q) {
                if (crawl.cancel) return;
                try {
                    const [{ body, code }, discuss] = await Promise.all([
                        fetchUnitData(u.url),
                        fetchDiscussions(u.id),
                    ]);
                    cache[u.id] = { body, code, discuss, title: u.title, ts: Date.now() };
                    if (done % 10 === 0) saveCache(cache);
                } catch { failed++; }
                done++;
                update();
                await delay();
            }
        }
        // Phase 2: crawl lab SCORM units (lab markdown + discussions)
        async function labWorker(q) {
            for (const u of q) {
                if (crawl.cancel) return;
                try {
                    const [lab, discuss] = await Promise.all([
                        fetchLabMdDirect(u.id, labFileMap[u.id]),
                        fetchDiscussions(u.id),
                    ]);
                    cache[u.id] = { lab: lab || null, discuss, title: u.title, ts: Date.now() };
                    if (done % 10 === 0) saveCache(cache);
                } catch { failed++; }
                done++;
                update();
                await delay();
            }
        }
        // Phase 3: crawl remaining non-ebook non-lab units (discussions only)
        async function discussWorker(q) {
            for (const u of q) {
                if (crawl.cancel) return;
                try {
                    const discuss = await fetchDiscussions(u.id);
                    if (discuss) {
                        cache[u.id] = { ...(cache[u.id] || {}), discuss, title: u.title, ts: Date.now() };
                    }
                    if (done % 10 === 0) saveCache(cache);
                } catch { failed++; }
                done++;
                update();
                await delay();
            }
        }
        const t0 = performance.now();
        phase = 'Pages: ';
        update();
        const ebookQueues = Array.from({ length: CONCURRENCY }, (_, i) => ebookUnits.filter((_, idx) => idx % CONCURRENCY === i));
        await Promise.all(ebookQueues.map(q => ebookWorker(q)));
        if (!crawl.cancel) {
            phase = 'Labs: ';
            update();
            const labQueues = Array.from({ length: CONCURRENCY }, (_, i) => labUnits.filter((_, idx) => idx % CONCURRENCY === i));
            await Promise.all(labQueues.map(q => labWorker(q)));
        }
        if (!crawl.cancel) {
            phase = 'Discussions: ';
            update();
            const discussQueues = Array.from({ length: CONCURRENCY }, (_, i) => nonEbookNonLabUnits.filter((_, idx) => idx % CONCURRENCY === i));
            await Promise.all(discussQueues.map(q => discussWorker(q)));
        }
        saveCache(cache);
        crawl.running = false;
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const bodyChars = Object.values(cache).reduce((s, v) => s + (v.body?.length || 0), 0);
        const codeChars = Object.values(cache).reduce((s, v) => s + (v.code?.length || 0), 0);
        const discussChars = Object.values(cache).reduce((s, v) => s + (v.discuss?.length || 0), 0);
        const labChars = Object.values(cache).reduce((s, v) => s + (v.lab?.length || 0), 0);
        const msg = crawl.cancel
            ? `Stopped - ${done - failed}/${total} cached`
            : `Indexed ${done - failed}/${total} (${(bodyChars / 1024).toFixed(0)}KB body + ${(codeChars / 1024).toFixed(0)}KB code + ${(labChars / 1024).toFixed(0)}KB lab + ${(discussChars / 1024).toFixed(0)}KB discuss) in ${elapsed}s`;
        if (statusEl) statusEl.textContent = msg;
        toast.dismiss(crawl.cancel ? 'Index cancelled' : 'Index complete', crawl.cancel ? '#c26' : '#2d7a4a');
    }

    let lastNavTime = 0;
    function navigateToUnit(u) {
        const now = Date.now();
        if (now - lastNavTime < 500) return;
        lastNavTime = now;
        const ch = document.querySelectorAll('#lpathContents > li.lrn-path-chapter')[u.sectionIdx];
        if (!ch) return;
        const link = ch.querySelectorAll('a.lrn-path-cont-link')[u.unitIdx];
        if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    function unitNumber(u) {
        return `${u.sectionIdx + 1}.${u.unitIdx + 1}`;
    }

    // Inject Discuss-style tooltip CSS once.
    function ensureTooltipStyle() {
        if (document.querySelector('#crtoTipStyle')) return;
        const s = document.createElement('style');
        s.id = 'crtoTipStyle';
        s.textContent =
            '.crto-btn { position:relative; }'
          + '.crto-tip { display:none; position:absolute; bottom:calc(100% + 6px); left:50%;'
          + ' transform:translateX(-50%); background:rgba(0,0,0,0.7); color:#fff;'
          + ' padding:6px 10px; border-radius:6px; font-size:12px; line-height:1.3;'
          + ' font-family:"Open Sans",-apple-system,BlinkMacSystemFont,sans-serif;'
          + ' white-space:nowrap; pointer-events:none; z-index:10000; }'
          + '.crto-btn:hover .crto-tip { display:block; }'
          + '.crto-btn:first-child .crto-tip { left:0; transform:none; }'
          + '.crto-btn:last-child .crto-tip { left:auto; right:0; transform:none; }'
          // Results pane typography. Mirror Discuss / Path styling so the
          // panel feels native rather than bolted on. Discuss uses Open Sans
          // 15px/24.75px for `learnworlds-main-text-small`; Path uses 16px/400
          // for chapter names and unit links. Snippet text is downscaled to
          // 14px so it sits subordinate to the unit row (Discuss does the same
          // in nested replies).
          + '#crtoResults { font-family:"Open Sans",-apple-system,BlinkMacSystemFont,sans-serif;'
          + ' color:rgb(39, 39, 64); }'
          + '.crto-meta { font-size:13px; color:rgb(120, 120, 132);'
          + ' margin-bottom:10px; padding:0 4px; }'
          + '.crto-section { font-size:14px; font-weight:600; color:rgb(39, 39, 64);'
          + ' margin:14px 4px 6px; letter-spacing:normal; text-transform:none; }'
          + '.crto-unit-row { display:flex; gap:10px; align-items:center;'
          + ' padding:8px 10px; cursor:pointer; border-radius:4px;'
          + ' font-size:15px; font-weight:400; line-height:24.75px;'
          + ' color:rgb(39, 39, 64); }'
          + '.crto-unit-row:hover { background:rgb(248, 248, 248); }'
          + '.crto-unit-row.active, .crto-unit-row.crto-active { background:rgb(242, 242, 242); border-left:3px solid rgb(75, 163, 141); padding-left:7px; }'
          + '.crto-unit-row .crto-unit-title { flex:1;'
          + ' overflow:hidden; text-overflow:ellipsis; }'
          + '.crto-badge { font-size:11px; font-weight:600;'
          + ' color:rgb(80, 80, 80); background:rgb(238, 238, 238);'
          + ' padding:3px 7px; border-radius:3px; min-width:34px;'
          + ' text-align:center; font-variant-numeric:tabular-nums;'
          + ' line-height:1.5; }'
          + '.crto-snip { font-size:14px; line-height:1.55;'
          + ' color:rgb(88, 89, 91); padding:8px 12px;'
          + ' margin:0 10px 6px 48px; background:rgb(250, 250, 250);'
          + ' border:1px solid rgb(238, 238, 238); border-radius:4px;'
          + ' cursor:pointer; transition:border-color 0.12s;'
          + ' overflow-wrap:break-word; word-break:break-all; }'
          + '.crto-snip:hover { border-color:rgb(117, 176, 149); }'
          + '.crto-snip.code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
          + ' font-size:12px; line-height:1.45; color:rgb(220, 220, 220);'
          + ' background:rgb(42, 42, 42); border-color:rgb(42, 42, 42);'
          + ' white-space:pre-wrap; }'
          + '.crto-snip.code:hover { border-color:rgb(117, 176, 149); }'
          + '.crto-snip.crto-active, .crto-snip.code.crto-active, .crto-snip.crto-active:hover, .crto-snip.code.crto-active:hover { border-left:3px solid rgb(75, 163, 141); }'
          // Match-emphasis inside snippets. Bold-only - no background tint -
          // so the highlight is visible without competing with the iframe
          // mark colour or adding visual noise to dense result lists.
          + '.crto-snip-hl { font-weight:600; color:rgb(39, 39, 64); }'
          + '.crto-snip.code .crto-snip-hl { color:rgb(255, 255, 255); }';
        document.head.appendChild(s);
    }

    // Discuss-exact toolbar button: 26x26 container, 4px padding, 2px radius.
    // Inactive: transparent bg. Active: rgb(242,242,242). Icon always rgb(39,39,64).
    function mkToolbarBtn(iconKey, title, onClick) {
        ensureTooltipStyle();
        const btn = document.createElement('div');
        btn.setAttribute('role', 'button');
        btn.className = 'crto-btn';
        btn.style.cssText = 'width:26px;height:26px;padding:4px;box-sizing:border-box;'
            + 'border-radius:2px;cursor:pointer;display:inline-flex;align-items:center;'
            + `justify-content:center;color:${ICON_NAVY};background:transparent;`
            + 'transition:background 0.15s;user-select:none;';
        btn.appendChild(svgIcon(ICONS[iconKey]));
        const tip = document.createElement('span');
        tip.className = 'crto-tip';
        tip.textContent = title;
        btn.appendChild(tip);
        btn.addEventListener('mouseenter', () => {
            if (!btn.dataset.active) btn.style.background = HOVER_GREY;
        });
        btn.addEventListener('mouseleave', () => {
            if (!btn.dataset.active) btn.style.background = 'transparent';
        });
        btn.addEventListener('click', onClick);
        btn.setActive = (on) => {
            if (on) { btn.dataset.active = '1'; btn.style.background = ACTIVE_GREY; }
            else { delete btn.dataset.active; btn.style.background = 'transparent'; }
        };
        return btn;
    }

    function injectSearchTab() {
        const tabs = document.querySelector('ul.-first-col-tabs');
        if (!tabs || document.querySelector('#crtoSearchTab')) return;
        const span = el('span', { class: 'first-col-tab-lbl learnworlds-main-text-small', text: 'Search' });
        const li = el('li', {
            id: 'crtoSearchTab', class: 'first-col-tab clr2-border',
            style: 'cursor:pointer', attrs: { 'data-tab': 'search' },
        }, [span]);
        tabs.appendChild(li);
        li.addEventListener('click', openSearch);
    }

    function injectSearchPanel() {
        const content = document.querySelector('.-first-col-tabs-content');
        if (!content || document.querySelector('#crtoSearchPanel')) return;
        if (getComputedStyle(content).position === 'static') content.style.position = 'relative';

        // Input styled to match LW's Discuss `.social-text-editor` wrapper:
        // soft-grey fill, no border, 6px radius, Open Sans 15px navy text.
        const input = el('input', {
            id: 'crtoSearchInput', attrs: { type: 'text', placeholder: 'Search...', autocomplete: 'off' },
            style: 'width:100%;box-sizing:border-box;padding:10px 12px;border:none;border-radius:6px;'
                + 'background:rgb(242, 242, 242);font-size:15px;outline:none;color:rgb(39, 39, 64);'
                + 'font-family:"Open Sans",-apple-system,BlinkMacSystemFont,sans-serif;',
        });
        // Both action buttons styled to match the Discuss "Share" button
        // (.learnworlds-button-solid-brand): teal fill, 6px radius, bold white.
        const BTN_STYLE = 'padding:6px 16px;background:rgb(32, 173, 150);color:white;border:none;'
            + 'border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;'
            + 'font-family:"Open Sans",-apple-system,BlinkMacSystemFont,sans-serif;';
        const indexBtn = el('button', { id: 'crtoIndexBtn', text: 'Index', style: BTN_STYLE });
        const buttonRow = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;' }, [indexBtn]);

        scopeBtns.title = mkToolbarBtn('title', 'Scope: title + section', () => toggleScope('title'));
        scopeBtns.content = mkToolbarBtn('content', 'Scope: body text', () => toggleScope('content'));
        scopeBtns.code = mkToolbarBtn('code', 'Scope: code blocks', () => toggleScope('code'));
        scopeBtns.lab = mkToolbarBtn('lab', 'Scope: lab markdown files', () => toggleScope('lab'));
        scopeBtns.discuss = mkToolbarBtn('discuss', 'Scope: discussion comments', () => toggleScope('discuss'));
        fuzzyBtn = mkToolbarBtn('fuzzy', 'Fuzzy match; highlights every occurrence', toggleFuzzy);
        const clearBtn = mkToolbarBtn('clear', 'Clear highlights', () => clearHighlight());
        const suppressBtn = mkToolbarBtn('suppress', 'Suppress "Leave site?" prompts when navigating between labs', () => {
            const next = !isSuppressBeforeunloadOn();
            setSuppressBeforeunload(next);
            suppressBtn.setActive(next);
            installBeforeUnloadBlock();
        });
        suppressBtn.setActive(isSuppressBeforeunloadOn());

        const mkSep = () => el('span', { style: 'width:1px;height:18px;background:#d0d0d0;display:inline-block;' });
        const iconRow = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-top:10px;' },
            [scopeBtns.title, scopeBtns.content, scopeBtns.code, scopeBtns.lab, scopeBtns.discuss, mkSep(), fuzzyBtn, clearBtn, mkSep(), suppressBtn]);

        statusEl = el('span', { id: 'crtoIndexStatus', style: 'font-size:11px;color:#888;margin-top:6px;display:block;' });
        fillEl = el('div', { style: 'height:100%;background:#75b095;width:0;transition:width 0.15s;' });
        const bar = el('div', { style: 'height:3px;background:#e0e0e0;border-radius:2px;margin-top:4px;overflow:hidden;' }, [fillEl]);
        const card = el('div', {
            style: 'background:#fff;border-radius:8px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,0.08);',
        }, [input, iconRow, statusEl, bar, buttonRow]);

        // id="crtoResults" anchors the typography sheet in ensureTooltipStyle.
        ensureTooltipStyle();
        resultsEl = el('div', { id: 'crtoResults' });
        const panel = el('div', {
            id: 'crtoSearchPanel',
            style: 'position:absolute;top:0;left:0;right:0;bottom:0;background:#fafafa;padding:10px;overflow-y:auto;display:none;z-index:50;',
        }, [card, resultsEl]);
        content.appendChild(panel);

        // Debounced input handler. Coalesces rapid keystrokes so each typed
        // character does not trigger a fresh search-and-render. 150ms is a
        // sweet spot - shorter feels too aggressive (mid-word renders),
        // longer feels laggy.
        let inputDebounce = null;
        input.addEventListener('input', e => {
            if (inputDebounce) clearTimeout(inputDebounce);
            const v = e.target.value;
            if (!v.trim()) clearHighlight();
            inputDebounce = setTimeout(() => {
                inputDebounce = null;
                render(v);
            }, 150);
        });
        // Enter forces an immediate render + highlight, bypassing the debounce.
        input.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            if (inputDebounce) { clearTimeout(inputDebounce); inputDebounce = null; }
            render(input.value);
            if (input.value.trim()) scheduleHighlight(input.value);
            else clearHighlight();
        });
        indexBtn.addEventListener('click', () => {
            if (crawl.running) {
                crawl.cancel = true;
                indexBtn.textContent = 'Index';
            } else {
                indexBtn.textContent = 'Cancel';
                crawlAll().then(() => {
                    indexBtn.textContent = 'Re-index';
                    render(input.value);
                });
            }
        });
        resultsEl.addEventListener('click', (e) => {
            const q = input.value;
            if (!q || !q.trim()) return;
            if (pendingPoll) pendingPoll();
            // Detach SCORM iframe to suppress beforeunload dialog on navigation.
            // Install a frameUrl bridge so Vue can set src on the replacement.
            const _ifr = document.querySelector('#playerFrame');
            if (_ifr) {
                const _s = getStore();
                const _ud = _s?.state?.unitStates?.[_s?.state?.selectedUnitId]?.$options?.propsData?.unitData;
                if (/scorm/i.test(_ud?.type || '')) {
                    const _fresh = _ifr.cloneNode(false);
                    _fresh.src = 'about:blank';
                    _ifr.parentNode.replaceChild(_fresh, _ifr);
                    // Vue writes frameUrl to the detached element. After a
                    // short delay (navigation settles), mirror onto the live
                    // DOM element.
                    setTimeout(() => {
                        const cur = document.querySelector('#playerFrame');
                        const url = _s.state.frameUrl;
                        if (cur && url && cur.src !== url) cur.src = url;
                    }, 500);
                }
            }
            const snip = e.target.closest?.('[data-hit-kind]');
            if (snip?.dataset.hitKind === 'discuss') {
                const targetIdx = +(snip.dataset.hitKindIndex || 0);
                closeSearch();
                setTimeout(() => {
                    const s = findLegacySkin();
                    if (s) s.activeTab = 'discussion';
                }, 600);
                // Highlight in the Discuss pane with scroll-to-load retry.
                // Posts load lazily (12 at a time); if the match is beyond the
                // first page, scroll the container to trigger infinite scroll,
                // then retry until found or attempts exhausted.
                const expandedSet = new Set();
                const highlightDiscuss = (attempt = 0) => {
                    const discussPane = document.querySelector('.social-app');
                    const scrollContainer = discussPane?.querySelector('.social-content-scroll') || discussPane;
                    // Expand collapsed reply threads ("View all (N)" buttons)
                    const showAllBtns = discussPane?.querySelectorAll('.show-all-btn') || [];
                    let newExpansions = 0;
                    showAllBtns.forEach(btn => {
                        if (expandedSet.has(btn)) return;
                        btn.click();
                        expandedSet.add(btn);
                        newExpansions++;
                    });
                    if (newExpansions > 0) {
                        setTimeout(() => highlightDiscuss(attempt), 600);
                        return;
                    }
                    const postTexts = (() => {
                        if (!discussPane) return [];
                        // Body leaves use the zero-overlap selector verified in
                        // DEBUG-CLAUDE.md. Author leaves stay included because
                        // fetchDiscussions() indexes `[author] text`.
                        const raw = [...discussPane.querySelectorAll([
                            '.post-item-content > .post-item-header-container .learnworlds-main-text-small.bold',
                            '.post-item-content > .learnworlds-main-text-small.weglot-exclude:not(.bold)',
                            '.social-comment-text-content .learnworlds-main-text-very-small.bold',
                        ].join(','))];
                        const unique = [...new Set(raw)].filter(el => el.textContent?.trim());
                        return unique.filter(el => !unique.some(other => other !== el && el.contains(other)));
                    })();
                    if (discussPane && postTexts?.length && q.trim()) {
                        clearHighlight();
                        const needles = fuzzy
                            ? normChar(q).split(/\s+/).filter(t => t.length > 0)
                            : [normChar(q)];
                        const countMatches = target => {
                            const ownerDoc = target.ownerDocument;
                            const walker = ownerDoc.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
                                acceptNode(n) {
                                    if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
                                    const t = n.parentNode?.tagName;
                                    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                                    return NodeFilter.FILTER_ACCEPT;
                                },
                            });
                            const textNodes = [];
                            let node;
                            while ((node = walker.nextNode())) textNodes.push(node);
                            if (fuzzy) {
                                let count = 0;
                                for (const n of textNodes) {
                                    const normalised = normChar(n.nodeValue);
                                    for (const needle of needles) {
                                        let idx = 0;
                                        while ((idx = normalised.indexOf(needle, idx)) !== -1) {
                                            count++;
                                            idx += needle.length;
                                        }
                                    }
                                }
                                return count;
                            }
                            const rx = buildPhraseRegex(needles[0], 'g');
                            if (!rx) return 0;
                            let combined = '';
                            let prevBlock = null;
                            for (let i = 0; i < textNodes.length; i++) {
                                const curBlock = blockAncestor(textNodes[i]);
                                if (i > 0 && curBlock !== prevBlock) combined += ' ';
                                combined += normChar(textNodes[i].nodeValue);
                                prevBlock = curBlock;
                            }
                            return [...combined.matchAll(rx)].length;
                        };
                        let mark = null;
                        let loadedOccurrences = 0;
                        let targetAttempted = false;
                        for (const pt of postTexts) {
                            const matchCount = countMatches(pt);
                            if (!matchCount) continue;
                            if (!targetAttempted && loadedOccurrences + matchCount > targetIdx) {
                                mark = markInTarget(pt, needles, fuzzy, { targetIndex: targetIdx - loadedOccurrences });
                                targetAttempted = true;
                                if (mark) break;
                            }
                            loadedOccurrences += matchCount;
                        }
                        if (mark) {
                            doScroll(mark);
                            setTimeout(() => doScroll(mark), 300);
                        } else if (attempt < 8) {
                            const loadedPosts = discussPane.querySelectorAll('.post-item').length;
                            if (loadedOccurrences < targetIdx + 1 && attempt > 2 && scrollContainer.scrollHeight > 0 && loadedPosts >= 12) {
                                scrollContainer.scrollTop = scrollContainer.scrollHeight;
                            }
                            setTimeout(() => highlightDiscuss(attempt + 1), 800);
                        }
                    } else if (attempt < 10) {
                        setTimeout(() => highlightDiscuss(attempt + 1), 600);
                    }
                };
                setTimeout(highlightDiscuss, 800);
                return;
            }
            const opts = snip
                ? { targetKind: snip.dataset.hitKind, targetIndex: +(snip.dataset.hitKindIndex || 0) }
                : {};
            scheduleHighlight(q, opts);
        }, true);

        applyScopeStyles();
        fuzzyBtn.setActive(fuzzy);
        updateIndexStatus();
        render('');
    }

    function applyScopeStyles() {
        for (const k of Object.keys(scopeBtns)) scopeBtns[k].setActive(!!scope[k]);
    }

    function toggleScope(key) {
        scope = { ...scope, [key]: !scope[key] };
        localStorage.setItem('crtoSearchScope', JSON.stringify(scope));
        applyScopeStyles();
        render(document.querySelector('#crtoSearchInput')?.value || '');
    }

    function toggleFuzzy() {
        fuzzy = !fuzzy;
        localStorage.setItem('crtoSearchFuzzy', fuzzy ? '1' : '0');
        fuzzyBtn.setActive(fuzzy);
        const q = document.querySelector('#crtoSearchInput')?.value || '';
        if (q.trim()) scheduleHighlight(q);
        else clearHighlight();
        render(q);
    }

    function updateIndexStatus() {
        const cache = loadCache();
        const count = Object.keys(cache).length;
        const discussCount = Object.values(cache).filter(v => v.discuss).length;
        const labCount = Object.values(cache).filter(v => v.lab).length;
        const indexBtn = document.querySelector('#crtoIndexBtn');
        if (count > 0) {
            const parts = [`${count} units cached`];
            if (labCount) parts.push(`${labCount} labs`);
            if (discussCount) parts.push(`${discussCount} discussions`);
            if (statusEl) statusEl.textContent = parts.join(', ');
            if (indexBtn) indexBtn.textContent = 'Re-index';
        } else {
            if (indexBtn) indexBtn.textContent = 'Index';
        }
    }

    function openSearch() {
        const content = document.querySelector('.-first-col-tabs-content');
        if (content) {
            if (content.dataset.crtoOriginalOverflow === undefined) {
                content.dataset.crtoOriginalOverflow = getComputedStyle(content).overflow;
            }
            content.style.overflow = 'hidden';
            content.scrollTop = 0;
        }
        document.querySelectorAll('ul.-first-col-tabs > li').forEach(li => li.classList.remove('-selected-tab'));
        document.querySelector('#crtoSearchTab').classList.add('-selected-tab');
        document.querySelector('#crtoSearchPanel').style.display = 'block';
        setTimeout(() => {
            const input = document.querySelector('#crtoSearchInput');
            if (input) {
                try { input.focus({ preventScroll: true }); }
                catch { input.focus(); }
            }
            requestAnimationFrame(() => {
                const active = document.querySelector('#crtoResults .crto-active');
                if (active) {
                    try { active.scrollIntoView({ block: 'center', inline: 'nearest' }); }
                    catch { active.scrollIntoView(); }
                }
            });
        }, 50);
    }

    function closeSearch() {
        const content = document.querySelector('.-first-col-tabs-content');
        if (content) content.style.overflow = content.dataset.crtoOriginalOverflow || 'auto';
        document.querySelector('#crtoSearchPanel').style.display = 'none';
        document.querySelector('#crtoSearchTab')?.classList.remove('-selected-tab');
    }

    function scopeLabel() {
        const on = Object.entries(scope).filter(([_, v]) => v).map(([k]) => k);
        return on.length ? on.join('+') : 'all';
    }

    // Build a DocumentFragment of the snippet text with matches wrapped in
    // <span class="crto-snip-hl"> for bold emphasis.
    //
    // Position mapping: normChar is 1-to-1 (each input char maps to exactly
    // one output char), so match indices found against the normalised
    // snippet apply unchanged to the raw snippet string. This means the
    // visible characters - including curly quotes, en-dashes, zero-width
    // chars - are preserved in the wrapped output even though we matched
    // against their ASCII equivalents.
    //
    // Exact mode: use buildPhraseRegex to produce a whitespace-flexible
    // regex matching the full phrase, same as exactHits. Returns one or
    // more match spans (multi-occurrence within a single snippet possible
    // for very long body extracts).
    //
    // Fuzzy mode: tokenise the query on whitespace, build an alternation
    // regex `(t1|t2|...)`, mark every occurrence of any token. Mirrors the
    // iframe's fuzzy highlighting behaviour.
    function highlightSnippet(snippet, query, isFuzzy) {
        const frag = document.createDocumentFragment();
        if (!snippet) return frag;
        if (!query || !query.trim()) {
            frag.appendChild(document.createTextNode(snippet));
            return frag;
        }
        const normalised = normChar(snippet);
        let ranges = [];
        if (isFuzzy) {
            const tokens = normChar(query).split(/\s+/).filter(t => t.length > 0);
            if (tokens.length === 0) {
                frag.appendChild(document.createTextNode(snippet));
                return frag;
            }
            const rx = new RegExp('(' + tokens.map(escRe).join('|') + ')', 'g');
            for (const m of normalised.matchAll(rx)) {
                ranges.push({ start: m.index, end: m.index + m[0].length });
            }
        } else {
            const rx = buildPhraseRegex(normChar(query), 'g');
            if (!rx) {
                frag.appendChild(document.createTextNode(snippet));
                return frag;
            }
            for (const m of normalised.matchAll(rx)) {
                ranges.push({ start: m.index, end: m.index + m[0].length });
            }
        }
        if (ranges.length === 0) {
            frag.appendChild(document.createTextNode(snippet));
            return frag;
        }
        // Merge overlapping ranges (fuzzy tokens "lon" and "long" against
        // "longer" would otherwise produce nested spans).
        ranges.sort((a, b) => a.start - b.start);
        const merged = [ranges[0]];
        for (let i = 1; i < ranges.length; i++) {
            const last = merged[merged.length - 1];
            if (ranges[i].start <= last.end) last.end = Math.max(last.end, ranges[i].end);
            else merged.push(ranges[i]);
        }
        let cursor = 0;
        for (const r of merged) {
            if (r.start > cursor) {
                frag.appendChild(document.createTextNode(snippet.slice(cursor, r.start)));
            }
            const span = document.createElement('span');
            span.className = 'crto-snip-hl';
            span.textContent = snippet.slice(r.start, r.end);
            frag.appendChild(span);
            cursor = r.end;
        }
        if (cursor < snippet.length) {
            frag.appendChild(document.createTextNode(snippet.slice(cursor)));
        }
        return frag;
    }

    // Render-pacing constants. MAX_SNIPPETS caps the number of result rows
    // emitted to keep DOM size sane on broad queries; section headers and
    // unit rows are NOT capped (they are cheap and useful for orientation).
    // RENDER_CHUNK is the number of build-commands processed per
    // requestAnimationFrame tick. 50 keeps each frame well under 16ms even on
    // slower laptops while still finishing a typical 200-snippet result-set
    // in under 100ms.
    const MAX_SNIPPETS = 500;
    const RENDER_CHUNK = 50;
    let renderToken = 0;
    let pendingRaf = 0;

    // Build one DOM node from a render command. Used by the chunked render
    // loop. Click handlers close over the unit reference passed in via cmd.
    function buildNode(cmd, query) {
        if (cmd.kind === 'section') {
            const n = el('div', { attrs: { class: 'crto-section' } });
            n.appendChild(document.createTextNode(`${cmd.sectionNum}. `));
            n.appendChild(highlightSnippet(cmd.name, query, fuzzy));
            return n;
        }
        if (cmd.kind === 'unit') {
            const u = cmd.unit;
            const badge = el('span', { text: unitNumber(u), attrs: { class: 'crto-badge' } });
            const title = el('span', { attrs: { class: 'crto-unit-title' } });
            title.appendChild(highlightSnippet(u.title || '', query, fuzzy));
            const n = el('div', { attrs: { class: 'crto-unit-row' } }, [badge, title]);
            n.addEventListener('click', () => {
                if (/scorm/i.test(u.type || '')) {
                    window.__crtoForceLabPanel = true;
                    setTimeout(() => { if (window.__crtoForceLabPanel) maybeInjectLabPanel(true); }, 1000);
                }
                document.querySelectorAll('#crtoResults .crto-active').forEach(el => el.classList.remove('crto-active'));
                n.classList.add('crto-active');
                navigateToUnit(u);
            });
            return n;
        }
        if (cmd.kind === 'snip') {
            const u = cmd.unit;
            const h = cmd.hit;
            const n = el('div', {
                attrs: {
                    class: h.snippetIsCode ? 'crto-snip code' : 'crto-snip',
                    'data-hit-kind': h.hitKind || '',
                    'data-hit-kind-index': String(h.hitKindIndex || 0),
                },
            });
            n.appendChild(highlightSnippet(h.snippet, query, fuzzy));
            n.addEventListener('click', (e) => {
                e.stopPropagation();
                if (h.hitKind === 'lab') {
                    window.__crtoForceLabPanel = true;
                    setTimeout(() => { if (window.__crtoForceLabPanel) maybeInjectLabPanel(true); }, 1000);
                }
                document.querySelectorAll('#crtoResults .crto-active').forEach(el => el.classList.remove('crto-active'));
                n.classList.add('crto-active');
                navigateToUnit(u);
            });
            return n;
        }
        if (cmd.kind === 'cap') {
            return el('div', {
                attrs: { class: 'crto-meta' },
                style: 'margin-top:12px;text-align:center;',
                text: `Showing first ${cmd.shown} of ${cmd.total} matches - refine the query to narrow results.`,
            });
        }
        return null;
    }

    function render(query) {
        if (!resultsEl) return;
        // Bump the render token. Any in-flight chunked render checks this on
        // each tick and aborts if it does not match - that's how a fast typist
        // does not accumulate ghost results from prior keystrokes.
        const myToken = ++renderToken;
        if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = 0; }

        const units = buildIndex();
        const hits = search(query, units);
        clear(resultsEl);
        // Reset scroll only on full re-render, not on each chunk.
        resultsEl.scrollTop = 0;

        // Group hits by unit (multi-hit search can produce several per unit).
        const byUnit = new Map();
        for (const h of hits) {
            if (!byUnit.has(h.id)) byUnit.set(h.id, { unit: h, hits: [] });
            byUnit.get(h.id).hits.push(h);
        }
        const uniqueUnits = byUnit.size;

        const matchLabel = query && query.trim() && hits.length > uniqueUnits
            ? ` - ${hits.length} matches`
            : '';
        resultsEl.appendChild(el('div', {
            attrs: { class: 'crto-meta' },
            text: `${uniqueUnits} of ${units.length} units${matchLabel} (${scopeLabel()}${fuzzy ? ', fuzzy' : ''})`,
        }));
        if (uniqueUnits === 0) return;

        // Group unit-entries by section for the section headers.
        const bySection = {};
        for (const entry of byUnit.values()) {
            const key = entry.unit.section;
            if (!bySection[key]) bySection[key] = [];
            bySection[key].push(entry);
        }

        // Flatten into a list of build commands. Section headers and unit
        // rows are always emitted; snippet rows are capped at MAX_SNIPPETS
        // to bound worst-case render work.
        const commands = [];
        let snipBudget = MAX_SNIPPETS;
        let totalSnippetHits = 0;
        for (const section of Object.keys(bySection)) {
            const entries = bySection[section];
            const sectionNum = entries[0].unit.sectionIdx + 1;
            commands.push({ kind: 'section', sectionNum, name: section });
            for (const { unit: u, hits: unitHits } of entries) {
                commands.push({ kind: 'unit', unit: u });
                const snippetHits = unitHits.filter(h => h.snippet);
                totalSnippetHits += snippetHits.length;
                for (const h of snippetHits) {
                    if (snipBudget > 0) {
                        commands.push({ kind: 'snip', unit: u, hit: h });
                        snipBudget--;
                    }
                }
            }
        }
        if (totalSnippetHits > MAX_SNIPPETS) {
            commands.push({ kind: 'cap', shown: MAX_SNIPPETS, total: totalSnippetHits });
        }

        // Chunked emit. Each rAF tick processes RENDER_CHUNK commands.
        // Aborts if a newer render() supersedes us (renderToken changed).
        let i = 0;
        function tick() {
            if (myToken !== renderToken) return;
            const end = Math.min(i + RENDER_CHUNK, commands.length);
            for (; i < end; i++) {
                const node = buildNode(commands[i], query);
                if (node) resultsEl.appendChild(node);
            }
            if (i < commands.length) {
                pendingRaf = requestAnimationFrame(tick);
            } else {
                pendingRaf = 0;
            }
        }
        pendingRaf = requestAnimationFrame(tick);
    }

    function wireExistingTabs() {
        ['#pathPlayerTab', '#discussionTab'].forEach(sel => {
            const t = document.querySelector(sel);
            if (t && !t.dataset.crtoWired) {
                t.dataset.crtoWired = '1';
                t.addEventListener('click', closeSearch);
            }
        });
    }

    function watchForRerender() {
        const tabs = document.querySelector('ul.-first-col-tabs');
        if (!tabs) return;
        new MutationObserver(() => {
            if (!document.querySelector('#crtoSearchTab')) injectSearchTab();
            wireExistingTabs();
        }).observe(tabs, { childList: true });
    }

    // Click-trick to fetch lab markdown: LW's /api/unlock/attachment endpoint
    // refuses scripted direct calls, but the real click handler produces a
    // window.open(signedBlobUrl). Hook window.open, click the anchor, capture
    // the URL, fetch the blob text, restore. Suppresses the download dialog
    // by returning a dummy window object.

    // Navigate through every lab unit in order and populate cache[id].lab via
    // the click-trick fetcher. Runs up to two passes: the second passes uses
    // longer timeouts and only revisits units that failed in pass one. Per-unit
    // failure reasons are tracked in a state map and logged to the console at
    // end. Restores the user's starting unit when done or cancelled.
    function escapeHtml(s) {
        return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // Markdown renderer that understands the ZPS flavour:
    //   +++text+++        -> highlighted token (user-input or emphasis)
    //   1. [ ] item       -> ordered list with task checkbox
    //   - [ ] item        -> unordered list with task checkbox
    //   === on its own    -> horizontal rule
    //   > [!HINT]         -> hint callout
    //   > [!KNOWLEDGE]    -> knowledge callout
    //   <br/>             -> line break
    //   @lab.X, @lab.Virt -> left as-is (template placeholders)
    function renderMarkdown(md) {
        md = md.replace(/<br\s*\/?>/gi, '\n');
        // ZPS double-backtick fenced code: ``lang content [across lines] ``
        // Convert to standard triple-backtick so the fenced-block parser picks it up.
        // Negative lookbehind/ahead prevent matching inside triple-backtick blocks.
        md = md.replace(/(?<!`)``(?!`)([\w-]+)?\s+([\s\S]+?)(?<!`)``(?!`)/g,
            (_, lang, code) => '\n\n```' + (lang || '') + '\n' + code.trim() + '\n```\n\n');
        const lines = md.split(/\r?\n/);
        let out = '', i = 0;
        const isListLine = l => /^\s*(?:[-*]|\d+\.)\s/.test(l);
        while (i < lines.length) {
            const line = lines[i];
            const fenceOpen = line.match(/^(\s*)```(.*)$/);
            if (fenceOpen) {
                const indent = fenceOpen[1].length;
                i++;
                const code = [];
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
                i++;
                // Strip up to `indent` leading whitespace chars from each code line so
                // indented fences don't render with the outer indentation baked in.
                const stripped = indent > 0
                    ? code.map(l => { let j = 0; while (j < indent && j < l.length && /[ \t]/.test(l[j])) j++; return l.slice(j); })
                    : code;
                out += `<pre style="background:#2a2a2a;color:#e0e0e0;padding:10px 12px;border-radius:4px;margin:8px 0;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.4;"><code>${escapeHtml(stripped.join('\n'))}</code></pre>`;
                continue;
            }
            if (/^={3,}\s*$/.test(line)) {
                out += '<hr style="border:none;border-top:1px solid #ddd;margin:14px 0;">';
                i++; continue;
            }
            const h = line.match(/^(#{1,6})\s+(.+)$/);
            if (h) {
                const n = h[1].length;
                const size = [0, 20, 17, 15, 14, 13, 12][n] || 13;
                out += `<h${n} style="margin:14px 0 6px;font-weight:600;font-size:${size}px;color:#222;">${renderInline(h[2])}</h${n}>`;
                i++; continue;
            }
            if (/^\s*>\s*\[!(\w+)\]/.test(line)) {
                const m = line.match(/^\s*>\s*\[!(\w+)\]\s*(.*)$/);
                const type = m[1].toUpperCase();
                const body = [m[2]];
                i++;
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    body.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                const palette = type === 'HINT'
                    ? { bg: '#e7f4ff', bd: '#2196f3', fg: '#0b5394' }
                    : type === 'KNOWLEDGE'
                    ? { bg: '#fff4e5', bd: '#ff9800', fg: '#7a4100' }
                    : type === 'WARNING' || type === 'IMPORTANT'
                    ? { bg: '#fdecea', bd: '#e53935', fg: '#9a1d1d' }
                    : { bg: '#f5f5f5', bd: '#888', fg: '#444' };
                out += `<div style="background:${palette.bg};border-left:3px solid ${palette.bd};padding:10px 14px;margin:10px 0;border-radius:4px;">`
                    + `<div style="font-weight:700;font-size:11px;letter-spacing:0.5px;color:${palette.fg};margin-bottom:4px;">${type}</div>`
                    + `<div style="line-height:1.5;">${renderInline(body.join(' ').trim())}</div></div>`;
                continue;
            }
            if (/^\s*>\s?/.test(line)) {
                const quote = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    quote.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                out += `<blockquote style="border-left:3px solid #ccc;padding:6px 12px;margin:8px 0;color:#555;">${renderInline(quote.join(' '))}</blockquote>`;
                continue;
            }
            if (isListLine(line)) {
                const isOrdered = /^\s*\d+\.\s/.test(line);
                const items = [];
                while (i < lines.length && isListLine(lines[i])) {
                    items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
                    i++;
                }
                const tag = isOrdered ? 'ol' : 'ul';
                const lis = items.map(t => {
                    let checkboxHtml = '';
                    let rest = t;
                    const cb = t.match(/^\[([ xX])\]\s*(.*)$/);
                    if (cb) {
                        checkboxHtml = cb[1].trim()
                            ? '<span style="display:inline-block;width:13px;height:13px;margin-right:6px;border:1.5px solid #2d7a4a;background:#75b095;border-radius:2px;vertical-align:text-bottom;"></span>'
                            : '<span style="display:inline-block;width:13px;height:13px;margin-right:6px;border:1.5px solid #888;border-radius:2px;vertical-align:text-bottom;"></span>';
                        rest = cb[2];
                    }
                    return `<li style="margin:3px 0;">${checkboxHtml}${renderInline(rest)}</li>`;
                }).join('');
                out += `<${tag} style="margin:6px 0;padding-left:22px;">${lis}</${tag}>`;
                continue;
            }
            if (line.trim() === '') { i++; continue; }
            const parts = [line];
            i++;
            while (i < lines.length && lines[i].trim() !== ''
                && !/^#{1,6}\s/.test(lines[i])
                && !isListLine(lines[i])
                && !/^={3,}\s*$/.test(lines[i])
                && !/^\s*>/.test(lines[i])
                && !/^```/.test(lines[i])) {
                parts.push(lines[i]); i++;
            }
            out += `<p style="margin:6px 0;line-height:1.5;">${renderInline(parts.join(' '))}</p>`;
        }
        return out;
    }

    function renderInline(text) {
        let s = escapeHtml(text);
        // LearnWorlds doubles backslashes inside +++text+++ and backtick spans.
        // Halve them so \\\\host\\c$ renders as \\host\c$ (matching the source intent).
        s = s.replace(/\+\+\+([^+]+?)\+\+\+/g, (_, inner) =>
            '<code style="background:#d4edda;color:#155724;padding:1px 6px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;">' + inner.replace(/\\\\/g, '\\') + '</code>');
        s = s.replace(/`([^`]+)`/g, (_, inner) =>
            '<code style="background:#f0f0f0;padding:1px 5px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;">' + inner.replace(/\\\\/g, '\\') + '</code>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^\*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
        s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
            '<img alt="$1" src="$2" style="max-width:100%;border-radius:4px;margin:4px 0;">');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener" style="color:#0b72c7;text-decoration:underline;">$1</a>');
        return s;
    }

    function isLabUnit() {
        const store = getStore();
        const uid = store?.state?.selectedUnitId;
        const ud = uid ? store.state.unitStates[uid]?.$options?.propsData?.unitData : null;
        return ud && /scorm/i.test(ud.type || '');
    }

    // Inject a rendered-markdown panel at the top of the main content column
    // on lab units, fetching + caching the .md on first visit. The click-trick
    // fetcher still uses the attachment anchor in #unitAttachments (which is
    // populated by LW but sits off-screen in the collapsed attachment tray).
    async function maybeInjectLabPanel(forceShow) {
        if (window.__crtoSuppressLabPanel) return;
        const attachContainer = document.querySelector('#unitAttachments');
        if (!attachContainer) return;
        const anchor = attachContainer.querySelector('a.js-download-attachment');
        if (!anchor) return;
        if (!isLabUnit()) return;

        const target = document.querySelector('.-second-col-content');
        if (!target) return;
        // Anchor the absolute panel; don't disturb LW's flow layout otherwise.
        if (getComputedStyle(target).position === 'static') target.style.position = 'relative';

        const store = getStore();
        const uid = store.state.selectedUnitId;

        // If a panel or chip exists for a different unit (user navigated), clear
        // it so we re-inject for the current one.
        const existingPanel = target.querySelector('#crto-lab-panel');
        if (existingPanel) {
            if (existingPanel.dataset.unitId === uid) return;
            existingPanel.remove();
        }
        const existingChip = target.querySelector('#crto-lab-restore');
        if (existingChip) {
            if (existingChip.dataset.unitId === uid) return;
            existingChip.remove();
        }

        const cache = loadCache();
        let md = cache[uid]?.lab;

        const hidden = !forceShow;
        const panel = document.createElement('div');
        panel.id = 'crto-lab-panel';
        panel.dataset.unitId = uid;
        // Flex column so the body can stretch/scroll while the controls stay
        // pinned above it. overflow:hidden on the panel keeps the body's
        // scrollbar from escaping the rounded border.
        // position:absolute so we overlay the iframe area without pushing
        // .-content-wrapper down (which breaks LW's attachment-tray layout).
        // right:44px leaves space for LW's paperclip toggle icon at top-right.
        // z-index:10 is BELOW .unit-attachments-wrapper (z:20) so the expanded
        // attachment tray overlays our panel and keeps the download link clickable.
        panel.style.cssText = 'position:absolute;top:0;left:0;right:44px;z-index:10;margin:0;background:#fff;'
            + 'border:1px solid #e0e0e0;border-radius:6px;'
            + 'font-family:"Open Sans",-apple-system,sans-serif;font-size:13px;color:#333;'
            + 'overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);'
            + 'display:flex;flex-direction:column;';

        function isExpanded() { return panel.__crtoExpanded === true; }
        function applyExpanded() {
            panel.style.maxHeight = isExpanded() ? 'calc(100vh - 80px)' : '35vh';
        }
        applyExpanded();

        // Expand/collapse icon paths. Four L-brackets in corners, outward or
        // inward depending on state.
        const EXPAND_PATH = 'M9 3H3v6M21 9V3h-6M9 21H3v-6M21 15v6h-6';
        const COLLAPSE_PATH = 'M3 9V3h6M21 9V3h-6M9 21v-6H3M15 21v-6h6';

        function mkLabControlBtn(d, title, onClick) {
            const ns = 'http://www.w3.org/2000/svg';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = title;
            btn.style.cssText = 'width:24px;height:24px;border:none;background:transparent;color:#888;cursor:pointer;border-radius:3px;display:flex;align-items:center;justify-content:center;padding:0;';
            btn.addEventListener('mouseenter', () => { btn.style.background = '#f0f0f0'; btn.style.color = '#333'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.color = '#888'; });
            btn.addEventListener('click', onClick);
            const svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
            svg.style.cssText = 'display:block;pointer-events:none;';
            const p = document.createElementNS(ns, 'path');
            p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
            p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('stroke-linejoin', 'round');
            p.setAttribute('d', d);
            svg.appendChild(p);
            btn.appendChild(svg);
            btn.setPath = (newD) => p.setAttribute('d', newD);
            return btn;
        }

        const expandBtn = mkLabControlBtn(
            isExpanded() ? COLLAPSE_PATH : EXPAND_PATH,
            isExpanded() ? 'Collapse lab preview' : 'Expand lab preview to full size',
            () => {
                const next = !isExpanded();
                panel.__crtoExpanded = next;
                applyExpanded();
                expandBtn.setPath(next ? COLLAPSE_PATH : EXPAND_PATH);
                expandBtn.title = next ? 'Collapse lab preview' : 'Expand lab preview to full size';
            },
        );
        const hideBtn = mkLabControlBtn(
            'M6 6l12 12M18 6L6 18',
            'Hide lab preview',
            () => {
                panel.remove();
                showRestoreChip(target, uid);
            },
        );

        // Controls row sits outside the scroll area, pinned to the panel's
        // top-right corner. It stays visible regardless of body scroll.
        const controls = document.createElement('div');
        controls.style.cssText = 'position:absolute;top:6px;right:6px;display:flex;gap:2px;z-index:3;';
        controls.appendChild(expandBtn);
        controls.appendChild(hideBtn);
        panel.appendChild(controls);

        const body = document.createElement('div');
        body.className = 'crto-lab-body';
        // flex:1 + min-height:0 lets the body shrink and scroll within the
        // flex column. padding-right reserves space so controls don't overlap
        // long headings or code blocks.
        body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:14px 46px 14px 16px;';
        panel.appendChild(body);

        if (hidden) {
            showRestoreChip(target, uid);
            return;
        }

        target.insertBefore(panel, target.firstChild);
        window.__crtoForceLabPanel = false;

        if (!md) {
            body.innerHTML = '<div style="color:#888;font-size:12px;padding:8px;">Loading lab content...</div>';
            const vm = store.state.unitStates[uid];
            const att = vm?.$options?.propsData?.unitData?.attachments?.find(a => /^md$/i.test(a.extension || ''));
            md = att ? await fetchLabMdDirect(uid, att.file) : null;
            if (!md) {
                body.innerHTML = '<div style="color:#c26;font-size:12px;padding:8px;">Failed to load lab content. Click the paperclip icon to download.</div>';
                return;
            }
            if (!cache[uid]) cache[uid] = {};
            cache[uid].lab = md;
            cache[uid].title = store.state.unitStates[uid].unitTitle;
            cache[uid].ts = Date.now();
            saveCache(cache);
        }
        body.innerHTML = renderMarkdown(md);
    }

    function showRestoreChip(target, uid) {
        if (target.querySelector('#crto-lab-restore')) return;
        const chip = document.createElement('button');
        chip.id = 'crto-lab-restore';
        chip.dataset.unitId = uid;
        chip.type = 'button';
        chip.textContent = 'Show lab preview';
        chip.style.cssText = 'position:absolute;top:6px;left:6px;z-index:40;padding:5px 10px;background:#fff;border:1px solid #ddd;border-radius:4px;font-size:11px;color:#555;cursor:pointer;font-family:"Open Sans",-apple-system,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.08);';
        chip.addEventListener('mouseenter', () => { chip.style.background = '#e6e6e6'; });
        chip.addEventListener('mouseleave', () => { chip.style.background = '#f0f0f0'; });
        chip.addEventListener('click', () => {
            chip.remove();
            maybeInjectLabPanel(true);
        });
        target.insertBefore(chip, target.firstChild);
    }

    // Watch unit navigation: when the attachment anchor for a lab appears,
    // inject the panel. When the user navigates away (non-lab), remove it.
    // Uses two signals: MutationObserver on #unitAttachments (handles both
    // childList AND characterData - LW updates the attachment filename via
    // text-node mutation only), plus a Vuex store.watch on selectedUnitId
    // which is the authoritative "unit changed" signal.
    function watchLabAttachments() {
        const onChange = () => {
            if (!isLabUnit()) {
                document.querySelector('#crto-lab-panel')?.remove();
                document.querySelector('#crto-lab-restore')?.remove();
                return;
            }
            maybeInjectLabPanel(window.__crtoForceLabPanel);
        };
        const tick = () => {
            const attachContainer = document.querySelector('#unitAttachments');
            if (!attachContainer) { setTimeout(tick, 500); return; }
            onChange();
            new MutationObserver(onChange).observe(attachContainer, {
                childList: true, subtree: true, characterData: true,
            });
        };
        tick();
        try {
            const store = getStore();
            if (typeof store.watch === 'function') {
                store.watch(s => s.selectedUnitId, () => setTimeout(onChange, 200));
            }
        } catch {}
    }

    // SCORM lab pages (and possibly LW itself on the main window) register
    // beforeunload handlers that cause Chrome to show a "Leave site? Changes
    // you made may not be saved." dialog on every cross-unit navigation.
    // Useful safety when solving labs, very annoying when browsing.
    //
    // Strategy: patch `Event.prototype.preventDefault` and the
    // `Event.prototype.returnValue` setter on both the main window and the
    // iframe's window. When a beforeunload event fires with suppression
    // enabled, calls to preventDefault become no-ops and assignments to
    // returnValue are silently skipped - so SCORM/LW handlers cannot cancel
    // the event, and no dialog appears. Once suppression is toggled off, the
    // patched wrappers fall through to the original behaviour.
    function isSuppressBeforeunloadOn() {
        return localStorage.getItem('crtoSuppressBeforeunload') === '1';
    }
    function setSuppressBeforeunload(on) {
        localStorage.setItem('crtoSuppressBeforeunload', on ? '1' : '0');
    }
    function patchEventPrototype(EventCtor) {
        const proto = EventCtor?.prototype;
        if (!proto || proto.__crtoBuPatched) return;
        proto.__crtoBuPatched = true;
        // preventDefault - skip when suppressed + beforeunload
        const origPrevent = proto.preventDefault;
        proto.preventDefault = function () {
            if (this.type === 'beforeunload' && isSuppressBeforeunloadOn()) return;
            return origPrevent.call(this);
        };
        // returnValue setter - skip assignment when suppressed + beforeunload.
        // Setting returnValue to ANY value (including empty string) cancels a
        // beforeunload event in Chrome, so we have to block the call entirely
        // rather than coercing to ''.
        try {
            const desc = Object.getOwnPropertyDescriptor(proto, 'returnValue');
            if (desc?.set) {
                const origSet = desc.set;
                Object.defineProperty(proto, 'returnValue', {
                    configurable: true,
                    get: desc.get,
                    set(val) {
                        if (this.type === 'beforeunload' && isSuppressBeforeunloadOn()) return;
                        return origSet.call(this, val);
                    },
                });
            }
        } catch (err) {
            console.warn(`${TAG} returnValue setter patch failed:`, err);
        }
    }
    function installBeforeUnloadBlock() {
        if (!isSuppressBeforeunloadOn()) return;
        patchEventPrototype(window.Event);
        const iframe = document.querySelector('#playerFrame');
        const iwin = iframe?.contentWindow;
        if (iwin?.Event) {
            try { patchEventPrototype(iwin.Event); } catch (err) {
                console.warn(`${TAG} iframe Event patch failed:`, err);
            }
        }
        try { window.onbeforeunload = null; } catch {}
        try { if (iwin) iwin.onbeforeunload = null; } catch {}
    }
    function watchIframeForBeforeUnload() {
        installBeforeUnloadBlock();
        const iframe = document.querySelector('#playerFrame');
        if (iframe && !iframe.__crtoBuHooked) {
            iframe.__crtoBuHooked = true;
            iframe.addEventListener('load', () => { if (isSuppressBeforeunloadOn()) installBeforeUnloadBlock(); });
        }
        // Re-apply on unit change - the iframe's Event prototype usually
        // survives document swaps, but nulling any freshly-set onbeforeunload
        // still matters.
        try {
            const store = getStore();
            if (typeof store.watch === 'function') {
                store.watch(s => s.selectedUnitId, () => {
                    if (!isSuppressBeforeunloadOn()) return;
                    installBeforeUnloadBlock();
                    setTimeout(() => { if (isSuppressBeforeunloadOn()) installBeforeUnloadBlock(); }, 500);
                    setTimeout(() => { if (isSuppressBeforeunloadOn()) installBeforeUnloadBlock(); }, 1500);
                });
            }
        } catch {}

        // Event.prototype patches are not sufficient for LW's SCORM player:
        // SCORM handlers cancel the event via the `return "string"` pattern
        // which Chrome evaluates through a native path the JS patches cannot
        // reach. The reliable fix is to detach the iframe from the DOM
        // *before* the navigation completes. A detached iframe is destroyed
        // synchronously and its beforeunload never fires, so no dialog can be
        // raised. We then insert a fresh clone in its place and let LW's Vue
        // re-assign the new src as normal.
        const NAV_SELECTOR = [
            '#lpathContents a.lrn-path-cont-link',
            'a.-default-course-player-back',
            '.default-course-player-nav-btn',
        ].join(', ');
        let pendingDetach = false;
        document.addEventListener('click', (e) => {
            if (!isSuppressBeforeunloadOn()) return;
            if (!e.target.closest?.(NAV_SELECTOR)) return;
            const ifr = document.querySelector('#playerFrame');
            if (!ifr) return;
            const s = getStore();
            const curUid = s?.state?.selectedUnitId;
            const ud = curUid ? s.state.unitStates[curUid]?.$options?.propsData?.unitData : null;
            if (!ud || !/scorm/i.test(ud.type || '')) return;
            const fresh = ifr.cloneNode(false);
            fresh.src = 'about:blank';
            ifr.parentNode.replaceChild(fresh, ifr);
            fresh.__crtoBuHooked = false;
            fresh.addEventListener('load', installBeforeUnloadBlock);
            pendingDetach = true;
        }, true);

        try {
            const store = getStore();
            if (store && typeof store.watch === 'function') {
                store.watch(s => s.frameUrl, (newUrl) => {
                    if (!pendingDetach) return;
                    pendingDetach = false;
                    const cur = document.querySelector('#playerFrame');
                    if (cur && newUrl && cur.src !== newUrl) cur.src = newUrl;
                });
            }
        } catch {}
    }

    waitForReady();
})();
