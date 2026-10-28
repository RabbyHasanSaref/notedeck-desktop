
'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const STORAGE_KEY = 'notedeck.notes.v1';
const ACTIVE_KEY = 'notedeck.activeNote.v1';
const THEME_KEY = 'notedeck.theme.v1';
const IMAGE_DB_NAME = 'notedeck.images.v1';
const IMAGE_STORE_NAME = 'images';

const titleInput = $('#note-title');
const bodyInput = $('#note-body');
const notesList = $('#notes-list');
const listSearch = $('#list-search');
const globalSearch = $('#global-search');

let notes = loadNotes();
let activeId = localStorage.getItem(ACTIVE_KEY);
let sortMode = 'modified';
let recentOnly = false;
let saveTimer = null;
let theme = localStorage.getItem(THEME_KEY) || 'dark';
let imageDatabasePromise = null;
let selectedEditorImage = null;
let imageMoveState = null;
let pendingHyperlinkRange = null;

function createNoteData(title = 'Untitled', content = '', folder = 'Personal') {
    const now = new Date().toISOString();

    return {
        id: crypto.randomUUID(),
        title,
        content,
        createdAt: now,
        modifiedAt: now,
        folder,
        filePath: null,
        format: 'txt',
        isDraft: false
    };
}

function loadNotes() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : [];

        if (!Array.isArray(data)) return [];

        return data.filter((note) =>
            note &&
            typeof note.id === 'string' &&
            typeof note.title === 'string' &&
            typeof note.content === 'string'
        );
    } catch (error) {
        console.error('Could not load notes:', error);
        return [];
    }
}

function persistNotes() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
        localStorage.setItem(ACTIVE_KEY, activeId || '');
        return true;
    } catch (error) {
        console.error('Could not persist notes:', error);
        setStatus('Storage error. Export your notes as a backup.');
        return false;
    }
}

function getImageDatabase() {
    if (!imageDatabasePromise) {
        imageDatabasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(IMAGE_DB_NAME, 2);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(IMAGE_STORE_NAME)) {
                    request.result.createObjectStore(IMAGE_STORE_NAME);
                }
            };
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
            request.onerror = () => reject(
                request.error || new Error('Could not open image storage.')
            );
            request.onblocked = () => reject(
                new Error('Close other NoteDeck windows to update image storage.')
            );
        });
    }

    return imageDatabasePromise;
}

async function storeImage(id, blob) {
    const database = await getImageDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite');
        transaction.objectStore(IMAGE_STORE_NAME).put(blob, id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
            transaction.error || new Error('Could not save the image.')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('Image storage was interrupted.')
        );
    });
}

async function getStoredImage(id) {
    const database = await getImageDatabase();
    return new Promise((resolve, reject) => {
        const request = database.transaction(IMAGE_STORE_NAME)
            .objectStore(IMAGE_STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(
            request.error || new Error('Could not load the saved image.')
        );
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(
            reader.error || new Error('Could not read the image.')
        );
        reader.readAsDataURL(blob);
    });
}

function dataUrlToBlob(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+=*)$/i.exec(dataUrl);
    if (!match) throw new Error('The image data is not supported.');

    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: match[1] });
}

function getStoredImageId(src) {
    const match = /^notedeck-image:([a-z\d-]{1,100})$/i.exec(src || '');
    return match?.[1] || null;
}

function getActiveNote() {
    return notes.find((note) => note.id === activeId) || null;
}

function setStatus(message) {
    $('#status-message').textContent = message;
}

function formatDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const targetDay = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
    );

    const difference = Math.round((today - targetDay) / 86400000);

    if (difference === 0) {
        return `Today · ${date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        })}`;
    }

    if (difference === 1) {
        return `Yesterday · ${date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        })}`;
    }

    return date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
}

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizeLinkUrl(value) {
    const input = value.trim();
    if (!input) return null;

    const candidate = /^[a-z][a-z\d+.-]*:/i.test(input)
        ? input
        : `https://${input}`;
    try {
        const url = new URL(candidate);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol)
            ? url.href
            : null;
    } catch {
        return null;
    }
}

function openHyperlinkDialog() {
    if (bodyInput.getAttribute('aria-disabled') === 'true') return;

    pendingHyperlinkRange = getEditorSelectionRange();
    if (!pendingHyperlinkRange) {
        setStatus('Place the cursor or select text in the editor first');
        return;
    }

    const startElement = pendingHyperlinkRange.startContainer.nodeType === Node.ELEMENT_NODE
        ? pendingHyperlinkRange.startContainer
        : pendingHyperlinkRange.startContainer.parentElement;
    const existingLink = startElement?.closest('a');
    $('#link-url').value = existingLink && bodyInput.contains(existingLink)
        ? existingLink.href
        : '';
    $('#link-dialog').showModal();
    $('#link-url').focus();
}

function applyHyperlink(enteredUrl) {
    const range = pendingHyperlinkRange;
    pendingHyperlinkRange = null;
    if (!range || !bodyInput.contains(range.commonAncestorContainer)) return;

    const href = normalizeLinkUrl(enteredUrl);
    if (!href) {
        setStatus('Enter a valid http, https, or mailto link');
        return;
    }

    bodyInput.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const existingLink = startElement?.closest('a');
    if (existingLink && bodyInput.contains(existingLink) &&
        existingLink.contains(range.endContainer)) {
        existingLink.href = href;
        existingLink.target = '_blank';
        existingLink.rel = 'noopener noreferrer';
    } else {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        if (range.collapsed) {
            link.textContent = enteredUrl.trim();
        } else {
            link.append(range.extractContents());
        }
        range.insertNode(link);
        range.setStartAfter(link);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    if (commitEditorChanges()) setStatus('Hyperlink added');
}

function renderInlineMarkdown(text) {
    const code = [];
    let html = escapeHTML(text).replace(/`([^`]+)`/g, (_, value) => {
        const token = `\u0000${code.length}\u0000`;
        code.push(`<code>${value}</code>`);
        return token;
    });

    html = html
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>');

    return html.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

function sanitizeEditorHtml(html) {
    const allowedTags = new Set([
        'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2',
        'H3', 'H4', 'H5', 'H6', 'I', 'LI', 'OL', 'P', 'PRE', 'S',
        'STRIKE', 'STRONG', 'U', 'UL', 'MARK', 'IMG'
    ]);
    const parsed = new DOMParser().parseFromString(String(html), 'text/html');

    function cleanNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return document.createTextNode(node.nodeValue);
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.tagName)) {
            return null;
        }

        if (node.tagName === 'IMG') {
            const src = node.getAttribute('src') || '';
            const storedId = getStoredImageId(src);
            const isDataUrl =
                /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(src);
            const dataId = node.getAttribute('data-image-id') || '';
            const imageId = storedId ||
                ((isDataUrl || !src) && /^[a-z\d-]{1,100}$/i.test(dataId)
                    ? dataId
                    : null);
            if (!imageId && !isDataUrl) {
                return null;
            }
            const image = document.createElement('img');
            if (!imageId) image.src = src;
            image.alt = node.getAttribute('alt') || '';
            image.draggable = false;
            if (imageId) image.dataset.imageId = imageId;
            const width = node.style.width.match(/^\s*(\d+(?:\.\d+)?)px\s*$/)?.[1] ||
                node.getAttribute('width');
            const height = node.style.height.match(/^\s*(\d+(?:\.\d+)?)px\s*$/)?.[1] ||
                node.getAttribute('height');
            if (width && /^\d+(?:\.\d+)?$/.test(width)) {
                image.setAttribute('width', width);
            }
            if (height && /^\d+(?:\.\d+)?$/.test(height)) {
                image.setAttribute('height', height);
            }
            return image;
        }

        if (node.tagName === 'A') {
            const href = normalizeLinkUrl(node.getAttribute('href') || '');
            const link = href ? document.createElement('a') : document.createDocumentFragment();
            if (href) {
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            [...node.childNodes].forEach((child) => {
                const cleaned = cleanNode(child);
                if (cleaned) link.append(cleaned);
            });
            return link;
        }

        if (node.tagName === 'SPAN') {
            const style = node.getAttribute('style') || '';
            if (/^\s*background-color\s*:\s*(?:rgb\(\s*255\s*,\s*241\s*,\s*118\s*\)|rgb\(\s*255\s*,\s*255\s*,\s*0\s*\)|#fff176|#ffff00)\s*;?\s*$/i.test(style)) {
                const mark = document.createElement('mark');
                [...node.childNodes].forEach((child) => {
                    const cleaned = cleanNode(child);
                    if (cleaned) mark.append(cleaned);
                });
                return mark;
            }
        }

        const outputTag = allowedTags.has(node.tagName)
            ? node.tagName.toLowerCase()
            : null;
        const output = outputTag
            ? document.createElement(outputTag)
            : document.createDocumentFragment();
        [...node.childNodes].forEach((child) => {
            const cleaned = cleanNode(child);
            if (cleaned) output.append(cleaned);
        });
        return output;
    }

    const cleaned = document.createDocumentFragment();
    [...parsed.body.childNodes].forEach((node) => {
        const safeNode = cleanNode(node);
        if (safeNode) cleaned.append(safeNode);
    });
    const container = document.createElement('div');
    container.append(cleaned);
    return container.innerHTML;
}

function noteContentToHtml(content) {
    const value = String(content || '');
    if (!value.trim()) return '';
    if (/<\/?(?:a|b|blockquote|br|code|del|div|em|h[1-6]|i|img|li|mark|ol|p|pre|s|strike|strong|u|ul)\b/i.test(value)) {
        return sanitizeEditorHtml(value);
    }
    return renderMarkdown(value);
}

function noteContentToText(content) {
    const container = document.createElement('div');
    container.innerHTML = noteContentToHtml(content);

    function readNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        if (node.tagName === 'BR') return '\n';
        if (node.tagName === 'IMG') return node.getAttribute('alt') || '';

        const text = [...node.childNodes].map(readNode).join('');
        return ['BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE']
            .includes(node.tagName)
            ? `${text}\n`
            : text;
    }

    return [...container.childNodes].map(readNode).join('').trim();
}

function renderMarkdown(markdown) {
    const output = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];

    const flushParagraph = () => {
        if (paragraph.length) {
            output.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
            paragraph = [];
        }
    };

    const flushList = () => {
        if (!listItems.length) return;
        const items = listItems.map((item) => {
            if (listType === 'check') {
                const checked = item.checked ? ' checked' : '';
                return `<li><label><input type="checkbox" disabled${checked}> ${renderInlineMarkdown(item.text)}</label></li>`;
            }
            return `<li>${renderInlineMarkdown(item)}</li>`;
        }).join('');
        output.push(`<${listType === 'number' ? 'ol' : 'ul'}>${items}</${listType === 'number' ? 'ol' : 'ul'}>`);
        listItems = [];
        listType = null;
    };

    for (const line of String(markdown).split(/\r?\n/)) {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        const quote = line.match(/^>\s?(.*)$/);
        const checklist = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
        const matchedList = checklist || bullet || numbered;

        if (matchedList) {
            flushParagraph();
            const nextType = checklist ? 'check' : numbered ? 'number' : 'bullet';
            if (listType !== nextType) flushList();
            listType = nextType;
            listItems.push(checklist
                ? { checked: checklist[1].toLowerCase() === 'x', text: checklist[2] }
                : matchedList[1]);
            continue;
        }

        flushList();
        if (!line.trim()) {
            flushParagraph();
        } else if (heading) {
            flushParagraph();
            const level = heading[1].length;
            output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        } else if (quote) {
            flushParagraph();
            output.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
        } else {
            paragraph.push(line);
        }
    }

    flushList();
    flushParagraph();
    return output.join('') || '<p class="preview-empty">Nothing to preview yet.</p>';
}

function getPreview(content) {
    const clean = noteContentToText(content)
        .replace(/^#+\s*/gm, '')
        .replace(/[*_`~]/g, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();

    return clean || 'No additional text';
}

function getFilteredNotes() {
    const query = listSearch.value.trim().toLocaleLowerCase();

    let result = notes.filter((note) => !note.isDraft).filter((note) => {
        const matchesSearch =
            !query ||
            note.title.toLocaleLowerCase().includes(query) ||
            noteContentToText(note.content).toLocaleLowerCase().includes(query);

        return matchesSearch;
    });

    if (recentOnly) {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        result = result.filter((note) => new Date(note.modifiedAt).getTime() >= cutoff);
    }

    result.sort((a, b) => {
        if (sortMode === 'title') {
            return a.title.localeCompare(b.title);
        }

        if (sortMode === 'created') {
            return new Date(b.createdAt) - new Date(a.createdAt);
        }

        return new Date(b.modifiedAt) - new Date(a.modifiedAt);
    });

    return result;
}

function renderNotes() {
    const filtered = getFilteredNotes();
    const savedNoteCount = notes.filter((note) => !note.isDraft).length;

    notesList.innerHTML = filtered.map((note) => {
        const selected = note.id === activeId;
        const title = note.title.trim() || 'Untitled';
        const preview = getPreview(note.content);

        return `
            <div class="note-card ${selected ? 'selected' : ''}"
                 data-note-id="${escapeHTML(note.id)}"
                 role="option"
                 aria-selected="${selected}"
                 tabindex="0">
                <div class="note-card-top">
                    <span class="note-card-title">${escapeHTML(title)}</span>
                    <button class="note-more"
                            data-note-action="delete"
                            data-note-id="${escapeHTML(note.id)}"
                            title="Delete note"
                            aria-label="Delete ${escapeHTML(title)}">⋯</button>
                </div>
                <p class="note-preview">${escapeHTML(preview)}</p>
                <div class="note-card-bottom">
                    <span class="note-folder">${escapeHTML(note.folder || 'Personal')}</span>
                    <time>${escapeHTML(formatDate(note.modifiedAt))}</time>
                </div>
            </div>`;
    }).join('');

    $('#notes-count').textContent = String(savedNoteCount);
    $('#visible-count').textContent =
        `${filtered.length} ${filtered.length === 1 ? 'note' : 'notes'}`;
    $('#status-note-count').textContent =
        `${savedNoteCount} ${savedNoteCount === 1 ? 'note' : 'notes'}`;

    const empty = filtered.length === 0;
    $('#empty-list').hidden = !empty;
    notesList.hidden = empty;

    if (empty) {
        const searching = listSearch.value.trim().length > 0;
        $('#empty-title').textContent = searching ? 'No matching notes' : 'No notes here';
        $('#empty-description').textContent = searching
            ? 'Try a different search term.'
            : 'Create a note to get started.';
    }

    $('#all-notes-button').classList.toggle('active', !recentOnly);
    $('#recent-button').classList.toggle('active', recentOnly);
}

function updateEditor() {
    const note = getActiveNote();
    const hasNote = Boolean(note);

    titleInput.disabled = !hasNote;
    bodyInput.contentEditable = String(hasNote);
    bodyInput.setAttribute('aria-disabled', String(!hasNote));

    if (!note) {
        titleInput.value = '';
        bodyInput.innerHTML = '';
        $('#editor-note-name').textContent = 'No note selected';
        $('#editor-date').textContent = 'Create or select a note';
        $('#editor-word-count').textContent = '0 words';
        $('#character-count').textContent = '0 characters';
        $('#unsaved-dot').hidden = true;
        $('#save-indicator').textContent = 'No note selected';
        return;
    }

    titleInput.value = note.title;
    bodyInput.innerHTML = noteContentToHtml(note.content);
    selectedEditorImage = null;
    void hydrateEditorImages(note.id);

    $('#editor-note-name').textContent = note.title.trim() || 'Untitled';
    $('#editor-date').textContent = `Modified ${formatDate(note.modifiedAt)}`;

    updateEditorCounts();
    $('#unsaved-dot').hidden = true;
    $('#save-indicator').textContent = 'All changes saved';
}

async function hydrateEditorImages(noteId) {
    const images = [...bodyInput.querySelectorAll('img[data-image-id], img[src^="notedeck-image:"]')];

    for (const image of images) {
        const id = image.dataset.imageId ||
            getStoredImageId(image.getAttribute('src'));
        if (!id) continue;

        try {
            const blob = await getStoredImage(id);
            if (!blob) {
                setStatus('A saved image is missing from local image storage');
                continue;
            }
            if (activeId !== noteId || !image.isConnected) return;
            image.src = await blobToDataUrl(blob);
            image.dataset.imageId = id;
        } catch (error) {
            console.error('Could not load saved image:', error);
            setStatus(`Could not load image: ${error.message}`);
        }
    }
}

async function materializeStoredImages(html) {
    const container = document.createElement('div');
    container.innerHTML = sanitizeEditorHtml(html);

    for (const image of container.querySelectorAll('img')) {
        const id = image.dataset.imageId ||
            getStoredImageId(image.getAttribute('src'));
        if (!id) continue;

        const blob = await getStoredImage(id);
        if (!blob) throw new Error('A saved image is missing from local image storage.');
        image.src = await blobToDataUrl(blob);
        image.removeAttribute('data-image-id');
    }

    return container.innerHTML;
}

async function externalizeDataImages(html) {
    const container = document.createElement('div');
    container.innerHTML = sanitizeEditorHtml(html);

    for (const image of container.querySelectorAll('img')) {
        const src = image.getAttribute('src') || '';
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(src)) {
            continue;
        }

        const id = crypto.randomUUID();
        await storeImage(id, dataUrlToBlob(src));
        image.dataset.imageId = id;
        image.removeAttribute('src');
    }

    return container.innerHTML;
}

function resizeSelectedImage(amount) {
    if (!selectedEditorImage?.isConnected || !bodyInput.contains(selectedEditorImage)) {
        setStatus('Select an image in the note first');
        return;
    }

    const currentWidth = selectedEditorImage.getBoundingClientRect().width;
    const minWidth = Math.min(80, currentWidth);
    const maxWidth = Math.max(minWidth, bodyInput.clientWidth);
    const nextWidth = Math.round(
        Math.max(minWidth, Math.min(maxWidth, currentWidth + amount))
    );
    if (nextWidth === Math.round(currentWidth)) return;

    selectedEditorImage.setAttribute('width', String(nextWidth));
    selectedEditorImage.removeAttribute('height');
    selectedEditorImage.style.removeProperty('width');
    selectedEditorImage.style.removeProperty('height');
    if (commitEditorChanges()) setStatus('Image size updated');
}

function updateEditorCounts() {
    const text = noteContentToText(bodyInput.innerHTML);
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;

    $('#editor-word-count').textContent =
        `${words} ${words === 1 ? 'word' : 'words'}`;
    $('#character-count').textContent =
        `${text.length} ${text.length === 1 ? 'character' : 'characters'}`;
}

function selectNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note) return;

    activeId = id;
    persistNotes();
    renderNotes();
    updateEditor();
    bodyInput.focus();
}

function commitEditorChanges() {
    const note = getActiveNote();
    if (!note) return;

    note.title = titleInput.value;
    note.content = sanitizeEditorHtml(bodyInput.innerHTML);
    note.isDraft = !note.title.trim() && !noteContentToText(note.content).trim();
    note.modifiedAt = new Date().toISOString();

    const saved = persistNotes();
    renderNotes();

    $('#editor-note-name').textContent = note.title.trim() || 'Untitled';
    $('#editor-date').textContent = `Modified ${formatDate(note.modifiedAt)}`;
    $('#unsaved-dot').hidden = false;
    $('#save-indicator').textContent = saved ? 'Saving...' : 'Storage error';

    updateEditorCounts();

    clearTimeout(saveTimer);

    if (!saved) return false;

    saveTimer = setTimeout(() => {
        $('#unsaved-dot').hidden = true;
        $('#save-indicator').textContent = 'Saved locally';
        setStatus('Changes saved locally');
    }, 500);
    return true;
}

function createNote(focusTarget = 'title') {
    const activeNote = getActiveNote();
    if (activeNote?.isDraft) {
        focusNewNoteEditor(activeNote, focusTarget);
        return;
    }

    const note = createNoteData('', '');
    note.isDraft = true;

    notes.unshift(note);
    activeId = note.id;
    recentOnly = false;
    $('#list-heading').textContent = 'All Notes';
    $('#list-subtitle').textContent = 'Your notes in one place';

    listSearch.value = '';
    globalSearch.value = '';

    persistNotes();
    renderNotes();
    updateEditor();

    focusNewNoteEditor(note, focusTarget);
    setStatus('New note created');
}

function focusNewNoteEditor(note, focusTarget) {
    const focusEditor = () => {
        const target = focusTarget === 'body' ? bodyInput : titleInput;
        target.focus();
        if (target === titleInput) titleInput.select();
    };
    focusEditor();
    requestAnimationFrame(() => {
        if (getActiveNote()?.id === note.id) {
            focusEditor();
        }
    });
}

window.addEventListener('focus', () => {
    const note = getActiveNote();
    if (!note?.isDraft) return;

    if (titleInput.disabled || bodyInput.contentEditable !== 'true') {
        updateEditor();
    }

    if (document.activeElement !== titleInput &&
        document.activeElement !== bodyInput) {
        titleInput.focus();
        titleInput.select();
    }
});

$('.editor-panel').addEventListener('pointerdown', (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest('#note-title, #note-body');
    if (!target) return;

    if (!getActiveNote()) {
        createNote(target === bodyInput ? 'body' : 'title');
        return;
    }

    if (titleInput.disabled || bodyInput.contentEditable !== 'true') {
        updateEditor();
        requestAnimationFrame(() => {
            target.focus();
            if (target === titleInput) titleInput.select();
        });
    }
}, true);

function deleteNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note) return;

    const confirmed = window.confirm(
        `Delete "${note.title.trim() || 'Untitled'}"? This cannot be undone.`
    );

    if (!confirmed) return;

    notes = notes.filter((item) => item.id !== id);

    if (activeId === id) {
        activeId = notes[0]?.id || null;
    }

    persistNotes();
    renderNotes();
    updateEditor();
    setStatus('Note deleted');
}

function syncSearch(value) {
    listSearch.value = value;
    globalSearch.value = value;
    $('#clear-search').hidden = !value;
    renderNotes();
}

async function saveCurrentNote(saveAs = false) {
    const note = getActiveNote();

    if (!note) {
        setStatus('Create a note first');
        return;
    }

    if (!window.noteDeck?.save) {
        setStatus('File save API is unavailable');
        return;
    }

    try {
        const content = await materializeStoredImages(note.content);
        const result = await window.noteDeck.save({
            filePath: saveAs ? null : note.filePath,
            title: note.title.trim() || 'Untitled',
            content,
            format: note.format || 'txt',
            saveAs
        });

        if (result?.error) {
            setStatus(`Save failed: ${result.error}`);
            return;
        }
        if (!result || result.canceled) {
            setStatus('Save cancelled');
            return;
        }
        if (!result.success || !result.filePath) {
            throw new Error('The note was not saved.');
        }

        note.filePath = result.filePath;
        note.format = result.format || note.format || 'txt';
        note.modifiedAt = new Date().toISOString();

        persistNotes();
        renderNotes();
        updateEditor();
        setStatus('Note saved to file');
    } catch (error) {
        console.error(error);
        window.alert(`Could not save the note:\n${error.message}`);
    }
}

async function openFile() {
    if (!window.noteDeck?.open) {
        setStatus('File open API is unavailable');
        return;
    }

    try {
        const result = await window.noteDeck.open();
        if (!result || result.canceled) return;
        if (result.error) {
            setStatus(`Open failed: ${result.error}`);
            return;
        }
        if (!result.success) throw new Error('The file was not opened.');

        const content = await externalizeDataImages(result.content || '');
        const note = createNoteData(result.title || 'Untitled', content);
        note.filePath = result.filePath;
        note.format = result.format || 'txt';
        note.modifiedAt = new Date().toISOString();

        notes.unshift(note);
        activeId = note.id;

        persistNotes();
        renderNotes();
        updateEditor();
        bodyInput.focus();
        setStatus('File opened');
    } catch (error) {
        console.error(error);
        window.alert(`Could not open the file:\n${error.message}`);
    }
}

async function exportCurrentNote() {
    const note = getActiveNote();
    if (!note) return;

    if (!window.noteDeck?.exportNote) {
        setStatus('Export API is unavailable');
        return;
    }

    $('#export-dialog').showModal();
}

async function exportNoteWithFormat(format) {
    const note = getActiveNote();
    if (!note) return;

    if (!['pdf', 'docx', 'json', 'txt', 'md', 'html'].includes(format)) {
        setStatus('Choose PDF, Word, JSON, TXT, Markdown, or HTML format');
        return;
    }

    try {
        const content = await materializeStoredImages(note.content);
        const result = await window.noteDeck.exportNote({
            title: note.title.trim() || 'Untitled',
            content,
            format
        });

        if (result?.error) {
            setStatus(`Export failed: ${result.error}`);
            return;
        }
        if (result?.canceled) return;
        if (!result?.success || !result.filePath) {
            throw new Error('The note was not exported.');
        }
        setStatus('Export completed');
    } catch (error) {
        console.error(error);
        window.alert(`Could not export the note:\n${error.message}`);
    }
}

async function printCurrentNote() {
    const note = getActiveNote();
    if (!note) {
        setStatus('Select a note before printing');
        return;
    }

    if (!window.noteDeck?.printNote) {
        setStatus('Print API is unavailable');
        return;
    }

    try {
        const content = await materializeStoredImages(note.content);
        const result = await window.noteDeck.printNote({
            title: note.title.trim() || 'Untitled',
            content
        });

        if (result?.error) {
            setStatus(`Print failed: ${result.error}`);
        } else if (result?.canceled) {
            setStatus('Print canceled');
        } else if (result?.success) {
            setStatus('Print completed');
        } else {
            throw new Error('The note was not sent to the printer.');
        }
    } catch (error) {
        console.error('Could not print the note:', error);
        setStatus(`Print failed: ${error.message}`);
    }
}

function formatSelection(type) {
    if (bodyInput.getAttribute('aria-disabled') === 'true') return;

    if (type === 'link') {
        openHyperlinkDialog();
        return;
    }

    if (type === 'highlight') {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!selection || !range ||
            !bodyInput.contains(range.commonAncestorContainer)) {
            setStatus('Select text in the editor to highlight it');
            return;
        }

        const mark = document.createElement('mark');
        if (range.collapsed) {
            mark.textContent = 'highlighted text';
            range.insertNode(mark);
            range.selectNodeContents(mark);
        } else {
            mark.append(range.extractContents());
            range.insertNode(mark);
            range.selectNodeContents(mark);
        }
        selection.removeAllRanges();
        selection.addRange(range);
        bodyInput.focus();
        if (commitEditorChanges()) setStatus('Text highlighted');
        return;
    }

    const inlineCommands = {
        bold: 'bold',
        italic: 'italic',
        underline: 'underline',
        strike: 'strikeThrough'
    };
    if (inlineCommands[type]) {
        document.execCommand(inlineCommands[type], false);
    } else if (type === 'heading') {
        document.execCommand('formatBlock', false, 'h2');
    } else if (type === 'quote') {
        document.execCommand('formatBlock', false, 'blockquote');
    } else if (type === 'code') {
        const selected = window.getSelection()?.toString() || 'code';
        document.execCommand(
            'insertHTML',
            false,
            `<code>${escapeHTML(selected)}</code>`
        );
    } else if (type === 'bullet') {
        document.execCommand('insertUnorderedList', false);
    } else if (type === 'number') {
        document.execCommand('insertOrderedList', false);
    } else if (type === 'checklist') {
        const lines = (window.getSelection()?.toString() || '').split(/\r?\n/);
        const list = `<ul>${lines.map((line) =>
            `<li>\u2610 ${escapeHTML(line)}</li>`
        ).join('')}</ul>`;
        document.execCommand('insertHTML', false, list);
    } else {
        return;
    }
    bodyInput.focus();
    commitEditorChanges();
}

function getEditorSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    return bodyInput.contains(range.commonAncestorContainer)
        ? range.cloneRange()
        : null;
}

async function insertImage() {
    if (bodyInput.getAttribute('aria-disabled') === 'true') {
        setStatus('Create or select a note before inserting an image');
        return;
    }

    const range = getEditorSelectionRange();
    const noteId = activeId;
    const imageInput = $('#image-file-input');
    imageInput.value = '';
    imageInput.dataset.noteId = noteId;
    imageInput._savedRange = range;
    imageInput.click();
}

$('#image-file-input').addEventListener('change', async (event) => {
    const imageInput = event.currentTarget;
    const file = imageInput.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
        setStatus('Choose a PNG, JPEG, GIF, or WebP image');
        imageInput.value = '';
        return;
    }
    if (imageInput.dataset.noteId !== activeId) {
        setStatus('Image insertion cancelled because the selected note changed');
        imageInput.value = '';
        return;
    }

    try {
        const imageId = crypto.randomUUID();
        await storeImage(imageId, file);

        if (imageInput.dataset.noteId !== activeId) {
            setStatus('Image insertion cancelled because the selected note changed');
            return;
        }

        const dataUrl = await blobToDataUrl(file);
        bodyInput.focus();
        const selection = window.getSelection();
        const range = imageInput._savedRange;
        if (range && bodyInput.contains(range.commonAncestorContainer)) {
            selection.removeAllRanges();
            selection.addRange(range);
        }
        document.execCommand(
            'insertHTML',
            false,
            `<img src="${dataUrl}" data-image-id="${imageId}" alt="${escapeHTML(file.name)}" draggable="true">`
        );
        if (commitEditorChanges()) {
            setStatus('Image inserted. Drag to move; select it and use Image −/+ to resize.');
        }
    } catch (error) {
        console.error('Could not insert image:', error);
        setStatus(`Could not insert image: ${error.message}`);
    } finally {
        imageInput.value = '';
        delete imageInput._savedRange;
    }
});

function closeMenus() {
    $$('.dropdown-menu').forEach((menu) => {
        menu.hidden = true;
    });

    $$('.menu-trigger').forEach((button) => {
        button.setAttribute('aria-expanded', 'false');
    });
}

function toggleMenu(button) {
    const menu = document.getElementById(button.dataset.menu);
    const shouldOpen = menu && menu.hidden;

    closeMenus();

    if (menu && shouldOpen) {
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
    }
}

async function runAction(action) {
    closeMenus();

    switch (action) {
        case 'new':
            createNote();
            break;
        case 'open':
            await openFile();
            break;
        case 'save':
            await saveCurrentNote(false);
            break;
        case 'save-as':
            await saveCurrentNote(true);
            break;
        case 'export':
            await exportCurrentNote();
            break;
        case 'about':
            if (!window.noteDeck?.about) {
                setStatus('About dialog is unavailable');
                break;
            }
            try {
                const result = await window.noteDeck.about();
                if (result?.error) setStatus(`Could not show About: ${result.error}`);
            } catch (error) {
                console.error(error);
                window.alert(`Could not show About:\n${error.message}`);
            }
            break;
        case 'quit':
            if (window.noteDeck?.quit) {
                await window.noteDeck.quit();
            } else {
                setStatus('Quit action is unavailable');
            }
            break;
        case 'print':
            await printCurrentNote();
            break;
        case 'delete':
            if (activeId) deleteNote(activeId);
            break;
        case 'find':
            bodyInput.focus();
            document.execCommand('selectAll');
            break;
        case 'select-all':
            bodyInput.focus();
            document.execCommand('selectAll');
            break;
        case 'toggle-sidebar':
            $('#sidebar').classList.toggle('collapsed');
            break;
        case 'toggle-theme':
            theme = theme === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = theme;
            localStorage.setItem(THEME_KEY, theme);
            break;
        case 'sort-newest':
            sortMode = 'modified';
            $('#sort-select').value = 'modified';
            renderNotes();
            break;
        case 'sort-title':
            sortMode = 'title';
            $('#sort-select').value = 'title';
            renderNotes();
            break;
        case 'word-count': {
            const note = getActiveNote();
            if (!note) break;

            const text = noteContentToText(note.content);
            const words = text.trim()
                ? text.trim().split(/\s+/u).length
                : 0;

            window.alert(
                `Words: ${words}\nCharacters: ${text.length}`
            );
            break;
        }
        case 'undo':
            document.execCommand('undo');
            break;
        case 'redo':
            document.execCommand('redo');
            break;
    }
}

// Menu dropdowns
$$('.menu-trigger').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMenu(button);
    });
});

$$('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
        void runAction(button.dataset.action);
    });
});

document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu-item')) closeMenus();
});

// Note cards: select, keyboard navigation, and delete
notesList.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-note-action="delete"]');

    if (deleteButton) {
        event.stopPropagation();
        deleteNote(deleteButton.dataset.noteId);
        return;
    }

    const card = event.target.closest('[data-note-id]');
    if (card) selectNote(card.dataset.noteId);
});

notesList.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-note-id]');
    if (!card || (event.key !== 'Enter' && event.key !== ' ')) return;

    event.preventDefault();
    selectNote(card.dataset.noteId);
});

$('#new-note-button').addEventListener('click', createNote);

$('#collapse-sidebar').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
});

$('#all-notes-button').addEventListener('click', () => {
    recentOnly = false;
    $('#list-heading').textContent = 'All Notes';
    $('#list-subtitle').textContent = 'Your notes in one place';
    renderNotes();
});

$('#recent-button').addEventListener('click', () => {
    recentOnly = true;
    $('#list-heading').textContent = 'Recently Modified';
    $('#list-subtitle').textContent = 'Notes updated in the last 7 days';
    renderNotes();
});

listSearch.addEventListener('input', () => syncSearch(listSearch.value));
globalSearch.addEventListener('input', () => syncSearch(globalSearch.value));

$('#clear-search').addEventListener('click', () => syncSearch(''));

$('#sort-select').addEventListener('change', (event) => {
    sortMode = event.target.value;
    renderNotes();
});

titleInput.addEventListener('input', commitEditorChanges);
bodyInput.addEventListener('input', commitEditorChanges);
bodyInput.addEventListener('click', (event) => {
    bodyInput.querySelectorAll('img[data-selected="true"]')
        .forEach((image) => image.removeAttribute('data-selected'));
    selectedEditorImage = event.target.closest?.('img') || null;
    if (selectedEditorImage && bodyInput.contains(selectedEditorImage)) {
        selectedEditorImage.dataset.selected = 'true';
    } else {
        selectedEditorImage = null;
    }
});
bodyInput.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
});

function getEditorCaretRange(x, y, movingImage) {
    let range = document.caretRangeFromPoint?.(x, y) || null;
    if (!range && document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (position) {
            range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
            range.collapse(true);
        }
    }

    if (!range || !bodyInput.contains(range.commonAncestorContainer)) return null;

    const targetImage = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer.childNodes[range.startOffset]
        : range.startContainer.parentElement?.closest('img');
    if (targetImage === movingImage) {
        const imageRect = movingImage.getBoundingClientRect();
        range = document.createRange();
        range.setStartBefore(movingImage);
        if (y > imageRect.top + imageRect.height / 2) {
            range.setStartAfter(movingImage);
        }
        range.collapse(true);
    }

    return range;
}

function finishImageMove(event, shouldMove) {
    const state = imageMoveState;
    if (!state || (event && event.pointerId !== state.pointerId)) return;
    imageMoveState = null;
    state.image.removeAttribute('data-moving');

    if (!shouldMove || !state.moved || !state.image.isConnected) return;

    const range = getEditorCaretRange(event.clientX, event.clientY, state.image);
    if (!range) return;

    range.insertNode(state.image);
    selectedEditorImage = state.image;
    bodyInput.querySelectorAll('img[data-selected="true"]')
        .forEach((image) => image.removeAttribute('data-selected'));
    state.image.dataset.selected = 'true';
    if (commitEditorChanges()) setStatus('Image moved');
}

bodyInput.addEventListener('pointerdown', (event) => {
    const image = event.target.closest?.('img');
    if (event.button !== 0 || !image || !bodyInput.contains(image)) return;

    event.preventDefault();
    imageMoveState = {
        image,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false
    };
});

document.addEventListener('pointermove', (event) => {
    const state = imageMoveState;
    if (!state || event.pointerId !== state.pointerId) return;

    if (!state.moved &&
        Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= 6) {
        state.moved = true;
        state.image.dataset.moving = 'true';
    }
    if (!state.moved) return;

    event.preventDefault();
    const range = getEditorCaretRange(event.clientX, event.clientY, state.image);
    if (range) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }
});

document.addEventListener('pointerup', (event) => finishImageMove(event, true));
document.addEventListener('pointercancel', (event) => finishImageMove(event, false));

$$('[data-format]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => formatSelection(button.dataset.format));
});

$('#link-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const urlInput = $('#link-url');
    const href = normalizeLinkUrl(urlInput.value);
    if (!href) {
        urlInput.setCustomValidity('Enter a valid http, https, or mailto link.');
        urlInput.reportValidity();
        return;
    }

    urlInput.setCustomValidity('');
    applyHyperlink(href);
    $('#link-dialog').close();
});
$('#link-url').addEventListener('input', (event) => {
    event.currentTarget.setCustomValidity('');
});
$('#link-cancel').addEventListener('click', () => $('#link-dialog').close());
$('#link-dialog').addEventListener('close', () => {
    pendingHyperlinkRange = null;
});

$('#export-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const format = $('#export-format').value;
    $('#export-dialog').close();
    void exportNoteWithFormat(format);
});
$('#export-cancel').addEventListener('click', () => $('#export-dialog').close());

$('#insert-image').addEventListener('mousedown', (event) => event.preventDefault());
$('#insert-image').addEventListener('click', () => void insertImage());
$('#image-smaller').addEventListener('mousedown', (event) => event.preventDefault());
$('#image-smaller').addEventListener('click', () => resizeSelectedImage(-50));
$('#image-larger').addEventListener('mousedown', (event) => event.preventDefault());
$('#image-larger').addEventListener('click', () => resizeSelectedImage(50));

document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
        closeMenus();
        return;
    }

    if (mod && ['b', 'i', 'u'].includes(key) &&
        document.activeElement === bodyInput) {
        event.preventDefault();
        formatSelection(({ b: 'bold', i: 'italic', u: 'underline' })[key]);
        return;
    }

    if (!mod) return;

    if (key === 'k') {
        event.preventDefault();
        globalSearch.focus();
    } else if (key === 'n') {
        event.preventDefault();
        createNote();
    } else if (key === 'o') {
        event.preventDefault();
        void openFile();
    } else if (key === 's') {
        event.preventDefault();
        void saveCurrentNote(event.shiftKey);
    } else if (key === 'p') {
        event.preventDefault();
        void printCurrentNote();
    } else if (key === 'f') {
        event.preventDefault();
        bodyInput.focus();
        document.execCommand('selectAll');
    } else if (key === 'a') {
        if (document.activeElement !== listSearch &&
            document.activeElement !== globalSearch) {
            event.preventDefault();
            bodyInput.focus();
            document.execCommand('selectAll');
        }
    }
});

// Initial setup
document.documentElement.dataset.theme = theme;
const welcomeNoteContent =
    '<p>Welcome to NoteDeck! This is your space to save ideas, thoughts, and reminders.</p>' +
    '<p>Keep this note and make it your own, or create a new note whenever you are ready to write something different.</p>';

if (!notes.some((note) => note.id === activeId)) {
    activeId = notes[0]?.id || null;
}

notes.forEach((note) => {
    if (note.title === 'Welcome to NoteDeck' &&
        note.content === '<h2>Your ideas, all in one place.</h2><p>Welcome to NoteDeck — a calm, simple space to capture thoughts, organize notes, and keep the details that matter close at hand.</p><p>Create a note to get started. Your notes are saved locally on this device.</p>') {
        note.title = 'Untitled';
        note.content = welcomeNoteContent;
    }
});

if (notes.length === 0) {
    const first = createNoteData('Untitled', welcomeNoteContent);
    notes.push(first);
    activeId = first.id;
}

persistNotes();
renderNotes();
updateEditor();
