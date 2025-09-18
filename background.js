// Import the string-similarity library
importScripts('lib/string-similarity.min.js');

console.log('[BG] Service Worker for Smart Downloader started.');

// A temporary map to store desired filenames against their download IDs.
const downloadFilenameMap = new Map();

// --- Event Listener to Intercept and Rename Downloads ---
// This is the core of the filename fix.
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const downloadId = downloadItem.id;

    // Check if we have a custom filename for this download
    if (downloadFilenameMap.has(downloadId)) {
        const newFilename = downloadFilenameMap.get(downloadId);
        console.log(`[BG] Intercepted download ID ${downloadId}. Overriding filename to: "${newFilename}"`);
        
        suggest({
            filename: newFilename,
            conflictAction: 'uniquify'
        });

        // Clean up the map to prevent memory leaks
        downloadFilenameMap.delete(downloadId);
    }
    // Asynchronous suggestion is supported, but we don't need it here.
    // If the ID is not in our map, the browser handles it normally.
});


// --- Message Listener from Content Script ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[BG] Received message:', request);

    if (request.action === 'fetchTrackDetails') {
        fetchTrackDetails(request.track)
            .then(sendResponse);
        return true; // Indicates an asynchronous response.
    }
    
    if (request.action === 'directDownload') {
        directDownload(request.trackId, request.quality, request.filename)
            .then(sendResponse); // Send confirmation back to content script
        return true; // Indicates an asynchronous response.
    }
});


async function fetchTrackDetails(trackInfo) {
    const { title, artists } = trackInfo;
    const query = `${title} ${artists}`;
    const searchUrl = `https://us.qqdl.site/api/get-music?q=${encodeURIComponent(query)}&offset=0`;

    try {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) throw new Error('Search API failed');
        
        const searchData = await searchResponse.json();
        const results = searchData.success ? (searchData.data.tracks.items || []) : [];
        if (results.length === 0) throw new Error("Track not found");

        const matches = results.map(result => {
            const resultTitle = result.title || "";
            const resultArtists = result.performer?.name || "";
            const titleSimilarity = stringSimilarity.compareTwoStrings(title.toLowerCase(), resultTitle.toLowerCase());
            const artistSimilarity = stringSimilarity.compareTwoStrings(artists.toLowerCase(), resultArtists.toLowerCase());
            const combinedScore = (titleSimilarity * 0.4) + (artistSimilarity * 0.6);
            return { score: combinedScore, track: result };
        });

        const bestMatch = matches.reduce((best, current) => current.score > best.score ? current : best);
        
        if (bestMatch.score < 0.50) {
             throw new Error(`No good match found (Best: ${Math.round(bestMatch.score*100)}%)`);
        }

        const bestResult = bestMatch.track;
        const qualities = await checkAvailableQualities(bestResult.id);

        return {
            success: true,
            data: {
                trackId: bestResult.id,
                foundTitle: bestResult.title,
                foundArtists: bestResult.performer?.name,
                coverUrl: bestResult.album?.image?.small,
                confidence: `Match: ${Math.round(bestMatch.score * 100)}%`,
                qualities: qualities
            }
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function checkAvailableQualities(trackId) {
    const mp3_320_url = await getDownloadUrl(trackId, 5);
    const flac_url = await getDownloadUrl(trackId, 27);
    return { mp3_320: !!mp3_320_url, flac: !!flac_url };
}

async function directDownload(trackId, quality, filename) {
    try {
        const downloadUrl = await getDownloadUrl(trackId, quality);
        if (!downloadUrl) {
            throw new Error("Could not get download link from API.");
        }
        
        const extension = quality == '27' ? 'flac' : 'mp3';
        const sanitizedFilename = `${filename}.${extension}`.replace(/[\\/*?:"<>|]/g, '_');
        
        // Start the download WITHOUT the filename parameter.
        // Await the call to get the downloadId.
        const downloadId = await chrome.downloads.download({
            url: downloadUrl,
            conflictAction: 'uniquify'
        });

        if (downloadId) {
            console.log(`[BG] Download initiated with ID ${downloadId}. Storing filename "${sanitizedFilename}" for override.`);
            // Store the desired filename in our map, ready for the onDeterminingFilename event.
            downloadFilenameMap.set(downloadId, sanitizedFilename);
            return { success: true };
        } else {
            // This can happen if the download is blocked or fails immediately.
            throw new Error('Browser blocked the download initiation.');
        }

    } catch (error) {
        console.error('[BG] CRITICAL ERROR in directDownload:', error);
        return { success: false, error: error.message };
    }
}

async function getDownloadUrl(trackId, quality) {
    const url = `https://us.qqdl.site/api/download-music?track_id=${trackId}&quality=${quality}`;
    try {
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.data.url) return data.data.url;
        }
    } catch (e) {
        console.error(`Failed to get download URL for quality ${quality}:`, e);
    }
    return null;
}