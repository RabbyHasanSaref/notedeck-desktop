const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const htmlToDocx = require('html-to-docx');
const packageMetadata = require('./package.json');

let mainWindow;
let activePrintWindow;
let printInProgress = false;
const rendererUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const appIconPath = path.join(__dirname, 'assets', 'notedeck.png');
app.setName('NoteDeck');
app.setAppUserModelId('com.codvanta365.notedeck');

function isTrustedRenderer(event) {
    return event.senderFrame?.url === rendererUrl;
}

function isNoteData(data) {
    return data !== null &&
        typeof data === 'object' &&
        !Array.isArray(data) &&
        typeof data.title === 'string' &&
        typeof data.content === 'string';
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 700,
        minHeight: 500,
        title: 'NoteDeck',
        icon: appIconPath,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('context-menu', (event, params) => {
        if (params.pageURL !== rendererUrl || !params.isEditable) return;

        event.preventDefault();
        const template = [];
        if (params.editFlags?.canCut) template.push({ role: 'cut' });
        template.push({
            role: 'copy',
            enabled: Boolean(params.selectionText)
        });
        if (params.editFlags?.canPaste) template.push({ role: 'paste' });
        if (template.length) template.push({ type: 'separator' });
        template.push({ role: 'selectAll' });

        Menu.buildFromTemplate(template).popup({ window: mainWindow });
    });

    // নেটিভ মেনুবার হাইড করার জন্য এই লাইনটি অত্যন্ত জরুরি
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
    if (process.platform === 'darwin') {
        app.dock.setIcon(appIconPath);
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:about', async (event) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }

    const developer = typeof packageMetadata.author === 'string'
        ? packageMetadata.author
        : packageMetadata.author?.name || 'Unknown';
    const productVersion = packageMetadata.productVersion || app.getVersion();
    const technologies = [
        `Desktop runtime: Electron ${process.versions.electron}`,
        `Browser engine: Chromium ${process.versions.chrome}`,
        `JavaScript runtime: Node.js ${process.versions.node}`,
        `Interface: HTML5, CSS3, JavaScript`,
        `Storage: IndexedDB, localStorage`,
        `Electron APIs: contextBridge, IPC`,
        `Platform: ${process.platform} (${process.arch})`
    ].join('\n');

    await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: `About ${app.getName()}`,
        message: `${app.getName()} ${productVersion}`,
        detail: `${packageMetadata.description}\n\nDeveloper: ${developer}\nVersion: ${productVersion}\n\nTechnologies\n${technologies}`
    });

    return { success: true };
});

// Save / Save As
ipcMain.handle('file:save', async (event, data) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }
    if (!isNoteData(data) ||
        (data.filePath !== undefined && data.filePath !== null &&
            typeof data.filePath !== 'string')) {
        return { error: 'Invalid note data.' };
    }

    const { content, filePath, title } = data;
    let destination = filePath;

    if (!destination) {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Note',
            defaultPath: `${title || 'Untitled Note'}.txt`,
            filters: [
                { name: 'Text File', extensions: ['txt'] },
                { name: 'Markdown', extensions: ['md'] },
                { name: 'HTML', extensions: ['html'] },
                { name: 'JSON', extensions: ['json'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { canceled: true };
        }
        destination = result.filePath;
    }

    try {
        const ext = path.extname(destination).toLowerCase();
        await fs.writeFile(destination, serializeNote(data, ext), 'utf8');
        return {
            success: true,
            filePath: destination,
            format: ext.slice(1) || 'txt'
        };
    } catch (error) {
        dialog.showErrorBox('Save Failed', error.message);
        return { error: error.message };
    }
});

// Open Note
ipcMain.handle('file:open', async (event) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open Note',
        properties: ['openFile'],
        filters: [
            { name: 'Supported Notes', extensions: ['txt', 'md', 'html', 'json'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
    }

    const filePath = result.filePaths[0];

    try {
        const content = await fs.readFile(filePath, 'utf8');
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.json') {
            const note = JSON.parse(content);
            if (!note || typeof note !== 'object' || Array.isArray(note)) {
                throw new Error('The JSON file must contain a note object.');
            }

            return {
                success: true,
                filePath,
                format: 'json',
                title: typeof note.title === 'string' && note.title
                    ? note.title
                    : path.basename(filePath, ext),
                content: typeof note.body === 'string'
                    ? note.body
                    : typeof note.content === 'string' ? note.content : ''
            };
        }

        const exportedBody = content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
        return {
            success: true,
            filePath,
            format: ext.slice(1) || 'txt',
            title: path.basename(filePath, ext),
            content: ext === '.html'
                ? (exportedBody ? sanitizeExportHtml(exportedBody) : htmlToText(content))
                : content
        };
    } catch (error) {
        dialog.showErrorBox('Open Failed', error.message);
        return { error: error.message };
    }
});

// Export
ipcMain.handle('file:export', async (event, data) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }
    const extensionsByFormat = {
        pdf: 'pdf',
        docx: 'docx',
        txt: 'txt',
        md: 'md',
        html: 'html',
        json: 'json'
    };
    if (!isNoteData(data) ||
        !Object.prototype.hasOwnProperty.call(extensionsByFormat, data.format)) {
        return { error: 'Invalid note data.' };
    }

    const extension = extensionsByFormat[data.format];
    const formatNames = {
        pdf: 'PDF',
        docx: 'Word Document',
        txt: 'Plain Text',
        md: 'Markdown',
        html: 'HTML',
        json: 'JSON'
    };
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Note',
        defaultPath: `${safeFilename(data.title)}.${extension}`,
        filters: [
            { name: formatNames[data.format], extensions: [extension] }
        ]
    });

    if (result.canceled || !result.filePath) {
        return { canceled: true };
    }

    try {
        const content = data.format === 'pdf'
            ? await renderNotePdf(data)
            : data.format === 'docx'
                ? await renderNoteDocx(data)
                : serializeNote(data, `.${extension}`);
        await fs.writeFile(result.filePath, content);
        return {
            success: true,
            filePath: result.filePath,
            format: extension
        };
    } catch (error) {
        dialog.showErrorBox('Export Failed', error.message);
        return { error: error.message };
    }
});

ipcMain.handle('file:print', async (event, data) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }
    if (!isNoteData(data)) {
        return { error: 'Invalid note data.' };
    }
    if (printInProgress || (activePrintWindow && !activePrintWindow.isDestroyed())) {
        return { error: 'A print job is already running.' };
    }

    printInProgress = true;
    let printWindow;
    let temporaryDirectory;
    try {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'notedeck-print-'));
        const htmlPath = path.join(temporaryDirectory, 'note.html');
        await fs.writeFile(htmlPath, noteHtmlDocument(data), 'utf8');
        printWindow = new BrowserWindow({
            width: 900,
            height: 700,
            title: `Print Note - ${safeFilename(data.title)}`,
            parent: mainWindow,
            show: false,
            autoHideMenuBar: true,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        activePrintWindow = printWindow;
        await printWindow.loadFile(htmlPath);
        let imageTimeout;
        const failedImageCount = await Promise.race([
            printWindow.webContents.executeJavaScript(`Promise.all([
                document.fonts.ready,
                ...Array.from(document.images, image =>
                    image.decode().then(() => true, () => false))
            ]).then(results => results.slice(1).filter(loaded => !loaded).length)`),
            new Promise(resolve => {
                imageTimeout = setTimeout(() => resolve(null), 5000);
            })
        ]).finally(() => clearTimeout(imageTimeout));
        if (failedImageCount === null) {
            console.warn('Print image loading timed out; continuing with the available note content.');
        } else if (failedImageCount > 0) {
            console.warn(`Print skipped ${failedImageCount} unreadable image(s).`);
        }

        printWindow.show();
        printWindow.focus();
        const printResult = await new Promise(resolve => {
            printWindow.webContents.print({
                silent: false,
                printBackground: true
            }, (success, failureReason) => resolve({ success, failureReason }));
        });
        if (!printResult.success) {
            if (/cancel/i.test(printResult.failureReason || '')) {
                return { canceled: true };
            }
            return {
                error: printResult.failureReason
                    ? `Could not print: ${printResult.failureReason}`
                    : 'Could not print this note. Check the printer settings and try again.'
            };
        }
        return { success: true };
    } catch (error) {
        console.error('Print failed:', error);
        return { error: error.message };
    } finally {
        if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
        if (activePrintWindow === printWindow) activePrintWindow = null;
        if (temporaryDirectory) {
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
        printInProgress = false;
    }
});

ipcMain.handle('app:quit', (event) => {
    if (!isTrustedRenderer(event)) {
        return { error: 'Untrusted IPC sender.' };
    }

    app.quit();
});

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function safeFilename(title) {
    const filename = (title || 'Untitled Note')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .trim()
        .replace(/[. ]+$/g, '');
    return filename || 'Untitled Note';
}

function noteHtmlDocument(data) {
    const title = data.title || 'Untitled Note';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
@page{size:A4;margin:16mm}
body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;color:#111;margin:0;padding:0}
h1{font-size:24pt;margin:0 0 1.5em}
img{max-width:100%;height:auto}
mark{background:#fff176}
pre{white-space:pre-wrap}
blockquote{border-left:3px solid #bbb;margin-left:0;padding-left:1em;color:#444}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<main>${sanitizeExportHtml(data.content || '')}</main>
</body>
</html>`;
}

async function renderNotePdf(data) {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'notedeck-pdf-'));
    let pdfWindow;

    try {
        pdfWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        const htmlPath = path.join(temporaryDirectory, 'note.html');
        await fs.writeFile(htmlPath, noteHtmlDocument(data), 'utf8');
        await pdfWindow.loadFile(htmlPath);
        const failedImageCount = await pdfWindow.webContents.executeJavaScript(`Promise.all([
            document.fonts.ready,
            ...Array.from(document.images, image =>
                image.decode().then(() => true, () => false))
        ]).then(results => results.slice(1).filter(loaded => !loaded).length)`);
        if (failedImageCount > 0) {
            console.warn(`PDF export skipped ${failedImageCount} unreadable image(s).`);
        }
        return await pdfWindow.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 }
        });
    } finally {
        if (pdfWindow && !pdfWindow.isDestroyed()) pdfWindow.destroy();
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

async function renderNoteDocx(data) {
    return htmlToDocx(noteHtmlDocument(data), null, {
        title: data.title || 'Untitled Note',
        creator: 'NoteDeck'
    });
}

function serializeNote(data, ext) {
    const title = data.title || 'Untitled Note';

    if (ext === '.json') {
        return JSON.stringify({ title, body: data.content || '' }, null, 2);
    }

    if (ext === '.md') {
        return htmlToMarkdown(data.content || '');
    }

    if (ext === '.html') {
        return noteHtmlDocument(data);
    }

    return htmlToText(data.content || '');
}

function htmlToMarkdown(html) {
    let markdown = sanitizeExportHtml(html)
        .replace(/<img\b([^>]*)>/gi, (_, attributes) => {
            const src = attributes.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
            const alt = attributes.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
            return `![${alt}](${src})`;
        })
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attributes, text) => {
            const href = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
            return `[${text}](${href})`;
        })
        .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
        .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
        .replace(/<(?:del|s|strike)>([\s\S]*?)<\/(?:del|s|strike)>/gi, '~~$1~~')
        .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) =>
            `\n${'#'.repeat(Number(level))} ${text}\n`)
        .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) =>
            `\n${text.split(/\s*\n\s*/).filter(Boolean).map((line) => `> ${line}`).join('\n')}\n`)
        .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
        .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div)>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

    return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeExportHtml(html) {
    const allowedTags = new Set([
        'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2',
        'h3', 'h4', 'h5', 'h6', 'i', 'li', 'mark', 'ol', 'p', 'pre', 's',
        'strike', 'strong', 'u', 'ul'
    ]);

    return String(html).replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (tag, name, attributes) => {
        const normalized = name.toLowerCase();
        if (normalized === 'img' && !tag.startsWith('</')) {
            const src = attributes.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
            if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(src)) {
                return '';
            }
            const alt = attributes.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
            const decodedAlt = alt
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
            const width = attributes.match(/\bwidth\s*=\s*(["'])(\d+(?:\.\d+)?)\1/i)?.[2];
            const height = attributes.match(/\bheight\s*=\s*(["'])(\d+(?:\.\d+)?)\1/i)?.[2];
            const dimensions = [
                width ? ` width="${width}"` : '',
                height ? ` height="${height}"` : ''
            ].join('');
            return `<img src="${escapeHtml(src)}" alt="${escapeHtml(decodedAlt)}"${dimensions}>`;
        }
        if (normalized === 'a' && !tag.startsWith('</')) {
            const href = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
                ?.replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
            try {
                const url = new URL(href);
                if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '';
                return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">`;
            } catch {
                return '';
            }
        }
        if (!allowedTags.has(normalized)) return '';
        return tag.startsWith('</') ? `</${normalized}>` : `<${normalized}>`;
    });
}

function htmlToText(html) {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi, '$2')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}