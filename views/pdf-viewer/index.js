/* eslint-disable @typescript-eslint/naming-convention */
"use strict";

// Reference: https://github.com/tomoki1207/vscode-pdfviewer/blob/main/lib/main.js
(function(){
    const CursorTool = { SELECT:0, HAND:1, ZOOM:2 };
    const SpreadMode = { UNKNOWN:-1, NONE:0, ODD:1, EVEN:2 };
    const ScrollMode = { UNKNOWN:-1, VERTICAL:0, HORIZONTAL:1, WRAPPED:2, PAGE:3 };
    const SidebarView = { UNKNOWN:-1, NONE:0, THUMBS:1, OUTLINE:2, ATTACHMENTS:3, LAYERS:4 };
    const ScrollModeMap = {
        vertical: ScrollMode.VERTICAL,
        horizontal: ScrollMode.HORIZONTAL,
        wrapped: ScrollMode.WRAPPED,
        page: ScrollMode.PAGE,
    };
    const SpreadModeMap = {
        none: SpreadMode.NONE,
        odd: SpreadMode.ODD,
        even: SpreadMode.EVEN,
    };
    let ColorThemes = {
        'default': {fontColor:'black', bgColor:'white'},
        'light': {fontColor:'black', bgColor:'#F5F5DC'},
        'dark': {fontColor:'#FBF0D9', bgColor:'#4B4B4B'}
    };

    // @ts-ignore
    const vscode = acquireVsCodeApi();
    const CitationPreviewDefaults = {
        enabled: true,
        maxEntries: 8,
        maxLines: 6,
        maxChars: 1200,
    };
    let globalPdfViewerState = {
        colorTheme: 'default',
        containerScrollLeft: 0,
        containerScrollTop:  0,
        currentScaleValue: 'auto',
        pdfCursorTools: CursorTool.SELECT,
        pdfViewerScrollMode: ScrollMode.VERTICAL,
        pdfViewerSpreadMode: SpreadMode.NONE,
        pdfSidebarView: SidebarView.NONE,
    };
    let firstLoaded = true;
	    let citationPreviewOptions = {...CitationPreviewDefaults};
	    const citationPreviewState = {
	        annotationCache: new Map(),
	        textLineCache: new Map(),
	        activeCluster: null,
	        activePopover: null,
	        activeRequestId: 0,
	        listenersEnabled: false,
	    };

    function updatePdfViewerState() {
        const pdfViewerState = vscode.getState() || globalPdfViewerState;

        if (ColorThemes[pdfViewerState.colorTheme] === undefined) {
            pdfViewerState.colorTheme = Object.keys(ColorThemes)[0];
        }
        pdfjsLib.ViewerFontColor = ColorThemes[pdfViewerState.colorTheme].fontColor;
        pdfjsLib.ViewerBgColor = ColorThemes[pdfViewerState.colorTheme].bgColor;

        PDFViewerApplication.pdfViewer.currentScaleValue = pdfViewerState.currentScaleValue;
        PDFViewerApplication.pdfCursorTools.switchTool( pdfViewerState.pdfCursorTools );
        PDFViewerApplication.pdfViewer.scrollMode = pdfViewerState.pdfViewerScrollMode;
        PDFViewerApplication.pdfViewer.spreadMode = pdfViewerState.pdfViewerSpreadMode;
        PDFViewerApplication.pdfSidebar.setInitialView( pdfViewerState.pdfSidebarView );
        PDFViewerApplication.pdfSidebar.switchView( pdfViewerState.pdfSidebarView );
        document.getElementById('viewerContainer').scrollLeft = pdfViewerState.containerScrollLeft;
        document.getElementById('viewerContainer').scrollTop = pdfViewerState.containerScrollTop;
        PDFViewerApplication.pdfViewer.refresh();
    }

    function backupPdfViewerState() {
        if (PDFViewerApplication.pdfViewer.currentScaleValue !== null) {
            console.log( PDFViewerApplication.pdfViewer.currentScaleValue );
            globalPdfViewerState.currentScaleValue = PDFViewerApplication.pdfViewer.currentScaleValue;
        }
        globalPdfViewerState.pdfViewerScrollMode = PDFViewerApplication.pdfViewer.scrollMode;
        globalPdfViewerState.pdfViewerSpreadMode = PDFViewerApplication.pdfViewer.spreadMode;
        globalPdfViewerState.pdfSidebarView = PDFViewerApplication.pdfSidebar.visibleView;
        globalPdfViewerState.containerScrollLeft = document.getElementById('viewerContainer').scrollLeft || 0;
        globalPdfViewerState.containerScrollTop = document.getElementById('viewerContainer').scrollTop || 0;
        vscode.setState(globalPdfViewerState);
        vscode.postMessage({
            type: 'saveState',
            content: globalPdfViewerState,
        });
    }

    function updateColorThemes(themes) {
        ColorThemes = themes;
        // set global css
        const style = document.createElement('style');
        for (const theme in ColorThemes) {
            // sanitize theme name
            if (theme.match(/^[a-zA-Z0-9-_]+$/) === null) {
                continue;
            }
            // sanitize color value
            if (ColorThemes[theme].fontColor.match(/^#[0-9a-fA-F]{6}$/) === null) {
                continue;
            }
            if (ColorThemes[theme].bgColor.match(/^#[0-9a-fA-F]{6}$/) === null) {
                continue;
            }
            // update css
            style.innerHTML += `
                #theme-${theme}::before {
                    background-color: ${ColorThemes[theme].bgColor};
                }
            `;
        }
        document.head.appendChild(style);
    }

    function updatePdfViewerDefaults(defaults) {
        if (defaults === undefined || defaults === null) {
            return;
        }
        if (typeof defaults.scrollMode === 'string') {
            const scrollMode = ScrollModeMap[defaults.scrollMode.toLowerCase()];
            if (scrollMode !== undefined) {
                globalPdfViewerState.pdfViewerScrollMode = scrollMode;
            }
        }
        if (typeof defaults.spreadMode === 'string') {
            const spreadMode = SpreadModeMap[defaults.spreadMode.toLowerCase()];
            if (spreadMode !== undefined) {
                globalPdfViewerState.pdfViewerSpreadMode = spreadMode;
            }
        }
    }

    function enableThemeToggleButton(initIndex = 0){
        // create toggle theme button
        const button = document.createElement('button');
        button.setAttribute('class', 'toolbarButton hiddenMediumView');
        button.setAttribute('theme-index', initIndex);
        button.setAttribute('tabindex', '30');
        // set button theme attribute
        const setAttribute = (index) => {
            const theme = Object.keys(ColorThemes)[index];
            globalPdfViewerState.colorTheme = theme;
            button.innerHTML = `<span>${theme}</span>`;
            button.setAttribute('title', `Theme: ${theme}`);
            button.setAttribute('id', `theme-${theme}`);
        };
        button.addEventListener('click', () => {
            const index = Number(button.getAttribute('theme-index'));
            const next = (index + 1) % Object.keys(ColorThemes).length;
            button.setAttribute('theme-index', next);
            setAttribute(next);
            backupPdfViewerState();
            updatePdfViewerState();
        });
        setAttribute(initIndex);
        //
        const container = document.getElementById('toolbarViewerRight');
        const firstChild = document.getElementById('openFile');
        container.insertBefore(button, firstChild);
    }

    async function updatePdf(pdf) {
        clearCitationPreviewState();
        const doc = await pdfjsLib.getDocument({
            data: pdf,
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.10.111/cmaps/',
            cMapPacked: true
        }).promise;
        if (firstLoaded) {
            firstLoaded = false;
        } else {
            backupPdfViewerState();
        }
        PDFViewerApplication.isViewerEmbedded = true;
        PDFViewerApplication.load(doc);
    }

    // Reference: https://github.com/James-Yu/LaTeX-Workshop/blob/master/viewer/latexworkshop.ts#L306
    function syncCode(pdf) {
        const _idx = Math.ceil(pdf.length / 2) - 1;
        const container = document.getElementById('viewerContainer');
        const maxScrollX = window.innerWidth * 0.9;
        const minScrollX = window.innerWidth * 0.1;
        const pageNum = pdf[_idx].page;
        const h = pdf[_idx].h;
        const v = pdf[_idx].v;
        const page = document.getElementsByClassName('page')[pageNum - 1];
        if (page === null || page === undefined) {
            return;
        }
        const {viewport} = PDFViewerApplication.pdfViewer.getPageView(pageNum - 1);
        let [left, top] = viewport.convertToPdfPoint(h , v);
        let scrollX = page.offsetLeft + left;
        scrollX = Math.min(scrollX, maxScrollX);
        scrollX = Math.max(scrollX, minScrollX);
        const scrollY = page.offsetTop + page.offsetHeight - top;
        if (PDFViewerApplication.pdfViewer.scrollMode === 1) {
            // horizontal scrolling
            container.scrollLeft = page.offsetLeft;
        } else {
            // vertical scrolling
            container.scrollTop = scrollY - document.body.offsetHeight * 0.4;
        }
        backupPdfViewerState();
    }

    function clearCitationPreviewState() {
        invalidateCitationPreviewLayout();
    }

	    function invalidateCitationPreviewLayout() {
	        closeCitationPopover();
	        citationPreviewState.annotationCache.clear();
	        citationPreviewState.textLineCache.clear();
	    }

    function updateCitationPreviewOptions(options) {
        if (!options || typeof options !== 'object') {
            citationPreviewOptions = {...CitationPreviewDefaults};
            return;
        }
        citationPreviewOptions = {
            enabled: options.enabled !== false,
            maxEntries: positiveIntegerOrDefault(options.maxEntries, CitationPreviewDefaults.maxEntries),
            maxLines: positiveIntegerOrDefault(options.maxLines, CitationPreviewDefaults.maxLines),
            maxChars: positiveIntegerOrDefault(options.maxChars, CitationPreviewDefaults.maxChars),
        };
    }

    function positiveIntegerOrDefault(value, defaultValue) {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
    }

    function getViewerContainer() {
        return document.getElementById('viewerContainer');
    }

    function getSourceRect(anchor) {
        const section = anchor.closest('section');
        const rect = anchor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return rect;
        }
        return section ? section.getBoundingClientRect() : rect;
    }

    function getPageElement(node) {
        return node?.closest?.('.page') ?? null;
    }

    function getPageNumber(pageElem) {
        const pageNumber = Number(pageElem?.getAttribute('data-page-number'));
        return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
    }

    function centerY(rect) {
        return rect.top + rect.height / 2;
    }

    function unionRects(rects) {
        const left = Math.min(...rects.map(rect => rect.left));
        const top = Math.min(...rects.map(rect => rect.top));
        const right = Math.max(...rects.map(rect => rect.right));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        return {
            left,
            top,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
        };
    }

    function isSameVisualLine(rect, referenceRect) {
        const tolerance = Math.max(rect.height, referenceRect.height, 8) * 1.35;
        return Math.abs(centerY(rect) - centerY(referenceRect)) <= tolerance;
    }

    function textNearRect(pageElem, rect, padding = 24) {
        const spans = Array.from(pageElem.querySelectorAll('.textLayer span'));
        const lineCenter = centerY(rect);
        return spans
            .map(span => ({span, rect: span.getBoundingClientRect()}))
            .filter(({rect: spanRect}) => {
                if (spanRect.width === 0 || spanRect.height === 0) {
                    return false;
                }
                // Require the span's vertical center to sit within the citation rect's
                // own vertical extent (plus a small safety margin). Using a tight bound
                // prevents text from the line above/below leaking in when line spacing
                // is tight, which would otherwise pollute the label.
                const verticalMargin = Math.max(rect.height * 0.35, 3);
                const sameLine = centerY(spanRect) >= rect.top - verticalMargin
                              && centerY(spanRect) <= rect.bottom + verticalMargin;
                const nearHorizontally = spanRect.right >= rect.left - padding && spanRect.left <= rect.right + padding;
                return sameLine && nearHorizontally;
            })
            .sort((a, b) => a.rect.left - b.rect.left)
            .map(({span}) => span.textContent || '')
            .join('');
    }

    // Extracts a short, clean citation label (e.g. "30", "30a", "Smith, 2024")
    // from arbitrary text surrounding the anchor. Returns '' if no clean token found,
    // so the caller can fall back to other sources instead of displaying garbage.
    function deriveCleanCitationLabel(rawText, anchor) {
        const candidates = [];
        const anchorText = (anchor?.textContent || '').replace(/\s+/g, ' ').trim();
        if (anchorText) { candidates.push(anchorText); }
        const nearbyText = (rawText || '').replace(/\s+/g, ' ').trim();
        if (nearbyText && nearbyText !== anchorText) { candidates.push(nearbyText); }

        for (const candidate of candidates) {
            // Case: bare numeric token ("30", "30a")
            if (/^\[?\s*\d+[A-Za-z]?\s*\]?$/.test(candidate)) {
                const m = candidate.match(/\d+[A-Za-z]?/);
                if (m) { return m[0]; }
            }
            // Case: bracketed citation "[30]" or "[30, 31]" — take the first number
            const bracket = candidate.match(/\[\s*(\d+[A-Za-z]?)(?:\s*[,;\-\u2013\u2014]\s*\d+[A-Za-z]?)*\s*\]/);
            if (bracket) { return bracket[1]; }
            // Case: author-year "Smith, 2024" or "(Smith et al., 2024)"
            const author = candidate.match(/\(?\s*([A-Z][A-Za-z.'\-]{1,24}(?:\s+et\s+al\.?)?)\s*,?\s+((?:19|20)\d{2}[a-z]?)\s*\)?/);
            if (author) {
                return `${author[1].replace(/\s+/g, ' ').trim()}, ${author[2]}`;
            }
        }
        return '';
    }

    // Extracts the citation number from the start of a resolved reference entry,
    // e.g. "513 [30] Jingwu Tang..." -> "30",  "30. Author..." -> "30".
    function extractLabelFromReferenceText(text) {
        if (!text) { return ''; }
        const normalized = text.replace(/\s+/g, ' ').trim();
        const bracketMatch = normalized.match(/^\s*(?:\d+\s+)?\[\s*(\d+[A-Za-z]?)\s*\]/);
        if (bracketMatch) { return bracketMatch[1]; }
        const dotMatch = normalized.match(/^\s*(?:\d+\s+)?(\d+[A-Za-z]?)[.)]\s/);
        if (dotMatch) { return dotMatch[1]; }
        return '';
    }

    function extractCitationTokens(text) {
        const groups = [];
        const bracketRegex = /\[\s*([0-9A-Za-z,\s;.\-\u2013\u2014]+)\s*\]/g;
        let match;
        while (match = bracketRegex.exec(text)) {
            const tokens = match[1].match(/\d+[A-Za-z]?/g) || [];
            if (tokens.length > 0) {
                groups.push(tokens);
            }
        }
        if (groups.length === 0) {
            return [];
        }
        return groups.reduce((best, group) => group.length > best.length ? group : best, []);
    }

	    function isSingleCitationToken(text) {
	        return /^\s*\[?\s*\d+[A-Za-z]?\s*\]?\s*$/.test(text || '');
	    }

	    function isLikelyCitationText(text) {
	        const normalized = (text || '').replace(/\s+/g, ' ').trim();
	        if (normalized === '') {
	            return false;
	        }
	        if (isSingleCitationToken(normalized) || /\[[^\]]*\d+[^\]]*\]/.test(normalized)) {
	            return true;
	        }
	        if (/^(fig(?:ure)?|table|sec(?:tion)?|eq(?:uation)?|algorithm|appendix)\b/i.test(normalized)) {
	            return false;
	        }
	        return /\b(?:19|20)\d{2}[a-z]?\b/.test(normalized);
	    }

    async function getPageAnnotations(pageNumber) {
        if (!PDFViewerApplication.pdfDocument) {
            return [];
        }
        if (!citationPreviewState.annotationCache.has(pageNumber)) {
            citationPreviewState.annotationCache.set(pageNumber, PDFViewerApplication.pdfDocument
                .getPage(pageNumber)
                .then(page => page.getAnnotations({intent: 'display'}))
                .catch(() => []));
        }
        return citationPreviewState.annotationCache.get(pageNumber);
    }

    async function getInternalLinkItem(anchor) {
        const section = anchor.closest('section[data-internal-link]');
        const pageElem = getPageElement(anchor);
        const pageNumber = getPageNumber(pageElem);
        if (!section || !pageElem || pageNumber === null) {
            return null;
        }

        const annotationId = anchor.getAttribute('data-element-id') || section.getAttribute('data-annotation-id');
        const annotations = await getPageAnnotations(pageNumber);
        const annotation = annotationId ? annotations.find(item => item.id === annotationId) : undefined;
        const sourceRect = getSourceRect(anchor);
        const nearbyText = textNearRect(pageElem, sourceRect, 2).trim();
        const anchorText = anchor.textContent.trim();
        return {
            anchor,
            annotationId,
            dest: annotation?.dest,
            href: anchor.getAttribute('href') || anchor.href || '',
            labelText: nearbyText || anchorText,
            displayLabel: deriveCleanCitationLabel(nearbyText, anchor),
            pageElem,
            sourcePageNumber: pageNumber,
            sourceRect,
            reference: null,
            error: null,
        };
    }

    async function buildCitationCluster(clickedItem) {
        if (!clickedItem?.dest) {
            return null;
        }
        const pageElem = clickedItem.pageElem;
        const clickedRect = clickedItem.sourceRect;
        const anchors = Array.from(pageElem.querySelectorAll('.annotationLayer section[data-internal-link] > a'))
            .map(anchor => ({anchor, rect: getSourceRect(anchor)}))
            .filter(({rect}) => rect.width > 0 && rect.height > 0 && isSameVisualLine(rect, clickedRect))
            .sort((a, b) => a.rect.left - b.rect.left);

        const clickedIndex = anchors.findIndex(item => item.anchor === clickedItem.anchor);
        if (clickedIndex < 0) {
            return null;
        }

        const gapLimit = Math.max(clickedRect.height * 2.2, 30);
        let start = clickedIndex;
        let end = clickedIndex;
        while (start > 0 && anchors[start].rect.left - anchors[start - 1].rect.right <= gapLimit) {
            start--;
        }
        while (end < anchors.length - 1 && anchors[end + 1].rect.left - anchors[end].rect.right <= gapLimit) {
            end++;
        }

        let itemAnchors = anchors.slice(start, end + 1);
        if (itemAnchors.length > citationPreviewOptions.maxEntries) {
            const localClickedIndex = clickedIndex - start;
            let windowStart = localClickedIndex - Math.floor(citationPreviewOptions.maxEntries / 2);
            windowStart = Math.max(0, Math.min(windowStart, itemAnchors.length - citationPreviewOptions.maxEntries));
            itemAnchors = itemAnchors.slice(windowStart, windowStart + citationPreviewOptions.maxEntries);
        }
        let items = (await Promise.all(itemAnchors.map(({anchor}) => getInternalLinkItem(anchor)))).filter(item => item?.dest);
        if (items.length === 0) {
            return null;
        }

        const clusterRect = unionRects(items.map(item => item.sourceRect));
        const clusterText = textNearRect(pageElem, clusterRect, 40);
        const tokens = extractCitationTokens(clusterText);
        const clickedClusterIndex = items.findIndex(item => item.anchor === clickedItem.anchor);

        if (tokens.length > 0) {
            const wantedCount = Math.min(tokens.length, items.length, citationPreviewOptions.maxEntries);
            let windowStart = Math.max(0, clickedClusterIndex);
            windowStart = Math.min(windowStart, items.length - wantedCount);
            items = items.slice(windowStart, windowStart + wantedCount);
            items.forEach((item, index) => {
                const token = tokens[index];
                if (token) {
                    item.labelText = token;
                    item.displayLabel = token;
                }
            });
	        } else if (!items.every(item => isLikelyCitationText(item.labelText)) && !isLikelyCitationText(clickedItem.labelText)) {
	            return null;
	        }

        const activeIndex = items.findIndex(item => item.anchor === clickedItem.anchor);
        if (activeIndex < 0) {
            return null;
        }

        return {
            sourcePageNumber: clickedItem.sourcePageNumber,
            sourceText: clusterText.trim(),
            items,
            activeIndex,
        };
    }

    async function resolveDestination(dest) {
        if (!PDFViewerApplication.pdfDocument || !dest) {
            return null;
        }
        let explicitDest = Array.isArray(dest) ? dest : await PDFViewerApplication.pdfDocument.getDestination(dest);
        if (!Array.isArray(explicitDest) || explicitDest.length < 2) {
            return null;
        }

        const destRef = explicitDest[0];
        let pageNumber;
        if (typeof destRef === 'object' && destRef !== null) {
            pageNumber = PDFViewerApplication.pdfLinkService._cachedPageNumber(destRef);
            if (!pageNumber) {
                pageNumber = (await PDFViewerApplication.pdfDocument.getPageIndex(destRef)) + 1;
                PDFViewerApplication.pdfLinkService.cachePageRef(pageNumber, destRef);
            }
        } else if (Number.isInteger(destRef)) {
            pageNumber = destRef + 1;
        }
        if (!pageNumber) {
            return null;
        }

        const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
        const viewBox = pageView.viewport.viewBox;
        const pageHeight = viewBox[3] - viewBox[1];
        let x = 0;
        let y = pageHeight;
        switch (explicitDest[1]?.name) {
            case 'XYZ':
                x = typeof explicitDest[2] === 'number' ? explicitDest[2] : 0;
                y = typeof explicitDest[3] === 'number' ? explicitDest[3] : pageHeight;
                break;
            case 'FitH':
            case 'FitBH':
                y = typeof explicitDest[2] === 'number' ? explicitDest[2] : pageHeight;
                break;
            case 'FitV':
            case 'FitBV':
                x = typeof explicitDest[2] === 'number' ? explicitDest[2] : 0;
                break;
            case 'FitR':
                x = typeof explicitDest[2] === 'number' ? explicitDest[2] : 0;
                y = typeof explicitDest[5] === 'number' ? explicitDest[5] : (typeof explicitDest[3] === 'number' ? explicitDest[3] : pageHeight);
                break;
            default:
                break;
        }
        const [viewportX, viewportY] = pageView.viewport.convertToViewportPoint(x, y);
        return {
            pageNumber,
            destArray: explicitDest,
            targetPoint: {x: viewportX, y: viewportY},
        };
    }

    async function getPageTextLines(pageNumber) {
        const cacheKey = getTextLineCacheKey(pageNumber);
        if (citationPreviewState.textLineCache.has(cacheKey)) {
            return citationPreviewState.textLineCache.get(cacheKey);
        }

        const promise = PDFViewerApplication.pdfDocument.getPage(pageNumber)
            .then(async (pdfPage) => {
                const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
                const viewport = pageView.viewport;
                const textContent = await pdfPage.getTextContent();
                const rawItems = textContent.items
                    .filter(item => typeof item.str === 'string' && item.str.trim() !== '')
                    .map(item => {
                        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                        const height = Math.max(Math.abs(item.height || 0) * viewport.scale, Math.hypot(tx[2], tx[3]), 1);
                        const width = Math.max(Math.abs(item.width || 0) * viewport.scale, item.str.length * height * 0.35, 1);
                        const x = tx[4];
                        const y = tx[5];
                        return {
                            str: item.str,
                            x,
                            y,
                            right: x + width,
                            height,
                            column: x < pageView.width / 2 ? 0 : 1,
                        };
                    })
                    .sort((a, b) => a.y - b.y || a.column - b.column || a.x - b.x);

                const lines = [];
                for (const item of rawItems) {
                    const tolerance = Math.max(item.height * 0.65, 3);
                    let line = null;
                    for (let index = lines.length - 1; index >= 0; index--) {
                        const candidate = lines[index];
                        if (candidate.column !== item.column) {
                            continue;
                        }
                        if (Math.abs(candidate.y - item.y) <= tolerance) {
                            line = candidate;
                            break;
                        }
                        if (candidate.y < item.y - tolerance * 2) {
                            break;
                        }
                    }
                    if (!line) {
                        line = {
                            items: [],
                            x: item.x,
                            right: item.right,
                            y: item.y,
                            height: item.height,
                            column: item.column,
                            text: '',
                        };
                        lines.push(line);
                    }
                    line.items.push(item);
                    line.x = Math.min(line.x, item.x);
                    line.right = Math.max(line.right, item.right);
                    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
                    line.height = Math.max(line.height, item.height);
                }

                lines.forEach(line => {
                    line.items.sort((a, b) => a.x - b.x);
                    let text = '';
                    let lastRight = null;
                    for (const item of line.items) {
                        if (lastRight !== null && item.x - lastRight > Math.max(item.height * 0.2, 2)) {
                            text += ' ';
                        }
                        text += item.str;
                        lastRight = item.right;
                    }
                    line.text = text.replace(/\s+/g, ' ').trim();
                });
                return lines
                    .filter(line => line.text !== '')
                    .sort((a, b) => a.column - b.column || a.y - b.y || a.x - b.x);
            })
            .catch(() => []);

        citationPreviewState.textLineCache.set(cacheKey, promise);
        return promise;
    }

    function getTextLineCacheKey(pageNumber) {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
        const viewport = pageView?.viewport;
        const scale = viewport?.scale ?? pageView?.scale ?? 'unknown';
        const width = Math.round(pageView?.width ?? viewport?.width ?? 0);
        const height = Math.round(pageView?.height ?? viewport?.height ?? 0);
        return `${pageNumber}:${scale}:${width}:${height}`;
    }

    function referenceStartRegex(number) {
        const marker = number
            ? number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            : '\\d+';
        return new RegExp(`^\\s*(?:\\d+\\s+)?(?:\\[\\s*${marker}[A-Za-z]?\\s*\\]|\\(?\\s*${marker}[A-Za-z]?\\s*\\)?[.)])\\s+`);
    }

    function findReferenceStartIndex(lines, targetPoint, labelText) {
        if (lines.length === 0) {
            return -1;
        }
        let index = lines.findIndex(line => line.y >= targetPoint.y - 12);
        if (index < 0) {
            index = lines.reduce((best, line, lineIndex) => {
                const distance = Math.abs(line.y - targetPoint.y);
                return distance < best.distance ? {index: lineIndex, distance} : best;
            }, {index: 0, distance: Number.POSITIVE_INFINITY}).index;
        }

        const number = (labelText || '').match(/\d+/)?.[0];
        if (number) {
            const exactRegex = referenceStartRegex(number);
            const lower = Math.max(0, index - 3);
            const upper = Math.min(lines.length - 1, index + 10);
            for (let candidate = lower; candidate <= upper; candidate++) {
                if (exactRegex.test(lines[candidate].text)) {
                    return candidate;
                }
            }
        }
        return index;
    }

    async function resolveReferenceForItem(item) {
        const destination = await resolveDestination(item.dest);
        if (!destination) {
            throw new Error('Destination unavailable.');
        }

        const lines = await getPageTextLines(destination.pageNumber);
        const pageView = PDFViewerApplication.pdfViewer.getPageView(destination.pageNumber - 1);
        const column = destination.targetPoint.x < pageView.width / 2 ? 0 : 1;
        const columnLines = lines
            .filter(line => line.column === column)
            .sort((a, b) => a.y - b.y || a.x - b.x);
        const hintLabel = item.displayLabel || item.labelText;
        const startIndex = findReferenceStartIndex(columnLines, destination.targetPoint, hintLabel);
        if (startIndex < 0) {
            throw new Error('Reference text unavailable.');
        }

        const selected = [];
        const genericRegex = referenceStartRegex();
        for (let index = startIndex; index < columnLines.length && selected.length < citationPreviewOptions.maxLines; index++) {
            const lineText = columnLines[index].text;
            if (index > startIndex && genericRegex.test(lineText)) {
                break;
            }
            selected.push(lineText);
        }

        const text = selected.join(' ').replace(/\s+/g, ' ').trim().slice(0, citationPreviewOptions.maxChars);
        if (!text) {
            throw new Error('Reference text unavailable.');
        }
        return {
            pageNumber: destination.pageNumber,
            dest: item.dest,
            marker: '',
            text,
            label: extractLabelFromReferenceText(text),
            targetPoint: destination.targetPoint,
        };
    }

    function navigateInternalLink(item, anchor) {
        closeCitationPopover();
        if (item?.dest) {
            PDFViewerApplication.pdfLinkService.goToDestination(item.dest);
            return;
        }
        const href = item?.href || anchor.getAttribute('href') || '';
        const hashIndex = href.indexOf('#');
        if (hashIndex >= 0) {
            PDFViewerApplication.pdfLinkService.setHash(href.slice(hashIndex + 1));
        }
    }

    function handleCitationLinkClick(event) {
        if (!citationPreviewOptions.enabled) {
            return;
        }
        const anchor = event.target?.closest?.('.annotationLayer section[data-internal-link] > a');
        if (!anchor) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        (async () => {
            const clickedItem = await getInternalLinkItem(anchor);
            if (!clickedItem?.dest) {
                navigateInternalLink(clickedItem, anchor);
                return;
            }

            const cluster = await buildCitationCluster(clickedItem);
            if (!cluster) {
                navigateInternalLink(clickedItem, anchor);
                return;
            }
            showCitationPopover(cluster);
        })().catch(() => navigateInternalLink(null, anchor));
    }

    function closeCitationPopover() {
        if (citationPreviewState.activePopover) {
            citationPreviewState.activePopover.remove();
        }
        citationPreviewState.activePopover = null;
        citationPreviewState.activeCluster = null;
        citationPreviewState.activeRequestId++;
    }

    const CitationPreviewIcons = {
        prev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>',
        next: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>',
        close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
        jump: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13L11 5M7 5h4v4"/></svg>',
        copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/></svg>',
        check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5L6.5 11.5 12.5 5"/></svg>',
        loading: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2a6 6 0 1 1-6 6" opacity="0.9"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path></svg>',
        warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5L14 13H2z"/><path d="M8 6.5v3.2M8 11.5v.1"/></svg>',
    };

    function createCitationPreviewIconButton(iconKey, title, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'citationPreviewIconButton';
        button.innerHTML = CitationPreviewIcons[iconKey] || '';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick(button);
        });
        return button;
    }

    function createCitationPreviewActionButton({label, iconKey, variant, title, onClick}) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `citationPreviewActionButton citationPreviewActionButton--${variant || 'secondary'}`;
        button.title = title || label;
        if (iconKey && CitationPreviewIcons[iconKey]) {
            const icon = document.createElement('span');
            icon.className = 'citationPreviewActionIcon';
            icon.innerHTML = CitationPreviewIcons[iconKey];
            button.appendChild(icon);
        }
        const text = document.createElement('span');
        text.className = 'citationPreviewActionLabel';
        text.textContent = label;
        button.appendChild(text);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick(button);
        });
        return button;
    }

    function showCitationPopover(cluster) {
        citationPreviewState.activeCluster = cluster;
        if (!citationPreviewState.activePopover) {
            const popover = document.createElement('div');
            popover.className = 'citationPreviewPopover';
            popover.setAttribute('role', 'dialog');
            popover.addEventListener('click', event => event.stopPropagation());
            citationPreviewState.activePopover = popover;
            document.body.appendChild(popover);
        }
        renderCitationPopover();
        loadActiveCitationReference();
    }

    function renderCitationPopover() {
        const cluster = citationPreviewState.activeCluster;
        const popover = citationPreviewState.activePopover;
        if (!cluster || !popover) {
            return;
        }

        const item = cluster.items[cluster.activeIndex];
        popover.replaceChildren();

        // ---- Header ----
        const header = document.createElement('div');
        header.className = 'citationPreviewHeader';

        const labelGroup = document.createElement('div');
        labelGroup.className = 'citationPreviewLabelGroup';
        const badge = document.createElement('span');
        badge.className = 'citationPreviewBadge';
        const resolvedLabel = item.displayLabel || item.reference?.label || '';
        badge.textContent = resolvedLabel || '?';
        if (!resolvedLabel) {
            badge.classList.add('citationPreviewBadge--placeholder');
        }
        const kind = document.createElement('span');
        kind.className = 'citationPreviewKind';
        kind.textContent = 'Reference';
        labelGroup.append(badge, kind);

        const controls = document.createElement('div');
        controls.className = 'citationPreviewControls';
        if (cluster.items.length > 1) {
            const counter = document.createElement('span');
            counter.className = 'citationPreviewCounter';
            counter.textContent = `${cluster.activeIndex + 1} / ${cluster.items.length}`;
            const prev = createCitationPreviewIconButton('prev', 'Previous reference', () => changeCitationPreviewItem(-1));
            const next = createCitationPreviewIconButton('next', 'Next reference', () => changeCitationPreviewItem(1));
            controls.append(prev, counter, next);
            const divider = document.createElement('span');
            divider.className = 'citationPreviewDivider';
            controls.append(divider);
        }
        const close = createCitationPreviewIconButton('close', 'Close', closeCitationPopover);
        controls.append(close);

        header.append(labelGroup, controls);

        // ---- Body ----
        const body = document.createElement('div');
        body.className = 'citationPreviewBody';
        if (item.error) {
            body.classList.add('citationPreviewError');
            const status = document.createElement('div');
            status.className = 'citationPreviewStatus';
            status.innerHTML = CitationPreviewIcons.warn;
            const text = document.createElement('span');
            text.textContent = 'Reference preview unavailable.';
            status.append(text);
            body.append(status);
        } else if (!item.reference) {
            body.classList.add('citationPreviewLoading');
            const status = document.createElement('div');
            status.className = 'citationPreviewStatus';
            status.innerHTML = CitationPreviewIcons.loading;
            const text = document.createElement('span');
            text.textContent = 'Resolving reference…';
            status.append(text);
            const skeleton = document.createElement('div');
            skeleton.className = 'citationPreviewSkeleton';
            skeleton.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
            body.append(status, skeleton);
        } else {
            if (item.reference.marker) {
                const marker = document.createElement('div');
                marker.className = 'citationPreviewMarker';
                marker.textContent = item.reference.marker;
                body.append(marker);
            }
            const text = document.createElement('div');
            text.className = 'citationPreviewText';
            text.textContent = item.reference.text;
            body.append(text);
        }

        // ---- Footer actions ----
        const actions = document.createElement('div');
        actions.className = 'citationPreviewActions';

        const copy = createCitationPreviewActionButton({
            label: 'Copy',
            iconKey: 'copy',
            variant: 'secondary',
            title: 'Copy reference text',
            onClick: (button) => {
                const text = item.reference?.text;
                if (!text || !navigator.clipboard) {
                    return;
                }
                navigator.clipboard.writeText(text).then(() => {
                    const labelNode = button.querySelector('.citationPreviewActionLabel');
                    const iconNode = button.querySelector('.citationPreviewActionIcon');
                    if (labelNode) { labelNode.textContent = 'Copied'; }
                    if (iconNode) { iconNode.innerHTML = CitationPreviewIcons.check; iconNode.classList.add('citationPreviewCopied'); }
                    setTimeout(() => {
                        if (labelNode) { labelNode.textContent = 'Copy'; }
                        if (iconNode) { iconNode.innerHTML = CitationPreviewIcons.copy; iconNode.classList.remove('citationPreviewCopied'); }
                    }, 1100);
                });
            },
        });
        copy.disabled = !item.reference;

        const spacer = document.createElement('div');
        spacer.className = 'citationPreviewSpacer';

        const go = createCitationPreviewActionButton({
            label: 'Jump to reference',
            iconKey: 'jump',
            variant: 'primary',
            title: 'Jump to reference',
            onClick: () => navigateInternalLink(item, item.anchor),
        });

        actions.append(copy, spacer, go);

        popover.append(header, body, actions);
        positionCitationPopover();
    }

    function changeCitationPreviewItem(delta) {
        const cluster = citationPreviewState.activeCluster;
        if (!cluster || cluster.items.length <= 1) {
            return;
        }
        cluster.activeIndex = (cluster.activeIndex + delta + cluster.items.length) % cluster.items.length;
        renderCitationPopover();
        loadActiveCitationReference();
    }

    function loadActiveCitationReference() {
        const cluster = citationPreviewState.activeCluster;
        if (!cluster) {
            return;
        }
        const item = cluster.items[cluster.activeIndex];
        if (item.reference || item.error) {
            return;
        }
        const requestId = ++citationPreviewState.activeRequestId;
        resolveReferenceForItem(item)
            .then(reference => {
                if (requestId !== citationPreviewState.activeRequestId) {
                    return;
                }
                item.reference = reference;
                if (!item.displayLabel && reference?.label) {
                    item.displayLabel = reference.label;
                }
                renderCitationPopover();
            })
            .catch(error => {
                if (requestId !== citationPreviewState.activeRequestId) {
                    return;
                }
                item.error = error;
                renderCitationPopover();
            });
    }

    function positionCitationPopover() {
        const popover = citationPreviewState.activePopover;
        const cluster = citationPreviewState.activeCluster;
        if (!popover || !cluster) {
            return;
        }
        const item = cluster.items[cluster.activeIndex];
        const anchorRect = getSourceRect(item.anchor);
        if (anchorRect.bottom < 0 || anchorRect.top > window.innerHeight || anchorRect.right < 0 || anchorRect.left > window.innerWidth) {
            closeCitationPopover();
            return;
        }

        popover.style.visibility = 'hidden';
        popover.style.left = '0px';
        popover.style.top = '0px';
        const popoverRect = popover.getBoundingClientRect();
        const margin = 12;
        let left = Math.min(Math.max(anchorRect.left, margin), window.innerWidth - popoverRect.width - margin);
        let top = anchorRect.bottom + 8;
        if (top + popoverRect.height > window.innerHeight - margin) {
            top = anchorRect.top - popoverRect.height - 8;
        }
        top = Math.min(Math.max(top, margin), window.innerHeight - popoverRect.height - margin);
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
        popover.style.visibility = 'visible';
    }

    function handleCitationPreviewOutsideClick(event) {
        const popover = citationPreviewState.activePopover;
        if (!popover) {
            return;
        }
        if (popover.contains(event.target)) {
            return;
        }
        if (event.target?.closest?.('.annotationLayer section[data-internal-link] > a')) {
            return;
        }
        closeCitationPopover();
    }

    function handleCitationPreviewKeydown(event) {
        if (event.key === 'Escape') {
            closeCitationPopover();
        }
    }

    function enableCitationPreview() {
        if (citationPreviewState.listenersEnabled) {
            return;
        }
        const viewerContainer = getViewerContainer();
        if (!viewerContainer) {
            return;
        }
        viewerContainer.addEventListener('click', handleCitationLinkClick, true);
        viewerContainer.addEventListener('scroll', positionCitationPopover, {passive: true});
        document.addEventListener('click', handleCitationPreviewOutsideClick, true);
        document.addEventListener('keydown', handleCitationPreviewKeydown, true);
        window.addEventListener('resize', invalidateCitationPreviewLayout);
        citationPreviewState.listenersEnabled = true;
    }

    //Reference: https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.js#L163
    function syncPdf(pageElem, pageNum, clientX, clientY, innerText) {
        const pageCanvas = pageElem.querySelector('canvas');
        const pageRect = pageCanvas.getBoundingClientRect();
        const {viewport} = PDFViewerApplication.pdfViewer.getPageView(pageNum - 1);
        const dx = clientX - pageRect.left;
        const dy = clientY - pageRect.top;
        let [left, top] = viewport.convertToPdfPoint(dx, dy);
        top = viewport.viewBox[3] - top;
        vscode.postMessage({
            type: 'syncPdf',
            content: { page: Number(pageNum), h: left, v: top, identifier: innerText},
        });
        backupPdfViewerState();
    }

    window.addEventListener('load', async () => {
        // init pdf.js configuration
        PDFViewerApplication.initializedPromise
        .then(() => {
            const {eventBus, _boundEvents} = PDFViewerApplication;
            eventBus._off("beforeprint", _boundEvents.beforePrint);
            eventBus.on('documentloaded', updatePdfViewerState);
            // backup scale
            eventBus._on('scalechanged', backupPdfViewerState);
            eventBus._on("zoomin", backupPdfViewerState);
            eventBus._on("zoomout", backupPdfViewerState);
            eventBus._on("zoomreset", backupPdfViewerState);
            // backup scroll/spread mode
            eventBus._on("switchscrollmode", backupPdfViewerState);
            eventBus._on("scrollmodechanged", backupPdfViewerState);
            eventBus._on("switchspreadmode", backupPdfViewerState);
            eventBus._on("resize", invalidateCitationPreviewLayout);
            eventBus._on("scalechanged", invalidateCitationPreviewLayout);
            eventBus._on("scalechanging", invalidateCitationPreviewLayout);
            eventBus._on("switchscrollmode", invalidateCitationPreviewLayout);
            eventBus._on("scrollmodechanged", invalidateCitationPreviewLayout);
            eventBus._on("switchspreadmode", invalidateCitationPreviewLayout);
            enableCitationPreview();
            vscode.postMessage({type: 'ready'});
        });

        // add message listener
        window.addEventListener('message', async (e) => {
            const message = e.data;
            switch (message.type) {
                case 'update':
                    updatePdf(message.content);
                    break;
                case 'syncCode':
                    syncCode(message.content);
                    break;
                case 'initState':
                    updatePdfViewerDefaults(message.defaults);
                    if (message.content!==undefined) {
                        Object.assign(globalPdfViewerState, message.content);
                    }
                    if (message.colorThemes!==undefined) {
                        updateColorThemes(message.colorThemes);
                    }
                    updateCitationPreviewOptions(message.citationPreview);
                    updatePdfViewerState();
                    enableThemeToggleButton( Object.keys(ColorThemes).indexOf(globalPdfViewerState.colorTheme) );
                    break;
                default:
                    break;
            }
        });

        // add mouse double click listener
        window.addEventListener('dblclick', (e) => {
            const pageElem = e.target.parentElement.parentElement;
            const pageNum = pageElem.getAttribute('data-page-number');
            if (pageNum === null || pageNum === undefined) {
                return;
            }
            syncPdf(pageElem, pageNum, e.clientX, e.clientY, e.target.innerText);
        });

        // Display Error Message
        window.onerror = () => {
            const msg = document.createElement('body');
            msg.innerText = 'An error occurred while loading the file. Please open it again.';
            document.body = msg;
        };
    }, { once : true });

}());
