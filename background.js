const LOG_PREFIX = '[Ripify Debug]';

console.log(LOG_PREFIX, 'Service Worker started.');

const downloadFilenameMap = new Map();

let settings = {
    geminiApiKey: null,
};

function loadSettings() {
    chrome.storage.local.get(['geminiApiKey'], (data) => {
            settings.geminiApiKey = data.geminiApiKey || null;
            console.log(LOG_PREFIX, 'Settings loaded. AI Key is', settings.geminiApiKey ? 'SET' : 'NOT SET');
        }
    );
}
loadSettings();

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.geminiApiKey) {
            settings.geminiApiKey = changes.geminiApiKey.newValue;
            console.log(LOG_PREFIX, 'Gemini API Key setting changed.');
        }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log(LOG_PREFIX, `Message received with action: ${request.action}`);
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
        console.log(LOG_PREFIX, `Setting filename for download ID ${downloadId} to: "${newFilename}"`);
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

async function findBestMatchWithAI(originalTitle, originalArtist, allResults) {
    console.log(LOG_PREFIX, 'Executing AI-powered matching.');
    if (!settings.geminiApiKey) {
        const errorMsg = "AI search failed: API key not set.";
        console.error(LOG_PREFIX, errorMsg);
        return { success: false, error: errorMsg };
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
        const geminiResponse = await getGeminiBestMatch(originalTitle, originalArtist, filteredResultsForAI);
        console.log(LOG_PREFIX, 'Gemini API response:', geminiResponse);
        const textResponse = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) throw new Error("Invalid response structure from Gemini.");
        const parsedResponse = JSON.parse(textResponse);
        console.log(LOG_PREFIX, 'Parsed Gemini response:', parsedResponse);
        
        let bestMatch = null;
        if (parsedResponse.matchFound && parsedResponse.bestMatchId) {
            bestMatch = allResults.find(r => r.id == parsedResponse.bestMatchId);
        }
        return { success: true, match: bestMatch, wasAI: true };
    } catch (e) {
        console.error(LOG_PREFIX, 'AI comparison failed:', e.message);
        return { success: false, error: `AI comparison failed: ${e.message}` };
    }
}

async function fetchTrackDetails(trackInfo, forceAI = false) {
    console.groupCollapsed(LOG_PREFIX, `Starting fetchTrackDetails for "${trackInfo.title}"`);
    console.log('Original track info:', trackInfo);
    console.log('Force AI:', forceAI);
    
    const { title, artists } = trackInfo;
    
    const cleanedTitleForQuery = cleanStringForSearch(title);
    const cleanedArtistsForQuery = cleanStringForSearch(artists);
    const query = `${cleanedTitleForQuery} ${cleanedArtistsForQuery}`;
    
    const searchUrl = `https://maus.qqdl.site/search/?s=${encodeURIComponent(query)}`;
    console.log('Constructed search query:', query);
    console.log('Fetching search URL:', searchUrl);

    let searchData;
    try {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) throw new Error(`HTTP ${searchResponse.status}`);
        searchData = await searchResponse.json();
        console.log('Raw search API response:', searchData);
    } catch (e) {
        console.error(LOG_PREFIX, 'Search API failed:', e.message);
        console.groupEnd();
        return { success: false, error: `Search API failed: ${e.message}` };
    }

    let allResults = [];
    if (searchData && searchData.items) {
        allResults = searchData.items.map(item => ({
            type: 'track', id: item.id, title: item.title,
            performer: { name: item.artists.map(a => a.name).join(', ') },
            album: {
                id: item.album.id, title: item.album.title,
                image: { small: `https://resources.tidal.com/images/${item.album.cover.replace(/-/g, '/')}/320x320.jpg` }
            },
            release_date_original: item.streamStartDate, popularity: item.popularity 
        }));
    }
    console.log(`Processed ${allResults.length} results from API.`);

    if (allResults.length === 0) {
        console.warn(LOG_PREFIX, 'No results found from API.');
        console.groupEnd();
        return { success: false, reason: 'not_found', error: 'Sorry, no matching track was found.' };
    }

    let bestMatch = null;
    let usedAI = false;

    if (forceAI) {
        const aiResult = await findBestMatchWithAI(title, artists, allResults);
        if (aiResult.success) {
            bestMatch = aiResult.match;
            usedAI = aiResult.wasAI;
        } else {
            console.groupEnd();
            return aiResult;
        }
    } else {
        console.log('Using standard matching logic first.');
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
        console.log(`Found ${validMatches.length} valid matches above threshold (${threshold}).`);

        if (validMatches.length > 0) {
            validMatches.sort((a, b) => b.combinedScore - a.combinedScore);
            const topScore = validMatches[0].combinedScore;
            let topMatches = validMatches.filter(match => match.combinedScore === topScore);
            console.log(`Found ${topMatches.length} top matches with score ${topScore.toFixed(2)}.`);

            if (topMatches.length > 1) {
                console.groupCollapsed('Applying tie-breaking logic...');
                topMatches.forEach(match => {
                    match.albumTitleSim = compareTwoStrings(cleanStringForSearch(match.title), cleanStringForSearch(match.album.title));
                });
                console.log('Calculated scores for tie-breaking:');
                console.table(topMatches.map(m => ({ title: m.title, album: m.album.title, albumTitleSim: m.albumTitleSim.toFixed(2), popularity: m.popularity })));
                topMatches.sort((a, b) => {
                    const albumSimDiff = b.albumTitleSim - a.albumTitleSim;
                    if (albumSimDiff !== 0) return albumSimDiff;
                    const popularityDiff = b.popularity - a.popularity;
                    if (popularityDiff !== 0) return popularityDiff;
                    return (b.release_date_original || "").localeCompare(a.release_date_original || "");
                });
                console.log('Matches after sorting for tie-break:', topMatches);
                console.groupEnd();
            }
            bestMatch = topMatches[0];
        }

        if (!bestMatch && settings.geminiApiKey) {
            console.log(LOG_PREFIX, 'Standard search found no match. Automatically trying with AI...');
            const aiResult = await findBestMatchWithAI(title, artists, allResults);
            if (aiResult.success) {
                bestMatch = aiResult.match;
                usedAI = aiResult.wasAI;
            }
        }
    }

    if (!bestMatch) {
        console.warn(LOG_PREFIX, 'No suitable match found after all attempts.');
        console.groupEnd();
        return { success: false, reason: 'not_found', error: 'Sorry, no suitable match was found.' };
    }
    
    console.log('Best match found:', bestMatch);
    console.log('Was AI used?', usedAI);
    const finalTrackId = bestMatch.id;
    
    if (!finalTrackId) {
        console.error(LOG_PREFIX, 'Best match object is missing a track ID.');
        console.groupEnd();
        return { success: false, error: 'Failed to determine a valid track ID.' };
    }
    
    console.log(`Checking available qualities for track ID: ${finalTrackId}`);
    const qualities = await checkAvailableQualities(finalTrackId);
    
    const finalData = {
        success: true,
        data: {
            trackId: finalTrackId,
            foundTitle: bestMatch.title,
            foundArtists: bestMatch.performer.name,
            coverUrl: bestMatch.album?.image?.small,
            qualities: qualities,
            release_date: bestMatch.release_date_original,
            usedAI: usedAI 
        }
    };

    console.log('Successfully found track details. Sending to content script:', finalData);
    console.groupEnd();
    return finalData;
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
    const prompt = `Task: Find the best match for an original track from a list of candidates. Instructions: 1. Analyze the 'originalTrack' object. 2. Compare it against each object in the 'candidateTracks' array. 3. Consider that the 'artist' field in 'originalTrack' might contain multiple artists, while candidates might only list one. A match is valid if at least one artist matches. 4. Your response MUST be a single, valid JSON object and nothing else. Do not use markdown. JSON Input: { "originalTrack": ${JSON.stringify(originalTrack)}, "candidateTracks": ${JSON.stringify(availableTracks)} } Required JSON Output Schema: If a confident match is found: { "matchFound": true, "bestMatchId": "the_exact_id_from_the_best_matching_candidate" } If no confident match is found: { "matchFound": false, "bestMatchId": null } Now, process the JSON Input and provide your response in the specified JSON Output Schema.`;
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.0 }
    };
    
    const response = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
        const errorDetail = await response.text();
        throw new Error(`Gemini API failed: HTTP ${response.status} - ${errorDetail}`);
    }
    return response.json();
}

async function checkAvailableQualities(trackId) {
    const mp3_url = await getDownloadUrl(trackId, 'HIGH');
    const flac_url = await getDownloadUrl(trackId, 'LOSSLESS');
    const qualities = { mp3_320: !!mp3_url, flac: !!flac_url };
    console.log(LOG_PREFIX, 'Available qualities:', qualities);
    return qualities;
}

async function directDownload(trackId, quality, filename) {
    console.groupCollapsed(LOG_PREFIX, `Starting directDownload for "${filename}"`);
    console.log(`Track ID: ${trackId}, Quality Code: ${quality}`);
    
    const qualityString = quality == '27' ? 'LOSSLESS' : 'HIGH';
    console.log(`Requesting download URL with quality: ${qualityString}`);
    const downloadUrl = await getDownloadUrl(trackId, qualityString);

    if (!downloadUrl) {
        console.error(LOG_PREFIX, 'Could not get download link.');
        console.groupEnd();
        return { success: false, error: 'Could not get download link' };
    }
    console.log('Received download URL:', downloadUrl);
    
    const extension = quality == '27' ? 'flac' : 'mp3';
    const sanitizedFilename = `${filename}.${extension}`.replace(/[\\/*?:"<>|]/g, '_');
    console.log('Sanitized filename:', sanitizedFilename);
    
    try {
        const downloadId = await chrome.downloads.download({ url: downloadUrl, conflictAction: 'uniquify' });
        if (downloadId) {
            downloadFilenameMap.set(downloadId, sanitizedFilename);
            console.log(LOG_PREFIX, `Download initiated successfully with ID: ${downloadId}`);
            console.groupEnd();
            return { success: true };
        }
    } catch(e) {
        console.error(LOG_PREFIX, 'Download failed:', e.message);
        console.groupEnd();
        return { success: false, error: `Download failed: ${e.message}` };
    }

    console.error(LOG_PREFIX, 'Download initiation failed for unknown reason.');
    console.groupEnd();
    return { success: false, error: 'Download initiation failed' };
}

async function getDownloadUrl(trackId, quality) {
    const url = `https://hund.qqdl.site/track/?id=${trackId}&quality=${quality}`;
    console.log(LOG_PREFIX, `Fetching download link from: ${url}`);
    try {
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            console.log(LOG_PREFIX, `Download API raw response for ${quality}:`, data);
            if (Array.isArray(data) && data.length > 2 && data[2].OriginalTrackUrl) {
                console.log(LOG_PREFIX, `Extracted URL for ${quality}: ${data[2].OriginalTrackUrl}`);
                return data[2].OriginalTrackUrl;
            } else {
                console.warn(LOG_PREFIX, `OriginalTrackUrl not found in response for ${quality}.`);
            }
        } else {
             console.warn(LOG_PREFIX, `Download API returned HTTP status ${response.status} for ${quality}.`);
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'Error getting download URL:', e.message);
    }
    return null;
}