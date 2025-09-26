const downloadFilenameMap = new Map();

let settings = {
    geminiApiKey: null,
};

function loadSettings() {
    chrome.storage.local.get(['geminiApiKey'], (data) => {
            settings.geminiApiKey = data.geminiApiKey || null;
        }
    );
}
loadSettings();

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.geminiApiKey) {
            settings.geminiApiKey = changes.geminiApiKey.newValue;
        }
    }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchTrackDetails') {
        fetchTrackDetails(request.track, request.forceAI).then(sendResponse);
        return true;
    }
    if (request.action === 'directDownload') {
        directDownload(request.trackId, request.quality, request.filename).then(sendResponse);
        return true;
    }
    return true;
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const downloadId = downloadItem.id;
    if (downloadFilenameMap.has(downloadId)) {
        const newFilename = downloadFilenameMap.get(downloadId);
        suggest({ filename: newFilename, conflictAction: 'uniquify' });
        downloadFilenameMap.delete(downloadId);
    }
});

function cleanStringForSearch(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ').replace(/\s*\{.*?\}\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareTwoStrings(first, second) {
    first = first.replace(/\s+/g, '').toLowerCase();
    second = second.replace(/\s+/g, '').toLowerCase();
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

async function fetchTrackDetails(trackInfo, forceAI = false) {
    const { title, artists } = trackInfo;
    
    const cleanedTitleForQuery = cleanStringForSearch(title);
    const cleanedArtistsForQuery = cleanStringForSearch(artists);
    const query = `${cleanedTitleForQuery} ${cleanedArtistsForQuery}`;
    const searchUrl = `https://us.qqdl.site/api/get-music?q=${encodeURIComponent(query)}&offset=0`;

    let searchData;
    try {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) throw new Error(`HTTP ${searchResponse.status}`);
        searchData = await searchResponse.json();
    } catch (e) {
        return { success: false, error: `Search API failed: ${e.message}` };
    }

    let allResults = [];
    if (searchData.success && searchData.data) {
        const tracks = searchData.data.tracks?.items || [];
        const albums = searchData.data.albums?.items || [];
        tracks.forEach(item => allResults.push({ type: 'track', id: item.id, title: item.title, performer: { name: item.performer?.name || "" }, album: item.album, release_date_original: item.release_date_original }));
        albums.forEach(item => allResults.push({ type: 'album', id: item.id, title: item.title, performer: { name: item.artist?.name || "" }, album: item, release_date_original: item.release_date_original }));
    }

    if (allResults.length === 0) {
        return { success: false, reason: 'not_found', error: 'Sorry, no matching track was found.' };
    }

    let bestMatch = null;

    if (forceAI) {
        if (!settings.geminiApiKey) {
            return { success: false, error: "AI search failed: API key not set." };
        }
        const uniqueResults = new Map();
        for (const result of allResults) {
            const key = `${cleanStringForSearch(result.title)}|${cleanStringForSearch(result.performer.name)}`;
            const existing = uniqueResults.get(key);
            if (!existing || (result.release_date_original || "") > (existing.release_date_original || "")) {
                uniqueResults.set(key, result);
            }
        }
        const filteredResultsForAI = Array.from(uniqueResults.values());
        try {
            const geminiResponse = await getGeminiBestMatch(title, artists, filteredResultsForAI);
            const textResponse = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
            if(!textResponse) throw new Error("Invalid response structure from Gemini.");
            const parsedResponse = JSON.parse(textResponse);
            if (parsedResponse.matchFound && parsedResponse.bestMatchId) {
                bestMatch = allResults.find(r => r.id == parsedResponse.bestMatchId);
            }
        } catch (e) {
            return { success: false, error: `AI comparison failed: ${e.message}` };
        }
    } else {
        const cleanedOriginalTitle = cleanStringForSearch(title);
        const cleanedOriginalArtists = cleanStringForSearch(artists);
        const threshold = 0.70;
        let validMatches = [];
        for (const result of allResults) {
            const cleanedResultTitle = cleanStringForSearch(result.title);
            const cleanedResultArtist = cleanStringForSearch(result.performer.name);
            const titleSim = compareTwoStrings(cleanedOriginalTitle, cleanedResultTitle);
            const artistSim = compareTwoStrings(cleanedOriginalArtists, cleanedResultArtist);
            if (titleSim > threshold && artistSim > threshold) {
                const combinedScore = (titleSim * 0.4) + (artistSim * 0.6);
                validMatches.push({ ...result, combinedScore });
            }
        }
        if (validMatches.length > 0) {
            validMatches.sort((a, b) => b.combinedScore - a.combinedScore);
            const topScore = validMatches[0].combinedScore;
            let topMatches = validMatches.filter(match => match.combinedScore === topScore);
            if (topMatches.length > 1) {
                topMatches.sort((a, b) => (b.release_date_original || "").localeCompare(a.release_date_original || ""));
            }
            bestMatch = topMatches[0];
        }
    }

    if (!bestMatch) {
        return { success: false, reason: 'not_found', error: 'Sorry, no suitable match was found.' };
    }
    
    let finalTrackId = null;
    if (bestMatch.type === 'track') {
        finalTrackId = bestMatch.id;
    } else if (bestMatch.type === 'album') {
        try {
            const albumDetailsUrl = `https://us.qqdl.site/api/get-album?album_id=${bestMatch.id}`;
            const albumResponse = await fetch(albumDetailsUrl);
            if (!albumResponse.ok) throw new Error(`HTTP ${albumResponse.status}`);
            const albumData = await albumResponse.json();
            finalTrackId = albumData?.data?.tracks?.items?.[0]?.id;
            if (!finalTrackId) throw new Error("No track ID found in album details.");
        } catch (e) {
            return { success: false, error: 'Could not resolve track from album.', details: e.message };
        }
    }

    if (!finalTrackId) {
        return { success: false, error: 'Failed to determine a valid track ID.' };
    }
    
    const qualities = await checkAvailableQualities(finalTrackId);
    
    return {
        success: true,
        data: {
            trackId: finalTrackId,
            foundTitle: bestMatch.title,
            foundArtists: bestMatch.performer.name,
            coverUrl: bestMatch.album?.image?.small,
            qualities: qualities,
            release_date: bestMatch.release_date_original
        }
    };
}

async function getGeminiBestMatch(originalTitle, originalArtist, availableResults) {
    const GEMINI_MODEL_NAME = 'gemini-2.5-flash';
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${settings.geminiApiKey}`;
    
    const originalTrack = { title: originalTitle, artist: originalArtist };
    const availableTracks = availableResults.map(res => ({
        id: res.id,
        title: res.title,
        artist: res.performer.name,
        release_date: res.release_date_original
    }));

    const prompt = `
Task: Find the best match for an original track from a list of candidates.

Instructions:
1. Analyze the 'originalTrack' object.
2. Compare it against each object in the 'candidateTracks' array.
3. Consider that the 'artist' field in 'originalTrack' might contain multiple artists, while candidates might only list one. A match is valid if at least one artist matches.
4. Your response MUST be a single, valid JSON object and nothing else. Do not use markdown.

JSON Input:
{
  "originalTrack": ${JSON.stringify(originalTrack)},
  "candidateTracks": ${JSON.stringify(availableTracks)}
}

Required JSON Output Schema:
If a confident match is found:
{
  "matchFound": true,
  "bestMatchId": "the_exact_id_from_the_best_matching_candidate"
}
If no confident match is found:
{
  "matchFound": false,
  "bestMatchId": null
}

Now, process the JSON Input and provide your response in the specified JSON Output Schema.
`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
            responseMimeType: "application/json", 
            temperature: 0.0 
        }
    };
    
    const response = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
        const errorDetail = await response.text();
        throw new Error(`Gemini API failed: HTTP ${response.status} - ${errorDetail}`);
    }
    return response.json();
}

async function checkAvailableQualities(trackId) {
    const mp3_url = await getDownloadUrl(trackId, 5);
    const flac_url = await getDownloadUrl(trackId, 27);
    return { mp3_320: !!mp3_url, flac: !!flac_url };
}

async function directDownload(trackId, quality, filename) {
    const downloadUrl = await getDownloadUrl(trackId, quality);
    if (!downloadUrl) return { success: false, error: 'Could not get download link' };
    
    const extension = quality == '27' ? 'flac' : 'mp3';
    const sanitizedFilename = `${filename}.${extension}`.replace(/[\\/*?:"<>|]/g, '_');
    
    try {
        const downloadId = await chrome.downloads.download({ url: downloadUrl, conflictAction: 'uniquify' });
        if (downloadId) {
            downloadFilenameMap.set(downloadId, sanitizedFilename);
            return { success: true };
        }
    } catch(e) {
        return { success: false, error: `Download failed: ${e.message}` };
    }
    return { success: false, error: 'Download initiation failed' };
}

async function getDownloadUrl(trackId, quality) {
    const url = `https://us.qqdl.site/api/download-music?track_id=${trackId}&quality=${quality}`;
    try {
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.data?.url) return data.data.url;
        }
    } catch (e) {
    }
    return null;
}