const PLAYLIST_TRACK_ROW_SELECTOR = '[data-testid="tracklist-row"]';
const SINGLE_TRACK_ACTION_BAR_SELECTOR = '[data-testid="action-bar-row"]';
const BUTTON_CLASS = 'sp-download-btn';

let activePopover = null;

const handleScroll = () => {
    if (activePopover) {
        positionPopover(activePopover.trigger, activePopover.element);
    }
};

function injectButtons() {
    injectIntoPlaylist();
    injectIntoSingleTrackPage();
}

function injectIntoPlaylist() {
    const trackRows = document.querySelectorAll(PLAYLIST_TRACK_ROW_SELECTOR);
    trackRows.forEach(row => {
        if (row.querySelector(`.${BUTTON_CLASS}`)) return;
        const titleEl = row.querySelector('a[data-testid="internal-track-link"] > div');
        const artistEls = row.querySelectorAll('span > div > a[href*="/artist/"]');
        const durationCol = row.querySelector('[role="gridcell"][aria-colindex="5"]');
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
        if (moreButton?.parentElement) {
            moreButton.parentElement.insertBefore(button, moreButton);
        }
    });
}

function injectIntoSingleTrackPage() {
    const actionBar = document.querySelector(SINGLE_TRACK_ACTION_BAR_SELECTOR);
    if (!actionBar || actionBar.querySelector(`.${BUTTON_CLASS}`) || !window.location.pathname.includes('/track/')) return;
    const titleEl = document.querySelector('[data-testid="entityTitle"] > h1');
    const artistEl = document.querySelector('[data-testid="creator-link"]');
    if (!titleEl || !artistEl) return;
    const trackTitle = titleEl.textContent.trim();
    const trackArtists = artistEl.textContent.trim();
    const button = createDownloadButton(true);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (activePopover && activePopover.trigger === button) return;
        closeActivePopover();
        showPopoverForButton(button, trackTitle, trackArtists);
    });
    const saveButton = actionBar.querySelector('[data-testid="add-button"]');
    if (saveButton?.parentElement) {
        saveButton.parentElement.insertBefore(button, saveButton.nextSibling);
    }
}

function createDownloadButton(isLarge = false) {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    if (isLarge) button.classList.add('ripify-download-button');
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64"><path fill="currentColor" fill-rule="evenodd" d="M8 10a4 4 0 1 1 8 0v1h1a3.5 3.5 0 1 1 0 7h-.1a1 1 0 1 0 0 2h.1a5.5 5.5 0 0 0 .93-10.92 6 6 0 0 0-11.86 0A5.5 5.5 0 0 0 7 20h.1a1 1 0 1 0 0-2H7a3.5 3.5 0 1 1 0-7h1v-1Zm5 1a1 1 0 1 0-2 0v5.59l-1.3-1.3a1 1 0 0 0-1.4 1.42l3 3a1 1 0 0 0 1.4 0l3-3a1 1 0 0 0-1.4-1.42L13 16.6V11Z" clip-rule="evenodd"/></svg>`;
    return button;
}

function showPopoverForButton(button, title, artists) {
    closeActivePopover();
    const popover = document.createElement('div');
    popover.className = 'sp-popover';
    popover.innerHTML = `
        <button class="sp-popover-close-btn">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <div class="sp-popover-body">
            <div class="sp-popover-loader">Loading<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
        </div>
    `;
    popover.querySelector('.sp-popover-close-btn').addEventListener('click', closeActivePopover);
    
    document.body.appendChild(popover);
    positionPopover(button, popover);
    setTimeout(() => popover.classList.add('is-visible'), 10);
    activePopover = { element: popover, trigger: button };
    
    document.addEventListener('scroll', handleScroll, true);
    fetchAndPopulatePopover(popover, title, artists, false);
}

function positionPopover(button, popover) {
    const rect = button.getBoundingClientRect();
    const popoverWidth = 320;
    let left = window.scrollX + rect.right;
    let transform = 'translateX(-100%)';
    if (left - popoverWidth < window.scrollX) {
        left = window.scrollX + rect.left;
        transform = 'translateX(0)';
    }
    popover.style.top = `${window.scrollY + rect.bottom + 8}px`;
    popover.style.left = `${left}px`;
    popover.style.transform = transform;
}

function closeActivePopover() {
    if (activePopover) {
        activePopover.element.remove();
        activePopover = null;
        document.removeEventListener('scroll', handleScroll, true);
    }
}

async function fetchAndPopulatePopover(popover, title, artists, forceAI) {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'fetchTrackDetails', track: { title, artists }, forceAI });
        if (response.success) {
            populatePopoverContent(popover, response.data, title, artists, forceAI);
        } else {
            if (response.reason === 'not_found') {
                showNotFoundInPopover(popover, response.error, title, artists, forceAI);
            } else {
                showErrorInPopover(popover, response.error, response.details);
            }
        }
    } catch (error) {
        showErrorInPopover(popover, 'An unexpected error occurred.', error.message);
    }
}

function showNotFoundInPopover(popover, message, originalTitle, originalArtists, wasForcedAI) {
    const body = popover.querySelector('.sp-popover-body');
    if (!body) return;
    
    let content = `<div style="text-align: center; color: #b3b3b3;"><p>${message}</p>`;
    if (!wasForcedAI) {
        content += `<button class="sp-popover-retry-ai-btn" style="width: 100%; text-align: center; margin-top: 16px; border: 1px solid #535353; border-radius: 4px; padding: 6px;">Try searching with AI</button>`;
    }
    content += `</div>`;
    body.innerHTML = content;
    
    const retryBtn = body.querySelector('.sp-popover-retry-ai-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            body.innerHTML = `<div class="sp-popover-loader">Asking AI<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
            fetchAndPopulatePopover(popover, originalTitle, originalArtists, true);
        });
    }
}

function showErrorInPopover(popover, error, details = '') {
    const body = popover.querySelector('.sp-popover-body');
    if (!body) return;
    body.innerHTML = `<div>
        <p style="margin-bottom: 8px; color: #ff4d4f; font-weight: bold;">Error: ${error}</p>
        ${details ? `<p style="font-size: 0.8em; color: #b3b3b3; overflow-wrap: break-word;">${details}</p>` : ''}
    </div>`;
    setupAutoCloseTimer(popover);
}

function setupAutoCloseTimer(popover) {
    let timerId = null;
    popover.addEventListener('mouseleave', () => {
        timerId = setTimeout(() => {
            closeActivePopover();
        }, 3000);
    });
    popover.addEventListener('mouseenter', () => {
        if (timerId) {
            clearTimeout(timerId);
        }
    });
}

function populatePopoverContent(popoverElement, data, originalTitle, originalArtists, wasForcedAI) {
    const body = popoverElement.querySelector('.sp-popover-body');
    if (!body) return;

    const coverUrl = data.coverUrl || chrome.runtime.getURL('icons/icon48.png');
    const mp3ButtonHTML = data.qualities.mp3_320 ? `<button class="sp-popover-btn" data-quality="5">MP3 320</button>` : '';
    const flacButtonHTML = data.qualities.flac ? `<button class="sp-popover-btn" data-quality="27">FLAC</button>` : '';
    const retryButtonHTML = !wasForcedAI ? `<button class="sp-popover-retry-ai-btn">Wrong? Try with AI</button>` : '';

    body.innerHTML = `
        <div class="sp-popover-content">
            <img src="${coverUrl}" class="sp-popover-cover" alt="Album Cover">
            <div class="sp-popover-info">
                <div class="sp-popover-title" title="${data.foundTitle}">${data.foundTitle}</div>
                <div class="sp-popover-artist" title="${data.foundArtists}">${data.foundArtists}</div>
                <div class="sp-popover-downloads">
                    ${mp3ButtonHTML}
                    ${flacButtonHTML}
                </div>
                ${retryButtonHTML}
            </div>
        </div>`;

    body.querySelectorAll('.sp-popover-btn').forEach(button => {
        button.addEventListener('click', () => {
            button.classList.add('is-downloading');
            button.disabled = true;
            const originalText = button.textContent;
            const filename = `${originalTitle} - ${originalArtists}`;
            const quality = button.dataset.quality;
            const trackId = data.trackId;

            chrome.runtime.sendMessage({ action: 'directDownload', trackId, quality, filename }, 
            (response) => {
                button.classList.remove('is-downloading');
                if (!response?.success) button.textContent = 'Failed!';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 2000);
            });
        });
    });

    const retryBtn = body.querySelector('.sp-popover-retry-ai-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            body.innerHTML = `<div class="sp-popover-loader">Asking AI...<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
            fetchAndPopulatePopover(popoverElement, originalTitle, originalArtists, true);
        });
    }
}

document.addEventListener('click', (event) => {
    if (activePopover && !activePopover.element.contains(event.target) && !activePopover.trigger.contains(event.target)) {
        closeActivePopover();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === "Escape") closeActivePopover();
});

const observer = new MutationObserver(() => requestIdleCallback(injectButtons));
observer.observe(document.body, { childList: true, subtree: true });
requestIdleCallback(injectButtons);