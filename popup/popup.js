document.addEventListener('DOMContentLoaded', () => {
  const urlsInput = document.getElementById('urls');
  const delayInput = document.getElementById('delay');
  const formatSelect = document.getElementById('format');
  const clickSelectorInput = document.getElementById('clickSelector');
  const startBtn = document.getElementById('startBtn');
  const progressSection = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const logSection = document.getElementById('log');
  const queueSection = document.getElementById('queueSection');
  const queueUrls = document.getElementById('queueUrls');
  const updateQueueBtn = document.getElementById('updateQueueBtn');
  const addUrls = document.getElementById('addUrls');
  const addQueueBtn = document.getElementById('addQueueBtn');

  let isCapturing = false;

  // Sync state with background on popup open
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    if (state.isRunning) {
      setCapturingState();
      updateProgress(state.totalProcessed, state.total);
      updateQueueDisplay(state.remainingQueue);
    }
  });

  // Parse and validate URLs
  function parseUrls(text) {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .filter(line => {
        try {
          const url = new URL(line);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      });
  }

  // Add log entry (using safe DOM methods)
  function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = message; // Safe: textContent escapes HTML
    logSection.appendChild(entry);
    logSection.scrollTop = logSection.scrollHeight;
  }

  // Clear logs (using safe DOM method)
  function clearLogs() {
    while (logSection.firstChild) {
      logSection.removeChild(logSection.firstChild);
    }
  }

  // Update progress
  function updateProgress(current, total) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${current} / ${total}`;
  }

  // Update queue display
  function updateQueueDisplay(remainingQueue) {
    if (remainingQueue && remainingQueue.length > 0) {
      queueUrls.value = remainingQueue.join('\n');
    } else {
      queueUrls.value = '';
    }
  }

  // Switch to capturing UI state
  function setCapturingState() {
    isCapturing = true;
    startBtn.disabled = false;
    startBtn.textContent = 'Stop';
    startBtn.classList.add('stop-mode');
    progressSection.style.display = 'block';
    queueSection.style.display = 'block';
  }

  // Switch to idle UI state
  function setIdleState() {
    isCapturing = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Capture';
    startBtn.classList.remove('stop-mode');
    queueSection.style.display = 'none';
  }

  // Start capture
  startBtn.addEventListener('click', async () => {
    if (isCapturing) {
      // Stop capture
      startBtn.disabled = true;
      startBtn.textContent = 'Stopping...';
      try {
        await chrome.runtime.sendMessage({ action: 'stopCapture' });
        addLog('Stop requested. Waiting for current capture to finish...', 'info');
      } catch (error) {
        addLog(`Stop error: ${error.message}`, 'error');
      }
      // If this popup didn't initiate the capture, transition to idle after stop
      setTimeout(async () => {
        try {
          const state = await chrome.runtime.sendMessage({ action: 'getState' });
          if (state && !state.isRunning) {
            setIdleState();
          }
        } catch (e) { /* ignore */ }
      }, 3000);
      return;
    }

    const urls = parseUrls(urlsInput.value);

    if (urls.length === 0) {
      alert('Please enter at least one valid URL');
      return;
    }

    const options = {
      delay: parseInt(delayInput.value, 10) || 1000,
      format: formatSelect.value,
      clickSelector: clickSelectorInput.value.trim() || null
    };

    setCapturingState();
    clearLogs();
    updateProgress(0, urls.length);
    addUrls.value = '';

    addLog(`Starting capture of ${urls.length} URL(s)...`, 'info');

    try {
      // Send message to background script
      const response = await chrome.runtime.sendMessage({
        action: 'captureScreenshots',
        urls: urls,
        options: options
      });

      if (response.stopped) {
        addLog('Capture stopped.', 'info');
      } else if (response.success) {
        addLog('All captures completed!', 'success');
      } else {
        addLog(`Capture finished: ${response.error}`, 'error');
      }
    } catch (error) {
      addLog(`Error: ${error.message}`, 'error');
    }

    setIdleState();
  });

  // Update queue button
  updateQueueBtn.addEventListener('click', async () => {
    const urls = parseUrls(queueUrls.value);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'updateQueue',
        urls: urls
      });
      if (response.success) {
        addLog(`Queue updated: ${response.queueLength} URL(s) remaining.`, 'info');
        updateProgress(response.total - response.queueLength, response.total);
      } else {
        addLog(`Update failed: ${response.error}`, 'error');
      }
    } catch (error) {
      addLog(`Update error: ${error.message}`, 'error');
    }
  });

  // Add to queue button
  addQueueBtn.addEventListener('click', async () => {
    const urls = parseUrls(addUrls.value);
    if (urls.length === 0) {
      alert('Please enter at least one valid URL to add');
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'addToQueue',
        urls: urls
      });
      if (response.success) {
        addUrls.value = '';
        addLog(`Added ${urls.length} URL(s) to queue. Total remaining: ${response.queueLength}`, 'info');
        updateProgress(response.total - response.queueLength, response.total);
      } else {
        addLog(`Add failed: ${response.error}`, 'error');
      }
    } catch (error) {
      addLog(`Add error: ${error.message}`, 'error');
    }
  });

  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'progressUpdate') {
      updateProgress(message.current, message.total);
      addLog(message.message, message.type || 'info');
      if (message.remainingQueue) {
        updateQueueDisplay(message.remainingQueue);
      }
      // Detect capture stopped or completed
      if (message.message === 'Capture stopped by user.' ||
          (message.current === message.total && message.total > 0 && (!message.remainingQueue || message.remainingQueue.length === 0))) {
        setIdleState();
      }
    }
    return true;
  });
});
