document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('gemini-api-input');
    const statusMessage = document.getElementById('status-message');

    let debounceTimer;

    const showStatus = (message, type = 'info') => {
        statusMessage.textContent = message;
        statusMessage.className = '';
        
        if (type === 'success') {
            statusMessage.classList.add('status-success');
        } else if (type === 'error') {
            statusMessage.classList.add('status-error');
        }

        if (type !== 'error') {
            setTimeout(() => {
                if (statusMessage.textContent === message) {
                    statusMessage.textContent = '';
                }
            }, 4000);
        }
    };

    const handleApiKeyInput = async (key) => {
        chrome.storage.local.set({ geminiApiKey: key });

        if (!key) {
            showStatus('');
            return;
        }

        showStatus('API Key saved. Validating connection...');

        const validationUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
        try {
            const response = await fetch(validationUrl);
            if (response.ok) {
                showStatus('Valid Key', 'success');
            } else if (response.status === 403) {
                showStatus('Invalid key, or you may need to try with a VPN', 'error');
            } else {
                showStatus(`Validation failed. Status: ${response.status}`, 'error');
            }
        } catch (error) {
            showStatus('Connection failed. Please check your network and try again.', 'error');
        }
    };

    const loadSettings = async () => {
        const settings = await chrome.storage.local.get({
            geminiApiKey: '',
        });
        apiKeyInput.value = settings.geminiApiKey;
    };

    apiKeyInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const key = apiKeyInput.value.trim();
            handleApiKeyInput(key);
        }, 800);
    });

    loadSettings();
});