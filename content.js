// --- Constants ---
const TRACK_ROW_SELECTOR = '[data-testid="tracklist-row"]';
const TITLE_SELECTOR = 'a[data-testid="internal-track-link"] > div';
const ARTIST_SELECTOR = 'span > div > a[href*="/artist/"]';
const DURATION_COLUMN_SELECTOR = '[role="gridcell"][aria-colindex="5"]';
const BUTTON_CLASS = 'sp-download-btn';

// --- Global State ---
let activePopover = null;

console.log('Spotify Native Downloader: Content script loaded.');

// --- Main Function to Inject Buttons ---
function injectDownloadButtons() {
    // ... (این تابع بدون تغییر باقی می‌ماند)
    const trackRows = document.querySelectorAll(TRACK_ROW_SELECTOR);
    trackRows.forEach(row => {
        if (row.querySelector(`.${BUTTON_CLASS}`)) return;
        const titleEl = row.querySelector(TITLE_SELECTOR);
        const artistEls = row.querySelectorAll(ARTIST_SELECTOR);
        const durationCol = row.querySelector(DURATION_COLUMN_SELECTOR);
        if (!titleEl || artistEls.length === 0 || !durationCol) return;
        const button = createDownloadButton();
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (activePopover && activePopover.trigger === button) return;
            closeActivePopover();
            const trackTitle = titleEl.textContent.trim();
            const trackArtists = Array.from(artistEls).map(el => el.textContent.trim()).join(', ');
            showPopoverForButton(button, trackTitle, trackArtists);
        });
        const moreButton = durationCol.querySelector('[data-testid="more-button"]');
        if (moreButton && moreButton.parentElement) {
            moreButton.parentElement.insertBefore(button, moreButton);
        } else {
            durationCol.appendChild(button);
        }
    });
}

function createDownloadButton() {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
    return button;
}

// --- Popover Management ---
function showPopoverForButton(button, title, artists) {
    const popover = document.createElement('div');
    popover.className = 'sp-popover';
    popover.innerHTML = `<div class="sp-popover-loader">Loading<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
    document.body.appendChild(popover);
    positionPopover(button, popover);
    setTimeout(() => popover.classList.add('is-visible'), 10);
    activePopover = { element: popover, trigger: button };
    fetchAndPopulatePopover(popover, title, artists);
}

function positionPopover(button, popover) {
    const rect = button.getBoundingClientRect();
    popover.style.top = `${window.scrollY + rect.bottom + 8}px`;
    popover.style.left = `${window.scrollX + rect.right}px`;
    popover.style.transform = 'translateX(-100%)';
}

function closeActivePopover() {
    if (activePopover) {
        activePopover.element.remove();
        activePopover = null;
    }
}

async function fetchAndPopulatePopover(popover, title, artists) {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'fetchTrackDetails',
            track: { title, artists }
        });
        if (response.success) {
            populatePopoverContent(popover, response.data, title, artists);
        } else {
            popover.innerHTML = `<div class="sp-popover-content">${response.error}</div>`;
        }
    } catch (error) {
        popover.innerHTML = `<div class="sp-popover-content">Error: ${error.message}</div>`;
    }
}

function populatePopoverContent(popoverElement, data, originalTitle, originalArtists) {
    const coverUrl = data.coverUrl || chrome.runtime.getURL('icons/icon48.png');
    const mp3ButtonHTML = data.qualities.mp3_320 ? `<button class="sp-popover-btn" data-quality="5">MP3 320</button>` : '';
    const flacButtonHTML = data.qualities.flac ? `<button class="sp-popover-btn" data-quality="27">FLAC</button>` : '';

    popoverElement.innerHTML = `
        <button class="sp-popover-close-btn">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <div class="sp-popover-content">
            <img src="${coverUrl}" class="sp-popover-cover">
            <div class="sp-popover-info">
                <div class="sp-popover-title">${data.foundTitle}</div>
                <div class="sp-popover-artist">${data.foundArtists}</div>
                <div class="sp-popover-confidence">${data.confidence}</div>
                <div class="sp-popover-downloads">
                    ${mp3ButtonHTML}
                    ${flacButtonHTML}
                </div>
            </div>
        </div>`;
    
    // Add listener for the new close button
    popoverElement.querySelector('.sp-popover-close-btn').addEventListener('click', closeActivePopover);

    popoverElement.querySelectorAll('.sp-popover-btn').forEach(button => {
        button.addEventListener('click', () => {
            const originalText = button.textContent;
            button.classList.add('is-downloading');
            button.disabled = true;

            const filename = `${originalTitle} - ${originalArtists}`;
            const quality = button.dataset.quality;
            const trackId = data.trackId;
            
            chrome.runtime.sendMessage({
                action: 'directDownload',
                trackId: trackId,
                quality: quality,
                filename: filename
            }, (response) => {
                button.classList.remove('is-downloading');
                if (response && !response.success) {
                    button.textContent = 'Failed!';
                }
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 2000);
            });
        });
    });
}

// --- Global Event Listeners ---
document.addEventListener('click', (event) => {
    if (activePopover && !activePopover.element.contains(event.target) && !activePopover.trigger.contains(event.target)) {
        closeActivePopover();
    }
});

// NEW: Close popover with the Escape key
document.addEventListener('keydown', (event) => {
    if (event.key === "Escape") {
        closeActivePopover();
    }
});

// --- Observer to handle dynamic content ---
const observer = new MutationObserver(() => requestIdleCallback(injectDownloadButtons));
observer.observe(document.body, { childList: true, subtree: true });
requestIdleCallback(injectDownloadButtons);