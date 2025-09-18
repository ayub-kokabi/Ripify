const downloadFilenameMap = new Map();

function compareTwoStrings(first, second) {
    first = first.replace(/\s+/g, '');
    second = second.replace(/\s+/g, '');

    if (first === second) return 1;
    if (first.length < 2 || second.length < 2) return 0;

    let firstBigrams = new Map();
    for (let i = 0; i < first.length - 1; i++) {
        const bigram = first.substring(i, i + 2);
        const count = firstBigrams.has(bigram) ? firstBigrams.get(bigram) + 1 : 1;
        firstBigrams.set(bigram, count);
    }

    let intersectionSize = 0;
    for (let i = 0; i < second.length - 1; i++) {
        const bigram = second.substring(i, i + 2);
        const count = firstBigrams.has(bigram) ? firstBigrams.get(bigram) : 0;
        if (count > 0) {
            firstBigrams.set(bigram, count - 1);
            intersectionSize++;
        }
    }

    return (2.0 * intersectionSize) / (first.length + second.length - 2);
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const downloadId = downloadItem.id;
    if (downloadFilenameMap.has(downloadId)) {
        const newFilename = downloadFilenameMap.get(downloadId);
        suggest({ filename: newFilename, conflictAction: 'uniquify' });
        downloadFilenameMap.delete(downloadId);
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchTrackDetails') {
        fetchTrackDetails(request.track).then(sendResponse);
        return true;
    }
    if (request.action === 'directDownload') {
        directDownload(request.trackId, request.quality, request.filename).then(sendResponse);
        return true;
    }
});

async function fetchTrackDetails(trackInfo) {
    const { title, artists } = trackInfo;
    const query = `${title} ${artists}`;
    const searchUrl = `https://us.qqdl.site/api/get-music?q=${encodeURIComponent(query)}&offset=0`;
    
    const searchResponse = await fetch(searchUrl);
    if (!searchResponse.ok) return { success: false, error: 'Search API failed' };

    const searchData = await searchResponse.json();
    const results = (searchData.success && searchData.data.tracks) ? (searchData.data.tracks.items || []) : [];
    if (results.length === 0) return { success: false, error: 'Track not found' };

    const matches = results.map(result => {
        const resultTitle = result.title || "";
        const resultArtists = result.performer?.name || "";
        const titleSimilarity = compareTwoStrings(title.toLowerCase(), resultTitle.toLowerCase());
        const artistSimilarity = compareTwoStrings(artists.toLowerCase(), resultArtists.toLowerCase());
        const combinedScore = (titleSimilarity * 0.4) + (artistSimilarity * 0.6);
        return { score: combinedScore, track: result };
    });

    const bestMatch = matches.reduce((best, current) => current.score > best.score ? current : best, { score: 0 });
    
    if (bestMatch.score < 0.50) {
        return { success: false, error: `No good match found (Best: ${Math.round(bestMatch.score*100)}%)` };
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
}

async function checkAvailableQualities(trackId) {
    const mp3_320_url = await getDownloadUrl(trackId, 5);
    const flac_url = await getDownloadUrl(trackId, 27);
    return { mp3_320: !!mp3_320_url, flac: !!flac_url };
}

async function directDownload(trackId, quality, filename) {
    const downloadUrl = await getDownloadUrl(trackId, quality);
    if (!downloadUrl) {
        return { success: false, error: 'Could not get download link' };
    }
    
    const extension = quality == '27' ? 'flac' : 'mp3';
    const sanitizedFilename = `${filename}.${extension}`.replace(/[\\/*?:"<>|]/g, '_');
    
    const downloadId = await chrome.downloads.download({ url: downloadUrl, conflictAction: 'uniquify' });
    if (downloadId) {
        downloadFilenameMap.set(downloadId, sanitizedFilename);
        return { success: true };
    } else {
        return { success: false, error: 'Download initiation failed' };
    }
}

async function getDownloadUrl(trackId, quality) {
    const url = `https://us.qqdl.site/api/download-music?track_id=${trackId}&quality=${quality}`;
    const response = await fetch(url);
    if (response.ok) {
        const data = await response.json();
        if (data.success && data.data.url) return data.data.url;
    }
    return null;
}